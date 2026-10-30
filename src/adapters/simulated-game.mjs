/**
 * Deterministic reference engine.
 *
 * This is NOT the game. It is a protocol-faithful stand-in that lets the whole
 * controller (scheduler, policy, executor, journal, level transitions) run and
 * be tested end-to-end on a machine without PvZ GOTY assets. It deliberately
 * mimics PvZ GOTY numbers where practical: 5x9 lawn, seed cooldowns, 24s
 * sunflower production, 20-damage peas, 200/560/1300 HP zombies, lawnmowers.
 *
 * `docs/M0-STATUS.md` records that simulator levels are evidence for the
 * controller, not for the native game bridge.
 */
import {
  ACTION,
  ISSUE,
  STATUS,
  buildCommand,
  normalizeSnapshot,
  validateAction
} from "../domain/contract.mjs"

const TICK_MS = 50
export const ROWS = 5
export const COLUMNS = 9

export const PLANT_DEFS = Object.freeze({
  sunflower: {cost: 50, cooldownMs: 7500, health: 300, produceMs: 18000, sunValue: 25},
  peashooter: {cost: 100, cooldownMs: 7500, health: 300, shotMs: 1400, damage: 20},
  wallnut: {cost: 50, cooldownMs: 30000, health: 4000},
  snowpea: {cost: 175, cooldownMs: 7500, health: 300, shotMs: 1400, damage: 20, slowFactor: 0.5, slowMs: 3000}
})

const ZOMBIE_DEFS = Object.freeze({
  normal: {health: 200, speed: 0.13, damagePerSecond: 100},
  cone: {health: 350, speed: 0.13, damagePerSecond: 100},
  bucket: {health: 700, speed: 0.13, damagePerSecond: 100}
})

const START_SUN = 50
/** PvZ caps the sun bank; the controller must cope with a saturated wallet. */
const MAX_SUN = 9990
const SKY_SUN_MS = 6000
const SUN_TTL_MS = 11000
const FIRST_WAVE_MS = 10000

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function levelPlan(level) {
  const totalWaves = 1 + Math.ceil(level / 3)
  const pool = level <= 2
    ? ["normal"]
    : level <= 4
      ? ["normal", "normal", "cone"]
      : level <= 6
        ? ["normal", "cone", "cone"]
        : level <= 8
          ? ["normal", "cone", "cone", "bucket"]
          : ["normal", "cone", "cone", "bucket", "bucket"]
  // One zombie per wave keeps the reference scenario winnable for the simple
  // online agent; difficulty scales through zombie type and wave count.
  const perWave = 1
  return {
    totalWaves,
    pool,
    perWave,
    waveIntervalMs: Math.max(16000, 20000 - level * 400)
  }
}

