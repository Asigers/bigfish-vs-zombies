import {
  ACTION,
  ISSUE,
  STATUS,
  actionKey,
  compareSnapshots,
  normalizeSnapshot,
  validateAction,
  viewForModel
} from "../domain/contract.mjs"
import {ContractError, ProtocolError, TransportError} from "../domain/errors.mjs"
import {candidates, threatRows} from "../domain/policy.mjs"
import {OUTCOME} from "./executor.mjs"
import {systemClock, withTimeout} from "./tick-loop.mjs"

export const DEFAULT_CONFIG = Object.freeze({
  targetLevels: 10,
  /** A safety-only intervention threshold; ordinary strategy belongs to the AI. */
  emergencyX: 2.4,
  maxCommandsPerLevel: 400,
  minActionIntervalMs: 250,
  sunUrgentMs: 5000,
  readRetries: 3,
  readBackoffMs: 120,
  agentTimeoutMs: 6000,
  agentRetryMs: 1800,
  maxPlanActions: 5,
  maxPlanAgeMs: 20000,
  planThreatShift: 2.5,
  narrationMinIntervalMs: 4500,
  challenge: {}
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function threatProfile(snapshot) {
  const rows = new Map()
  for (const zombie of snapshot.zombies) {
    const current = rows.get(zombie.row) ?? {row: zombie.row, count: 0, closestX: zombie.x}
    current.count += 1
    current.closestX = Math.min(current.closestX, zombie.x)
    rows.set(zombie.row, current)
  }
  return [...rows.values()].sort((a, b) => a.row - b.row)
}

/**
 * One bounded control cycle. The LLM owns strategy and proposes actions;
 * this class owns lifecycle, automatic housekeeping, validation and feedback.
 */
export class Orchestrator {
  constructor({
    game,
    agent,
    executor,
    journal = null,
    clock = systemClock,
    config = {},
    logger = console,
    audience = null,
    onEvent = null
  }) {
    this.game = game
    this.agent = agent
    this.executor = executor
    this.journal = journal
    this.clock = clock
    this.config = {...DEFAULT_CONFIG, ...config}
    this.logger = logger
    this.audience = audience
    this.onEvent = onEvent

    this.snapshot = null
    this.previous = null
    this.finished = null
    this.failure = null
    this.startedAt = this.clock.now()
    this.levelStartedAt = this.startedAt
    this.lastActionAt = 0
    this.lastSpeechAt = 0
    this.lastSpeech = ""
    this.levels = []

    this.plan = []
    this.planMeta = null
    this.planSpeech = ""
    this.strategy = null
    this.pendingPlanAction = null
    this.pendingSpeech = ""
    this.lastAction = null
    this.lastPlanError = null
    this.nextAgentAttemptAt = 0

    /** Actions rejected at the current revision are never resent. */
    this.rejections = {revision: -1, keys: new Set()}
    this.stats = {
      cycles: 0,
      verified: 0,
      rejected: 0,
      ambiguous: 0,
      acknowledged: 0,
      abandoned: 0,
      agentDecisions: 0,
      agentPlans: 0,
      plannedActions: 0,
      agentTimeouts: 0,
      agentFailures: 0,
      invalidDecisions: 0,
      readFailures: 0,
      sunsCollected: 0,
      levelCommands: 0,
      speechFailures: 0
    }
  }

  get done() {
    return Boolean(this.finished || this.failure)
  }

  #emit(type, payload = {}) {
    const event = {kind: "event", type, ts: this.clock.now(), level: this.snapshot?.level, ...payload}
    this.journal?.append(event)
    this.onEvent?.(event)
    return event
  }

  #clearPlan(reason, {clearStrategy = false} = {}) {
    if (this.plan.length) this.#emit("plan_cleared", {reason, remaining: this.plan.length})
    this.plan = []
    this.planMeta = null
    this.planSpeech = ""
    if (clearStrategy) this.strategy = null
  }

  #challenge() {
    const fromConfig = this.config.challenge ?? {}
    const fromAudience = this.audience?.challenge?.() ?? {}
    return {
      bannedPlants: [...new Set([
        ...(fromConfig.bannedPlants ?? []),
        ...(fromAudience.bannedPlants ?? [])
      ])]
    }
  }

  async #read() {
    let lastError
    for (let attempt = 0; attempt <= this.config.readRetries; attempt += 1) {
      try {
        const raw = await this.game.snapshot()
        return normalizeSnapshot(raw)
      } catch (error) {
        lastError = error
        if (!(error instanceof TransportError || error instanceof ProtocolError || error instanceof ContractError)) throw error
        this.stats.readFailures += 1
        if (attempt < this.config.readRetries) {
          await sleep(this.config.readBackoffMs * (attempt + 1))
        }
      }
    }
    throw lastError
  }

  #ingest(snapshot) {
    const relation = compareSnapshots(this.previous, snapshot)
    if (relation === "level_changed") {
      this.#recordLevel(this.previous)
      this.stats.levelCommands = 0
      this.levelStartedAt = this.clock.now()
      this.#clearPlan("level_changed", {clearStrategy: true})
    }
    if (relation === "engine_changed") {
      this.stats.levelCommands = 0
      this.levelStartedAt = this.clock.now()
      this.#clearPlan("engine_changed", {clearStrategy: true})
      this.#emit("engine_changed", {gameId: snapshot.gameId})
    }
    if (snapshot.status !== STATUS.PLAYING && relation === "status_changed") {
      this.#clearPlan("status_changed")
    }
    if (["level_changed", "status_changed", "engine_changed"].includes(relation)) {
      this.#emit("snapshot", {revision: snapshot.revision, relation})
    }
    if (this.rejections.revision !== snapshot.revision) {
      this.rejections = {revision: snapshot.revision, keys: new Set()}
    }
    this.previous = snapshot
    this.snapshot = snapshot
  }

  #recordLevel(snapshot) {
    if (!snapshot) return
    const cleared = snapshot.status === STATUS.WON
    this.levels.push({
      level: snapshot.level,
      cleared,
      startedAt: this.levelStartedAt,
      endedAt: this.clock.now(),
      durationMs: this.clock.now() - this.levelStartedAt,
      commands: this.stats.levelCommands
    })
    this.#emit("level_summary", {...this.levels.at(-1)})
  }

  #pickSun(snapshot, {urgent = false} = {}) {
    let suns = [...snapshot.suns].sort((a, b) =>
      (a.expiresInMs ?? Number.POSITIVE_INFINITY) -
      (b.expiresInMs ?? Number.POSITIVE_INFINITY))
    if (urgent) {
      suns = suns.filter((sun) =>
        sun.expiresInMs !== undefined && sun.expiresInMs <= this.config.sunUrgentMs)
    }
    for (const sun of suns.slice(0, 3)) {
      const action = {
        type: ACTION.COLLECT_SUN,
        id: sun.id,
        gameId: snapshot.gameId,
        revision: snapshot.revision
      }
      if (!validateAction(snapshot, action)) return action
    }
    return null
  }

  #filterRejected(actions) {
    if (!this.rejections.keys.size) return actions
    return actions.filter((action) => !this.rejections.keys.has(actionKey(action)))
  }

  /** Last-resort safety intervention only; it is not the normal strategy path. */
  #emergencyAction(snapshot) {
    const threatened = threatRows(snapshot).filter((threat) =>
      threat.closestX < this.config.emergencyX && threat.closestX >= 1.5)
    if (!threatened.length) return null

    const offered = this.#filterRejected(candidates(snapshot, this.#challenge()))
      .filter((action) => action.type === ACTION.PLANT)
    const shooters = (row) => snapshot.plants.filter((plant) =>
      plant.row === row && (plant.type === "peashooter" || plant.type === "snowpea"))

    for (const threat of threatened) {
      if (shooters(threat.row).length) continue
      for (const plant of ["peashooter", "snowpea"]) {
        const action = offered.find((candidate) =>
          candidate.plant === plant && candidate.row === threat.row)
        if (action) return action
      }
    }
    for (const threat of threatened) {
      if (!shooters(threat.row).length) continue
      if (snapshot.plants.some((plant) =>
        plant.row === threat.row && plant.type === "wallnut")) continue
      const wall = offered.find((candidate) =>
        candidate.plant === "wallnut" && candidate.row === threat.row)
      if (wall) return wall
    }
    return null
  }

  #planIsStale(snapshot) {
    if (!this.plan.length || !this.planMeta) return true
    const meta = this.planMeta
    if (snapshot.gameId !== meta.gameId ||
        snapshot.level !== meta.level ||
        snapshot.wave !== meta.wave) return true
    if ((this.audience?.version ?? 0) !== meta.audienceVersion) return true
    if (this.clock.now() - meta.createdAt > this.config.maxPlanAgeMs) return true

    const current = threatProfile(snapshot)
    const previous = meta.threats
    if (current.length !== previous.length) return true
    const byRow = new Map(previous.map((threat) => [threat.row, threat]))
    for (const threat of current) {
      const before = byRow.get(threat.row)
      if (!before || before.count !== threat.count) return true
      if (before.closestX - threat.closestX >= this.config.planThreatShift) return true
    }
    return false
  }

  #normalizePlan(snapshot, decision, challenge) {
    if (!Array.isArray(decision.plan)) return {error: "missing_plan"}
    if (decision.plan.length > this.config.maxPlanActions) return {error: "plan_too_long"}

    const plan = []
    for (let index = 0; index < decision.plan.length; index += 1) {
      const raw = decision.plan[index]
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return {error: "bad_action_shape", index}
      }
      if (!Number.isInteger(raw.row) || !Number.isInteger(raw.col) ||
          raw.row < 1 || raw.row > snapshot.rows ||
          raw.col < 1 || raw.col > snapshot.columns) {
        return {error: "out_of_bounds", index}
      }

      if (raw.type === ACTION.PLANT) {
        if (typeof raw.plant !== "string" || !raw.plant.trim() || raw.plant.length > 32) {
          return {error: "bad_plant", index}
        }
        const plant = raw.plant.trim()
        if (challenge.bannedPlants.includes(plant)) return {error: ISSUE.CHALLENGE_BAN, index}
        plan.push({type: ACTION.PLANT, plant, row: raw.row, col: raw.col})
      } else if (raw.type === ACTION.SHOVEL) {
        plan.push({type: ACTION.SHOVEL, row: raw.row, col: raw.col})
      } else {
        return {error: "unsupported_ai_action", index, type: raw.type}
      }
    }

    if (plan.length) {
      const first = {...plan[0], gameId: snapshot.gameId, revision: snapshot.revision}
      const key = actionKey(first)
      if (this.rejections.revision === snapshot.revision && this.rejections.keys.has(key)) {
        return {error: "rejected_at_current_revision", action: first}
      }
      const issue = validateAction(snapshot, first, challenge)
      if (issue) return {error: issue, action: first}
    }
    return {plan}
  }

  async #decide(snapshot) {
    if (this.clock.now() < this.nextAgentAttemptAt) return null
    const challenge = this.#challenge()
    const observation = viewForModel(snapshot)
    const audienceContext = {
      vote: this.audience?.summary?.() ?? null,
      messages: this.audience?.peekMessages?.(8) ?? [],
      challenge
    }
    const context = {
      level: snapshot.level,
      targetLevels: this.config.targetLevels,
      challenge,
      audience: audienceContext,
      strategy: this.strategy,
      previousPlan: this.plan,
      lastAction: this.lastAction,
      lastPlanError: this.lastPlanError,
      rejectedActions: [...this.rejections.keys]
    }

    try {
      const decision = await withTimeout(
        Promise.resolve(this.agent.decide({
          snapshot,
          observation,
          context,
          previousPlan: this.plan,
          lastAction: this.lastAction
        })),
        this.config.agentTimeoutMs
      )
      if (decision === null) {
        this.nextAgentAttemptAt = this.clock.now() + this.config.agentRetryMs
        return null
      }

      const normalized = this.#normalizePlan(snapshot, decision, challenge)
      if (normalized.error) {
        this.stats.invalidDecisions += 1
        this.lastPlanError = normalized.error
        this.nextAgentAttemptAt = this.clock.now() + this.config.agentRetryMs
        this.#emit("invalid_decision", {
          error: normalized.error,
          index: normalized.index,
          action: normalized.action
        })
        return null
      }

      this.stats.agentDecisions += 1
      this.lastPlanError = null
      this.nextAgentAttemptAt = 0
      this.audience?.clearMessages?.()
      return {
        plan: normalized.plan,
        goal: typeof decision.goal === "string" ? decision.goal.slice(0, 160) : "自主调整战术",
        rationale: typeof decision.rationale === "string" ? decision.rationale.slice(0, 240) : "",
        speech: typeof decision.speech === "string" ? decision.speech.slice(0, 120) : ""
      }
    } catch (error) {
      if (error?.kind === "cancelled") this.stats.agentTimeouts += 1
      else this.stats.agentFailures += 1
      this.nextAgentAttemptAt = this.clock.now() + this.config.agentRetryMs
      this.logger?.warn?.("agent unavailable: " + error.message)
      this.#emit("agent_error", {message: error.message})
      return null
    }
  }

  async #act(snapshot, action, {reason = "agent", speech = ""} = {}) {
    const challenge = this.#challenge()
    const result = await this.executor.submit(snapshot, action, {challenge, reason})
    this.lastActionAt = this.clock.now()
    this.stats.levelCommands += 1

    if (result.outcome === OUTCOME.REJECTED) {
      this.rejections.keys.add(actionKey(action))
      this.#emit("command_rejected", {action, issue: result.issue, reason})
      if (reason === "agent_plan" || reason === "emergency") this.#clearPlan("command_rejected")
    }
    if (result.outcome === OUTCOME.AMBIGUOUS) this.stats.ambiguous += 1
    if (result.outcome === OUTCOME.ACKNOWLEDGED) this.stats.acknowledged += 1

    if (result.outcome === OUTCOME.ACKNOWLEDGED || result.outcome === OUTCOME.AMBIGUOUS) {
      this.pendingSpeech = speech
      if (reason === "agent_plan") this.pendingPlanAction = action
    }
    await this.#afterOutcome(result, snapshot, {speech})
    return result
  }

  #publishSpeech(speech, level) {
    if (typeof speech !== "string" || !speech.trim()) return
    const now = this.clock.now()
    if (now - this.lastSpeechAt < this.config.narrationMinIntervalMs) return
    this.lastSpeechAt = now
    this.lastSpeech = speech.trim().slice(0, 120)
    this.#emit("narration", {text: this.lastSpeech, level})
  }

  async #afterOutcome(result, snapshot, {speech = ""} = {}) {
    if (!result) return
    switch (result.outcome) {
      case OUTCOME.VERIFIED: {
        this.stats.verified += 1
        if (result.action?.type === ACTION.COLLECT_SUN) this.stats.sunsCollected += 1
        if (this.pendingPlanAction &&
            actionKey(this.pendingPlanAction) === actionKey(result.action)) {
          if (this.plan.length && actionKey(this.plan[0]) === actionKey(result.action)) {
            this.plan.shift()
            this.stats.plannedActions += 1
          }
          this.pendingPlanAction = null
        }
        this.lastAction = {
          action: result.action,
          outcome: OUTCOME.VERIFIED,
          revision: result.revision
        }
        this.#emit("command_verified", {
          action: result.action,
          revision: result.revision,
          speech
        })
        this.#publishSpeech(speech, snapshot.level)
        break
      }
      case OUTCOME.REJECTED:
        this.stats.rejected += 1
        this.pendingPlanAction = null
        break
      case OUTCOME.ABANDONED:
        this.stats.abandoned += 1
        this.pendingPlanAction = null
        this.#clearPlan("command_abandoned")
        this.#emit("command_abandoned", {action: result.action, reason: result.reason})
        break
      default:
        break
    }
  }

  async step() {
    if (this.done) return {state: "finished", reason: this.finished?.reason}
    this.stats.cycles += 1

    const closedPoll = this.audience?.close?.(this.clock.now())
    if (closedPoll) this.#emit("audience_poll_closed", closedPoll)

    const snapshot = await this.#read()
    this.#ingest(snapshot)

    const reconciled = this.executor.observe(snapshot)
    if (reconciled) {
      const speech = this.pendingSpeech
      this.pendingSpeech = ""
      await this.#afterOutcome(reconciled, snapshot, {speech})
    }
    if (!this.executor.ready) return {state: "awaiting_reconcile"}

    if (snapshot.status === STATUS.LOST) return this.#finish("lost", snapshot)

    if (snapshot.status === STATUS.WON) {
      this.#clearPlan("level_won")
      if (snapshot.level >= this.config.targetLevels || !snapshot.hasNextLevel) {
        return this.#finish("campaign_complete", snapshot)
      }
      const action = {
        type: ACTION.NEXT_LEVEL,
        gameId: snapshot.gameId,
        revision: snapshot.revision
      }
      await this.#act(snapshot, action, {reason: "level_complete"})
      return {state: "next_level"}
    }

    // Bootstrap and campaign progression are deterministic lifecycle work.
    if (snapshot.status === STATUS.MENU || snapshot.status === STATUS.INTRO) {
      this.#clearPlan("bootstrap")
      const type = snapshot.status === STATUS.MENU
        ? ACTION.ENTER_ADVENTURE
        : ACTION.CHOOSE_SEEDS
      const action = {type, gameId: snapshot.gameId, revision: snapshot.revision}
      await this.#act(snapshot, action, {reason: "bootstrap"})
      return {state: snapshot.status}
    }

    if (snapshot.status !== STATUS.PLAYING) return {state: snapshot.status}
    if (this.stats.levelCommands >= this.config.maxCommandsPerLevel) {
      return this.#finish("stuck", snapshot)
    }
    if (this.clock.now() - this.lastActionAt < this.config.minActionIntervalMs) {
      return {state: "throttled"}
    }

    // Sun collection is housekeeping, not an LLM decision. Only imminent sun
    // pre-empts strategy; opportunistic sun is collected when the AI chooses to wait.
    const urgentSun = this.#pickSun(snapshot, {urgent: true})
    if (urgentSun) {
      await this.#act(snapshot, urgentSun, {reason: "sun_urgent"})
      return {state: "collect_sun"}
    }

    // This is a safety brake, not a default plant-placement strategy.
    const emergency = this.#emergencyAction(snapshot)
    if (emergency) {
      this.#clearPlan("emergency_defence")
      await this.#act(snapshot, emergency, {reason: "emergency"})
      return {state: "emergency"}
    }

    if (this.plan.length && this.#planIsStale(snapshot)) {
      this.#clearPlan("plan_stale")
    }

    // Continue a previously model-authored plan only while its next action is
    // still legal and the threat/audience context has not materially changed.
    if (this.plan.length) {
      const action = {
        ...this.plan[0],
        gameId: snapshot.gameId,
        revision: snapshot.revision
      }
      const issue = validateAction(snapshot, action, this.#challenge())
      if (!issue) {
        const speech = this.planSpeech
        this.planSpeech = ""
        await this.#act(snapshot, action, {reason: "agent_plan", speech})
        return {state: "planned_action"}
      }
      this.#clearPlan("planned_action_invalid")
    }

    const decision = await this.#decide(snapshot)
    if (!decision) {
      const sunAction = this.#pickSun(snapshot)
      if (sunAction) {
        await this.#act(snapshot, sunAction, {reason: "sun"})
        return {state: "collect_sun"}
      }
      return {state: "agent_unavailable"}
    }

    this.strategy = {goal: decision.goal, rationale: decision.rationale}
    this.plan = decision.plan
    this.planSpeech = decision.speech
    if (this.plan.length) {
      this.stats.agentPlans += 1
      this.planMeta = {
        gameId: snapshot.gameId,
        level: snapshot.level,
        wave: snapshot.wave,
        createdAt: this.clock.now(),
        audienceVersion: this.audience?.version ?? 0,
        threats: threatProfile(snapshot)
      }
      this.#emit("strategy_update", {
        goal: this.strategy.goal,
        rationale: this.strategy.rationale,
        plan: this.plan
      })
      const action = {
        ...this.plan[0],
        gameId: snapshot.gameId,
        revision: snapshot.revision
      }
      const issue = validateAction(snapshot, action, this.#challenge())
      if (issue) {
        this.stats.invalidDecisions += 1
        this.lastPlanError = issue
        this.#clearPlan("first_action_invalid")
        this.nextAgentAttemptAt = this.clock.now() + this.config.agentRetryMs
        this.#emit("invalid_decision", {error: issue, action})
        return {state: "invalid_decision"}
      }
      const speech = this.planSpeech
      this.planSpeech = ""
      await this.#act(snapshot, action, {reason: "agent_plan", speech})
      return {state: "acted"}
    }

    // A deliberate wait is a valid strategic answer. The program may still
    // perform low-level sun collection without asking the model to choose it.
    this.#publishSpeech(decision.speech, snapshot.level)
    this.nextAgentAttemptAt = this.clock.now() + this.config.agentRetryMs
    const sunAction = this.#pickSun(snapshot)
    if (sunAction) {
      await this.#act(snapshot, sunAction, {reason: "sun"})
      return {state: "collect_sun"}
    }
    return {state: "agent_wait"}
  }

  #finish(reason, snapshot) {
    this.#clearPlan("finished")
    this.#recordLevel(snapshot)
    this.finished = {
      reason,
      at: this.clock.now(),
      level: snapshot.level,
      status: snapshot.status,
      durationMs: this.clock.now() - this.startedAt
    }
    this.#emit("finished", this.finished)
    this.logger?.info?.("finished: " + reason + " at level " + snapshot.level)
    return {state: "finished", reason}
  }

  summary() {
    return {
      finished: this.finished,
      failure: this.failure?.message ?? null,
      level: this.snapshot?.level ?? null,
      status: this.snapshot?.status ?? null,
      revision: this.snapshot?.revision ?? null,
      lastSpeech: this.lastSpeech,
      strategy: this.strategy,
      plan: this.plan,
      pending: this.executor.describe(),
      levels: this.levels,
      stats: {...this.stats, executor: {...this.executor.stats}}
    }
  }
}

export {ISSUE}
