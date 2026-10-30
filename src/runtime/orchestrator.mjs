import {
  ACTION,
  ISSUE,
  STATUS,
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
  /** Zombie x (in cells) below which the controller defends without the model. */
  emergencyX: 2.4,
  /** Hard stop if a single level needs absurdly many commands (stuck detection). */
  maxCommandsPerLevel: 400,
  minActionIntervalMs: 250,
  /** Collect a sun immediately when it is this close to expiring. */
  sunUrgentMs: 5000,
  /** Opportunistic collection happens only when no affordable play exists. */
  readRetries: 3,
  readBackoffMs: 120,
  agentTimeoutMs: 6000,
  narrationEnabled: true,
  narrationMinIntervalMs: 8000,
  challenge: {}
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One control cycle = one bounded, observable decision.
 *
 * Order of authority: engine state > emergency rules > audience constraints >
 * model choice. The model can only pick an index from `candidates()`; it can
 * never invent coordinates, spend sun, or talk the executor into a retry.
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
    narrator = null,
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
    this.narrator = narrator
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
    this.stats = {
      cycles: 0,
      verified: 0,
      rejected: 0,
      ambiguous: 0,
      acknowledged: 0,
      abandoned: 0,
      agentDecisions: 0,
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

  #challenge() {
    const fromConfig = this.config.challenge ?? {}
    const fromAudience = this.audience?.challenge?.() ?? {}
    return {
      bannedPlants: [...new Set([...(fromConfig.bannedPlants ?? []), ...(fromAudience.bannedPlants ?? [])])]
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
        if (attempt < this.config.readRetries) await sleep(this.config.readBackoffMs * (attempt + 1))
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
    }
    if (relation === "engine_changed") {
      this.stats.levelCommands = 0
      this.levelStartedAt = this.clock.now()
      this.#emit("engine_changed", {gameId: snapshot.gameId})
    }
    if (relation !== "same") this.#emit("snapshot", {revision: snapshot.revision, relation})
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

  async step() {
    if (this.done) return {state: "finished", reason: this.finished?.reason}
    this.stats.cycles += 1

    const snapshot = await this.#read()
    this.#ingest(snapshot)

    const reconciled = this.executor.observe(snapshot)
    if (reconciled) await this.#afterOutcome(reconciled, snapshot)
    if (!this.executor.ready) return {state: "awaiting_reconcile"}

    if (snapshot.status === STATUS.LOST) return this.#finish("lost", snapshot)

    if (snapshot.status === STATUS.WON) {
      if (snapshot.level >= this.config.targetLevels || !snapshot.hasNextLevel) {
        return this.#finish("campaign_complete", snapshot)
      }
      const action = {type: ACTION.NEXT_LEVEL, gameId: snapshot.gameId, revision: snapshot.revision}
      await this.#act(snapshot, action, {reason: "level_complete"})
      return {state: "next_level"}
    }

    if (snapshot.status !== STATUS.PLAYING) return {state: snapshot.status}

    if (this.stats.levelCommands >= this.config.maxCommandsPerLevel) {
      return this.#finish("stuck", snapshot)
    }

    if (this.clock.now() - this.lastActionAt < this.config.minActionIntervalMs) {
      return {state: "throttled"}
    }

    const offered = candidates(snapshot, this.#challenge())

    // 1. A sun about to rot always wins a cycle.
    const urgentSun = this.#pickSun(snapshot, {urgent: true})
    if (urgentSun) {
      await this.#act(snapshot, urgentSun, {reason: "sun_urgent"})
      return {state: "collect_sun"}
    }

    // 2. Defence near the house does not wait for the model.
    const emergency = this.#emergencyAction(snapshot)
    if (emergency) {
      await this.#act(snapshot, emergency, {reason: "emergency"})
      return {state: "emergency"}
    }

    // 3. No affordable play: bank sun instead of idling on an expiring lawn.
    if (!offered.length) {
      const sunAction = this.#pickSun(snapshot)
      if (!sunAction) return {state: "idle"}
      await this.#act(snapshot, sunAction, {reason: "sun"})
      return {state: "collect_sun"}
    }

    const decision = await this.#decide(snapshot, offered)
    if (!decision) {
      // The agent may deliberately wait (e.g. saving for a shooter); bank sun.
      const sunAction = this.#pickSun(snapshot)
      if (!sunAction) return {state: "no_decision"}
      await this.#act(snapshot, sunAction, {reason: "sun"})
      return {state: "collect_sun"}
    }
    const action = offered[decision.index]
    if (!action || validateAction(snapshot, action, this.#challenge())) {
      this.stats.invalidDecisions += 1
      this.#emit("invalid_decision", {index: decision.index})
      return {state: "invalid_decision"}
    }
    await this.#act(snapshot, action, {reason: "agent", speech: decision.speech})
    return {state: "acted"}
  }

  #pickSun(snapshot, {urgent = false} = {}) {
    const suns = [...snapshot.suns].sort((a, b) => (a.expiresInMs ?? 1e9) - (b.expiresInMs ?? 1e9))
    if (urgent) {
      const expiring = suns.filter((sun) => (sun.expiresInMs ?? Infinity) <= this.config.sunUrgentMs)
      if (!expiring.length) return null
      suns.splice(0, suns.length, ...expiring)
    }
    for (const sun of suns.slice(0, 3)) {
      const action = {type: ACTION.COLLECT_SUN, id: sun.id, gameId: snapshot.gameId, revision: snapshot.revision}
      if (!validateAction(snapshot, action)) return action
    }
    return null
  }

  #emergencyAction(snapshot) {
    const challenge = this.#challenge()
    // A lane already at the mower cannot be saved by feeding the zombie one
    // plant after another; let the mower reset it instead.
    const threatened = threatRows(snapshot).filter((t) => t.closestX < this.config.emergencyX && t.closestX >= 1.5)
    if (!threatened.length) return null
    const offered = candidates(snapshot, challenge)
    const shooters = (row) => snapshot.plants.filter((p) => p.row === row && (p.type === "peashooter" || p.type === "snowpea"))

    // No shooter in the lane: a wall buys nothing, add damage.
    for (const threat of threatened) {
      if (shooters(threat.row).length) continue
      for (const plant of ["peashooter", "snowpea"]) {
        const action = offered.find((a) => a.type === ACTION.PLANT && a.plant === plant && a.row === threat.row)
        if (action) return action
      }
    }
    // Shooter exists: one blocker in front of it is worth the sun.
    for (const threat of threatened) {
      if (!shooters(threat.row).length) continue
      if (snapshot.plants.some((p) => p.row === threat.row && p.type === "wallnut")) continue
      const wall = offered.find((a) => a.type === ACTION.PLANT && a.plant === "wallnut" && a.row === threat.row)
      if (wall) return wall
    }
    return null
  }

  async #decide(snapshot, offered) {
    const context = {
      level: snapshot.level,
      targetLevels: this.config.targetLevels,
      challenge: this.#challenge(),
      vote: this.audience?.summary?.() ?? null
    }
    try {
      const decision = await withTimeout(
        Promise.resolve(this.agent.decide({snapshot, observation: viewForModel(snapshot), candidates: offered, context})),
        this.config.agentTimeoutMs
      )
      if (decision === null) return null
      if (!Number.isInteger(decision?.index) || decision.index < 0 || decision.index >= offered.length) {
        this.stats.invalidDecisions += 1
        return null
      }
      this.stats.agentDecisions += 1
      const speech = typeof decision.speech === "string" ? decision.speech.slice(0, 100) : ""
      return {index: decision.index, speech}
    } catch (error) {
      if (error?.kind === "cancelled") this.stats.agentTimeouts += 1
      else this.stats.agentFailures += 1
      this.logger?.warn?.(`agent unavailable: ${error.message}`)
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
      this.#emit("command_rejected", {action, issue: result.issue, reason})
    }
    if (result.outcome === OUTCOME.AMBIGUOUS) this.stats.ambiguous += 1
    if (result.outcome === OUTCOME.ACKNOWLEDGED) this.stats.acknowledged += 1
    await this.#afterOutcome(result, snapshot, {speech})
    return result
  }

  async #afterOutcome(result, snapshot, {speech = ""} = {}) {
    if (!result) return
    switch (result.outcome) {
      case OUTCOME.VERIFIED: {
        this.stats.verified += 1
        if (result.action?.type === ACTION.COLLECT_SUN) this.stats.sunsCollected += 1
        this.#emit("command_verified", {action: result.action, revision: result.revision})
        this.#narrate({
          kind: "action_confirmed",
          action: result.action,
          level: snapshot.level,
          sun: snapshot.sun,
          speech
        })
        break
      }
      case OUTCOME.REJECTED:
        this.stats.rejected += 1
        break
      case OUTCOME.ABANDONED:
        this.stats.abandoned += 1
        this.#emit("command_abandoned", {action: result.action, reason: result.reason})
        break
      default:
        break
    }
  }

  #narrate(event) {
    if (!this.config.narrationEnabled || !this.narrator) return
    const now = this.clock.now()
    if (now - this.lastSpeechAt < this.config.narrationMinIntervalMs) return
    this.lastSpeechAt = now
    Promise.resolve()
      .then(() => withTimeout(Promise.resolve(this.narrator.say(event)), this.config.agentTimeoutMs))
      .then((speech) => {
        if (typeof speech !== "string" || !speech.trim()) return
        this.lastSpeech = speech.slice(0, 100)
        this.#emit("narration", {text: this.lastSpeech})
      })
      .catch((error) => {
        this.stats.speechFailures += 1
        this.logger?.debug?.(`narration failed: ${error.message}`)
      })
  }

  #finish(reason, snapshot) {
    this.#recordLevel(snapshot)
    this.finished = {
      reason,
      at: this.clock.now(),
      level: snapshot.level,
      status: snapshot.status,
      durationMs: this.clock.now() - this.startedAt
    }
    this.#emit("finished", this.finished)
    this.logger?.info?.(`finished: ${reason} at level ${snapshot.level}`)
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
      pending: this.executor.describe(),
      levels: this.levels,
      stats: {...this.stats, executor: {...this.executor.stats}}
    }
  }
}

export {ISSUE}