/** Small deterministic PRNG so a seed reproduces a session exactly. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const nextRandom = (state) => {
  let a = (state.rngState = (state.rngState + 0x6D2B79F5) >>> 0)
  let t = a
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export class SimulatedGame {
  /**
   * @param {object} options
   * @param {number} [options.seed] deterministic scenario seed
   * @param {number} [options.levels] levels in the campaign
   * @param {() => number} [options.now] injected clock (defaults to wall clock)
   * @param {number} [options.commandLatencyMs] simulated round-trip latency
   */
  constructor({seed = 7, levels = 10, startLevel = 1, now = () => Date.now(), commandLatencyMs = 0} = {}) {
    this.seed = seed
    this.levels = levels
    this.now = now
    this.commandLatencyMs = commandLatencyMs
    this.receipts = new Map()
    this.receiptOrder = []
    this.gameId = `sim-${seed}`
    this.#resetLevel(startLevel)
    this.state.status = STATUS.PLAYING
    this.state.lastAdvance = this.now()
    this.state.revision = 1
  }

  #createCards() {
    const cards = {}
    for (const [type, def] of Object.entries(PLANT_DEFS)) {
      cards[type] = {ready: true, cooldownMs: 0, cost: def.cost}
    }
    return cards
  }

  #resetLevel(level) {
    this.state = {
      gameId: this.gameId,
      revision: this.state?.revision ?? 1,
      level,
      status: STATUS.PLAYING,
      sun: START_SUN,
      timeMs: 0,
      lastAdvance: this.now(),
      plan: levelPlan(level),
      wavesSpawned: 0,
      waveTimerMs: FIRST_WAVE_MS,
      skySunTimerMs: SKY_SUN_MS,
      skySunCounter: 0,
      clearTimerMs: 0,
      plants: [],
      zombies: [],
      suns: [],
      cards: this.#createCards(),
      mowers: Array.from({length: ROWS}, () => true),
      nextId: 1,
      rngState: (this.seed * 7919 + level * 104729) >>> 0,
      nextWaveDelayMs: 0,
      dirty: false
    }
    this.state.nextWaveDelayMs = FIRST_WAVE_MS
  }

  #nextId(prefix) {
    const id = `${prefix}${this.state.nextId}`
    this.state.nextId += 1
    return id
  }

  #snapshotOf(state = this.state) {
    return normalizeSnapshot({
      gameId: state.gameId,
      revision: state.revision,
      level: state.level,
      wave: state.wavesSpawned,
      totalWaves: state.plan.totalWaves,
      sun: state.sun,
      rows: ROWS,
      columns: COLUMNS,
      status: state.status,
      hasNextLevel: state.level < this.levels,
      plants: state.plants.map((p) => ({type: p.type, row: p.row, col: p.col, health: Math.round(p.hp)})),
      zombies: state.zombies.map((z) => ({
        type: z.type,
        row: z.row,
        x: Math.round(z.x * 1000) / 1000,
        health: Math.max(0, Math.round(z.hp))
      })),
      suns: state.suns.map((s) => ({
        id: s.id,
        x: s.x,
        y: s.y,
        expiresInMs: Math.max(0, Math.round(s.ttlMs))
      })),
      cards: Object.entries(state.cards).map(([type, card]) => ({type, cost: card.cost, ready: card.ready})),
      blocked: []
    })
  }

  snapshot() {
    this.#advanceTo(this.now())
    return this.#snapshotOf()
  }

  #advanceTo(nowMs) {
    const st = this.state
    if (st.status !== STATUS.PLAYING) {
      st.lastAdvance = nowMs
      return
    }
    const elapsed = Math.max(0, nowMs - st.lastAdvance)
    st.lastAdvance = nowMs
    let remaining = elapsed
    while (remaining >= TICK_MS) {
      this.#tick(TICK_MS)
      st.timeMs += TICK_MS
      remaining -= TICK_MS
      if (st.status !== STATUS.PLAYING) break
    }
    if (st.dirty) {
      st.dirty = false
      st.revision += 1
    }
  }

  #tick(dtMs) {
    const st = this.state
    const dt = dtMs / 1000

    for (const card of Object.values(st.cards)) {
      if (card.ready) continue
      card.cooldownMs -= dtMs
      if (card.cooldownMs <= 0) {
        card.cooldownMs = 0
        card.ready = true
        st.dirty = true
      }
    }

    for (const sun of st.suns) sun.ttlMs -= dtMs
    const survivingSuns = st.suns.filter((sun) => sun.ttlMs > 0)
    if (survivingSuns.length !== st.suns.length) {
      st.suns = survivingSuns
      st.dirty = true
    }

    st.skySunTimerMs -= dtMs
    if (st.skySunTimerMs <= 0) {
      st.skySunTimerMs = SKY_SUN_MS
      st.skySunCounter += 1
      st.suns.push({
        id: this.#nextId("sun"),
        x: 0.6 + nextRandom(st) * (COLUMNS - 1.2),
        y: 0.4 + nextRandom(st) * (ROWS - 0.8),
        ttlMs: SUN_TTL_MS,
        value: 25
      })
      st.dirty = true
    }

    if (st.wavesSpawned < st.plan.totalWaves) {
      st.waveTimerMs -= dtMs
      if (st.waveTimerMs <= 0) {
        st.wavesSpawned += 1
        st.waveTimerMs = st.plan.waveIntervalMs
        this.#spawnWave()
        st.dirty = true
      }
    }

    for (const zombie of st.zombies) {
      if (zombie.slowMs > 0) zombie.slowMs -= dtMs
      const def = ZOMBIE_DEFS[zombie.type]
      const factor = zombie.slowMs > 0 ? 0.5 : 1
      const target = this.#plantUnderZombie(zombie)
      if (target) {
        zombie.eating = true
        target.hp -= def.damagePerSecond * dt
        if (target.hp <= 0) {
          st.plants = st.plants.filter((p) => p !== target)
          st.dirty = true
        }
      } else {
        zombie.eating = false
        zombie.x -= def.speed * factor * dt
      }
      if (zombie.x <= 0.05 && !zombie.eating) {
        this.#triggerMower(zombie)
      }
    }

    st.zombies = st.zombies.filter((z) => z.hp > 0 && !z.dead)

    for (const plant of st.plants) {
      const def = PLANT_DEFS[plant.type]
      if (def.produceMs) {
        plant.timerMs += dtMs
        if (plant.timerMs >= def.produceMs) {
          plant.timerMs -= def.produceMs
          st.suns.push({
            id: this.#nextId("sun"),
            x: plant.col - 0.5,
            y: plant.row - 0.5,
            ttlMs: SUN_TTL_MS,
            value: def.sunValue
          })
          st.dirty = true
        }
      }
      if (def.shotMs) {
        plant.timerMs += dtMs
        if (plant.timerMs >= def.shotMs) {
          const reachable = st.zombies
            .filter((z) => z.row === plant.row && z.x > plant.col - 0.5)
            .sort((a, b) => a.x - b.x)
          if (reachable.length) {
            plant.timerMs = 0
            const victim = reachable[0]
            victim.hp -= def.damage
            if (def.slowMs) victim.slowMs = Math.max(victim.slowMs, def.slowMs)
            st.dirty = true
            if (victim.hp <= 0) {
              victim.dead = true
              st.dirty = true
            }
          }
        }
      }
    }

    if (st.wavesSpawned >= st.plan.totalWaves && st.zombies.length === 0) {
      st.clearTimerMs += dtMs
      if (st.clearTimerMs >= 1200 && st.status === STATUS.PLAYING) {
        st.status = STATUS.WON
        st.dirty = true
      }
    } else {
      st.clearTimerMs = 0
    }
  }

  #plantUnderZombie(zombie) {
    const col = clamp(Math.ceil(zombie.x), 1, COLUMNS)
    return this.state.plants.find((p) => p.row === zombie.row && p.col === col) ?? null
  }

  #triggerMower(zombie) {
    const st = this.state
    const rowIndex = zombie.row - 1
    if (st.mowers[rowIndex]) {
      st.mowers[rowIndex] = false
      st.zombies = st.zombies.filter((z) => z.row !== zombie.row)
      st.dirty = true
    } else {
      st.status = STATUS.LOST
      st.dirty = true
    }
  }

  #spawnWave() {
    const st = this.state
    const count = Math.min(6, st.plan.perWave + (st.wavesSpawned === st.plan.totalWaves ? 1 : 0))
    for (let i = 0; i < count; i += 1) {
      const type = st.plan.pool[Math.floor(nextRandom(st) * st.plan.pool.length)]
      const row = 1 + Math.floor(nextRandom(st) * ROWS)
      st.zombies.push({
        id: this.#nextId("z"),
        type,
        row,
        x: COLUMNS + 0.4 + nextRandom(st) * 1.6 + i * 0.5,
        hp: ZOMBIE_DEFS[type].health,
        slowMs: 0,
        eating: false,
        dead: false
      })
    }
  }

  /* ------------------------------ commands ------------------------------ */

  async command({commandId, expectedRevision, action}) {
    this.#advanceTo(this.now())
    if (this.commandLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.commandLatencyMs))
      this.#advanceTo(this.now())
    }
    const cached = this.receipts.get(commandId)
    if (cached) {
      return {...cached, status: "duplicate", issue: ISSUE.DUPLICATE_COMMAND}
    }

    const st = this.state
    const revisionBefore = st.revision
    const receipt = (status, issue) => ({
      commandId,
      status,
      ...(issue ? {issue} : {}),
      revisionBefore,
      revisionAfter: status === "applied" ? st.revision + 1 : revisionBefore
    })

    if (!action || typeof action !== "object") return this.#remember(receipt("rejected", ISSUE.BAD_ACTION))
    if (action.gameId !== st.gameId) return this.#remember(receipt("rejected", ISSUE.STALE_STATE))
    if (expectedRevision > st.revision) return this.#remember(receipt("rejected", ISSUE.FUTURE_STATE))

    const current = this.#snapshotOf()
    const issue = validateAction(current, {...action, revision: current.revision})
    if (issue) return this.#remember(receipt("rejected", issue))

    this.#apply(action)
    st.revision += 1
    st.dirty = false
    const result = {
      commandId,
      status: "applied",
      revisionBefore,
      revisionAfter: st.revision
    }
    this.#remember(result)
    return result
  }

  #remember(receipt) {
    this.receipts.set(receipt.commandId, receipt)
    this.receiptOrder.push(receipt.commandId)
    if (this.receiptOrder.length > 512) {
      const oldest = this.receiptOrder.shift()
      this.receipts.delete(oldest)
    }
    return receipt
  }

  #apply(action) {
    const st = this.state
    switch (action.type) {
      case ACTION.PLANT: {
        const def = PLANT_DEFS[action.plant]
        st.sun = Math.min(MAX_SUN, st.sun - def.cost)
        st.plants.push({type: action.plant, row: action.row, col: action.col, hp: def.health, timerMs: 0})
        const card = st.cards[action.plant]
        card.ready = false
        card.cooldownMs = def.cooldownMs
        break
      }
      case ACTION.COLLECT_SUN: {
        st.suns = st.suns.filter((s) => s.id !== action.id)
        st.sun = Math.min(MAX_SUN, st.sun + 25)
        break
      }
      case ACTION.SHOVEL: {
        st.plants = st.plants.filter((p) => !(p.row === action.row && p.col === action.col))
        break
      }
      case ACTION.NEXT_LEVEL: {
        const next = st.level + 1
        const carriedRevision = st.revision + 1
        this.#resetLevel(next)
        this.state.revision = carriedRevision
        this.state.lastAdvance = this.now()
        break
      }
      default:
        throw new Error(`unreachable action ${action.type}`)
    }
    this.state.dirty = true
  }

  /* ------------------------- restart / persistence ------------------------ */

  /** Serialise the deterministic scenario (used by restart tests). */
  exportState() {
    const st = this.state
    return {
      seed: this.seed,
      levels: this.levels,
      gameId: this.gameId,
      state: {
        ...st,
        plan: st.plan,
        plants: st.plants.map((p) => ({...p})),
        zombies: st.zombies.map((z) => ({...z})),
        suns: st.suns.map((s) => ({...s})),
        mowers: [...st.mowers],
        cards: Object.fromEntries(Object.entries(st.cards).map(([k, v]) => [k, {...v}]))
      }
    }
  }

  static restore(exported, {now = () => Date.now()} = {}) {
    const state = exported.state
    const sim = new SimulatedGame({
      seed: exported.seed,
      levels: exported.levels,
      startLevel: state.level,
      now,
      commandLatencyMs: 0
    })
    sim.gameId = exported.gameId
    sim.state = {
      ...state,
      plan: state.plan,
      plants: state.plants.map((p) => ({...p})),
      zombies: state.zombies.map((z) => ({...z})),
      suns: state.suns.map((s) => ({...s})),
      mowers: [...state.mowers],
      cards: Object.fromEntries(Object.entries(state.cards).map(([k, v]) => [k, {...v}])),
      lastAdvance: now(),
      dirty: false
    }
    sim.state.revision = state.revision
    return sim
  }

  /** Build a command for tests and the local runner. */
  commandFor(action, {newId = () => `cmd-${Math.random().toString(36).slice(2)}`} = {}) {
    return buildCommand(this.snapshot(), action, {newId})
  }
}
