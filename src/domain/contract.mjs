import {ContractError, ProtocolError} from "./errors.mjs"

/**
 * Wire contract shared by the native bridge, the simulator and the controller.
 * Everything the controller observes passes through `normalizeSnapshot`, so a
 * hostile or buggy engine cannot feed unbounded data into prompts or policy.
 */
export const SCHEMA_VERSION = 1

export const STATUS = Object.freeze({
  PLAYING: "playing",
  /** Level intro / seed chooser: board exists, level not live yet. */
  INTRO: "intro",
  WON: "won",
  LOST: "lost",
  PAUSED: "paused",
  MENU: "menu"
})

export const ACTION = Object.freeze({
  PLANT: "plant",
  COLLECT_SUN: "collect_sun",
  SHOVEL: "shovel",
  NEXT_LEVEL: "next_level",
  /** Bootstrap: leave the title screen and enter the adventure flow. */
  ENTER_ADVENTURE: "enter_adventure",
  /** Bootstrap: fill the seed bank and start the level. */
  CHOOSE_SEEDS: "choose_seeds"
})

export const ISSUE = Object.freeze({
  STALE_STATE: "stale_state",
  FUTURE_STATE: "future_state",
  NOT_PLAYING: "not_playing",
  BAD_ACTION: "bad_action",
  UNSUPPORTED_ACTION: "unsupported_action",
  OUT_OF_BOUNDS: "out_of_bounds",
  OCCUPIED: "occupied",
  BLOCKED: "blocked",
  NO_PLANT: "no_plant",
  CHALLENGE_BAN: "challenge_ban",
  MISSING_CARD: "missing_card",
  COOLDOWN: "cooldown",
  INSUFFICIENT_SUN: "insufficient_sun",
  SUN_MISSING: "sun_missing",
  NO_NEXT_LEVEL: "no_next_level",
  NO_SEED_CHOOSER: "no_seed_chooser",
  DUPLICATE_COMMAND: "duplicate_command"
})

const STATUS_SET = new Set(Object.values(STATUS))
const MAX_PLANTS = 256
const MAX_ZOMBIES = 256
const MAX_CARDS = 16
const MAX_SUNS = 64

const freezeAll = (list) => Object.freeze(list.map((item) => Object.freeze(item)))

function fail(path, message) {
  throw new ContractError(`${path}: ${message}`, {path})
}

function int(value, path, {min = 0, max = Number.MAX_SAFE_INTEGER} = {}) {
  if (!Number.isInteger(value)) fail(path, "expected integer")
  if (value < min || value > max) fail(path, `expected ${min}..${max}, got ${value}`)
  return value
}

function num(value, path, {min = -Infinity, max = Infinity} = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected finite number")
  if (value < min || value > max) fail(path, `expected ${min}..${max}, got ${value}`)
  return value
}

function text(value, path, {max = 64} = {}) {
  if (typeof value !== "string" || value.length === 0) fail(path, "expected non-empty string")
  if (value.length > max) fail(path, `longer than ${max} characters`)
  return value
}

function bool(value, path) {
  if (typeof value !== "boolean") fail(path, "expected boolean")
  return value
}

function array(value, path, max) {
  if (!Array.isArray(value)) fail(path, "expected array")
  if (value.length > max) fail(path, `longer than ${max} entries`)
  return value
}

/**
 * @param {unknown} raw engine snapshot
 * @returns {Readonly<object>} bounded, frozen snapshot
 */
export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== "object") fail("snapshot", "expected object")
  const rows = int(raw.rows, "snapshot.rows", {min: 1, max: 6})
  const columns = int(raw.columns, "snapshot.columns", {min: 1, max: 10})
  const status = text(raw.status, "snapshot.status", {max: 16})
  if (!STATUS_SET.has(status)) fail("snapshot.status", `unknown status ${status}`)

  const insideRow = (value, path) => int(value, path, {min: 1, max: rows})
  const insideCol = (value, path) => int(value, path, {min: 1, max: columns})

  const plants = array(raw.plants ?? [], "snapshot.plants", MAX_PLANTS).map((plant, i) => {
    const at = `snapshot.plants[${i}]`
    if (!plant || typeof plant !== "object") fail(at, "expected object")
    return {
      type: text(plant.type, `${at}.type`, {max: 32}),
      row: insideRow(plant.row, `${at}.row`),
      col: insideCol(plant.col, `${at}.col`),
      ...(plant.health === undefined ? {} : {health: int(plant.health, `${at}.health`)})
    }
  })

  const seenPlants = new Set()
  for (const plant of plants) {
    const key = `${plant.row}:${plant.col}`
    if (seenPlants.has(key)) fail("snapshot.plants", `two plants share cell ${key}`)
    seenPlants.add(key)
  }

  const zombies = array(raw.zombies ?? [], "snapshot.zombies", MAX_ZOMBIES).map((zombie, i) => {
    const at = `snapshot.zombies[${i}]`
    if (!zombie || typeof zombie !== "object") fail(at, "expected object")
    return {
      type: text(zombie.type, `${at}.type`, {max: 32}),
      row: insideRow(zombie.row, `${at}.row`),
      x: num(zombie.x, `${at}.x`, {min: -2, max: columns + 20}),
      health: int(zombie.health, `${at}.health`)
    }
  })

  const cards = array(raw.cards ?? [], "snapshot.cards", MAX_CARDS).map((card, i) => {
    const at = `snapshot.cards[${i}]`
    if (!card || typeof card !== "object") fail(at, "expected object")
    return {
      type: text(card.type, `${at}.type`, {max: 32}),
      cost: int(card.cost, `${at}.cost`, {min: 0, max: 2000}),
      ready: bool(card.ready, `${at}.ready`)
    }
  })

  const suns = array(raw.suns ?? [], "snapshot.suns", MAX_SUNS).map((sun, i) => {
    const at = `snapshot.suns[${i}]`
    if (!sun || typeof sun !== "object") fail(at, "expected object")
    return {
      id: text(sun.id, `${at}.id`, {max: 64}),
      x: num(sun.x, `${at}.x`),
      y: num(sun.y, `${at}.y`),
      ...(sun.expiresInMs === undefined ? {} : {expiresInMs: int(sun.expiresInMs, `${at}.expiresInMs`)})
    }
  })

  const blocked = array(raw.blocked ?? [], "snapshot.blocked", MAX_PLANTS).map((cell, i) => {
    const at = `snapshot.blocked[${i}]`
    if (!cell || typeof cell !== "object") fail(at, "expected object")
    return {row: insideRow(cell.row, `${at}.row`), col: insideCol(cell.col, `${at}.col`)}
  })

  return Object.freeze({
    schema: SCHEMA_VERSION,
    gameId: text(raw.gameId, "snapshot.gameId", {max: 64}),
    revision: int(raw.revision, "snapshot.revision", {min: 0, max: 2 ** 31 - 1}),
    level: int(raw.level, "snapshot.level", {min: 1, max: 1000}),
    wave: int(raw.wave ?? 0, "snapshot.wave", {min: 0, max: 100}),
    totalWaves: int(raw.totalWaves ?? 0, "snapshot.totalWaves", {min: 0, max: 100}),
    sun: int(raw.sun, "snapshot.sun", {min: 0, max: 99999}),
    rows,
    columns,
    status,
    hasNextLevel: raw.hasNextLevel === undefined ? true : bool(raw.hasNextLevel, "snapshot.hasNextLevel"),
    plants: freezeAll(plants),
    zombies: freezeAll(zombies),
    cards: freezeAll(cards),
    suns: freezeAll(suns),
    blocked: freezeAll(blocked)
  })
}

export function snapshotId(snapshot) {
  return `${snapshot.gameId}@${snapshot.revision}`
}

/**
 * Classify how a newer snapshot relates to the previous one.
 * A decreasing revision is a hard error: the engine must never rewind.
 */
export function compareSnapshots(previous, next) {
  if (!previous) return "initial"
  if (previous.gameId !== next.gameId) return "engine_changed"
  if (next.revision < previous.revision) {
    throw new ContractError(`revision went backwards: ${previous.revision} -> ${next.revision}`, {
      previous: previous.revision,
      next: next.revision
    })
  }
  if (next.revision === previous.revision) return "same"
  if (next.level !== previous.level) return "level_changed"
  if (next.status !== previous.status) return "status_changed"
  return "advanced"
}

export function actionKey(action) {
  switch (action.type) {
    case ACTION.PLANT:
      return `plant:${action.plant}:${action.row}:${action.col}`
    case ACTION.COLLECT_SUN:
      return `sun:${action.id}`
    case ACTION.SHOVEL:
      return `shovel:${action.row}:${action.col}`
    case ACTION.NEXT_LEVEL:
      return "next_level"
    default:
      return `unknown:${String(action.type)}`
  }
}

/**
 * Client-side gate. The native bridge re-validates everything; this only avoids
 * shipping commands that are already known to be illegal.
 * @returns {string|null} issue code, or null when the action is legal
 */
export function validateAction(snapshot, action, challenge = {}) {
  if (!action || typeof action !== "object") return ISSUE.BAD_ACTION
  if (!snapshot || action.gameId !== snapshot.gameId || action.revision !== snapshot.revision) {
    return ISSUE.STALE_STATE
  }
  if (action.type === ACTION.ENTER_ADVENTURE) {
    return snapshot.status === STATUS.MENU ? null : ISSUE.NOT_PLAYING
  }
  if (action.type === ACTION.CHOOSE_SEEDS) {
    return snapshot.status === STATUS.INTRO ? null : ISSUE.NOT_PLAYING
  }
  if (action.type === ACTION.NEXT_LEVEL) {
    if (snapshot.status !== STATUS.WON) return ISSUE.NOT_PLAYING
    if (!snapshot.hasNextLevel) return ISSUE.NO_NEXT_LEVEL
    return null
  }
  if (snapshot.status !== STATUS.PLAYING) return ISSUE.NOT_PLAYING

  const inBounds = Number.isInteger(action.row) && Number.isInteger(action.col) &&
    action.row >= 1 && action.row <= snapshot.rows &&
    action.col >= 1 && action.col <= snapshot.columns

  if (action.type === ACTION.COLLECT_SUN) {
    return snapshot.suns.some((sun) => sun.id === action.id) ? null : ISSUE.SUN_MISSING
  }

  if (action.type === ACTION.SHOVEL) {
    if (!inBounds) return ISSUE.OUT_OF_BOUNDS
    return snapshot.plants.some((p) => p.row === action.row && p.col === action.col)
      ? null
      : ISSUE.NO_PLANT
  }

  if (action.type !== ACTION.PLANT) return ISSUE.UNSUPPORTED_ACTION
  if (!inBounds) return ISSUE.OUT_OF_BOUNDS
  if (snapshot.plants.some((p) => p.row === action.row && p.col === action.col)) return ISSUE.OCCUPIED
  if (snapshot.blocked.some((p) => p.row === action.row && p.col === action.col)) return ISSUE.BLOCKED
  if ((challenge.bannedPlants ?? []).includes(action.plant)) return ISSUE.CHALLENGE_BAN
  const card = snapshot.cards.find((c) => c.type === action.plant)
  if (!card) return ISSUE.MISSING_CARD
  if (!card.ready) return ISSUE.COOLDOWN
  if (card.cost > snapshot.sun) return ISSUE.INSUFFICIENT_SUN
  return null
}

/** Reduced projection for a model prompt. No future waves, no raw memory. */
export function viewForModel(snapshot) {
  const threatByRow = []
  for (let row = 1; row <= snapshot.rows; row += 1) {
    const rowZombies = snapshot.zombies.filter((z) => z.row === row)
    if (rowZombies.length) {
      threatByRow.push({
        row,
        count: rowZombies.length,
        closestX: Math.min(...rowZombies.map((z) => Math.round(z.x * 10) / 10))
      })
    }
  }
  return {
    level: snapshot.level,
    wave: snapshot.wave,
    totalWaves: snapshot.totalWaves,
    sun: snapshot.sun,
    status: snapshot.status,
    rows: snapshot.rows,
    columns: snapshot.columns,
    plants: snapshot.plants.slice(0, 24).map((p) => ({type: p.type, row: p.row, col: p.col})),
    zombies: snapshot.zombies.slice(0, 24).map((z) => ({
      type: z.type,
      row: z.row,
      x: Math.round(z.x * 10) / 10,
      health: z.health
    })),
    cards: snapshot.cards.map((c) => ({type: c.type, cost: c.cost, ready: c.ready})),
    suns: snapshot.suns.slice(0, 6).map((s) => ({id: s.id, x: Math.round(s.x), y: Math.round(s.y)})),
    threats: threatByRow.slice(0, 6)
  }
}

export function buildCommand(snapshot, action, {newId}) {
  const commandId = newId()
  if (typeof commandId !== "string" || commandId.length === 0 || commandId.length > 96) {
    throw new ContractError("command id must be a non-empty string of <= 96 chars")
  }
  return {commandId, expectedRevision: snapshot.revision, action}
}

const RECEIPT_STATUS = new Set(["applied", "accepted", "rejected", "duplicate"])

export function normalizeReceipt(raw, expectedCommandId) {
  if (!raw || typeof raw !== "object") fail("receipt", "expected object")
  const commandId = text(raw.commandId, "receipt.commandId", {max: 96})
  if (commandId !== expectedCommandId) {
    throw new ProtocolError(`receipt identity mismatch: expected ${expectedCommandId}, got ${commandId}`)
  }
  const status = text(raw.status, "receipt.status", {max: 16})
  if (!RECEIPT_STATUS.has(status)) fail("receipt.status", `unknown status ${status}`)
  const revisionBefore = int(raw.revisionBefore, "receipt.revisionBefore")
  const revisionAfter = int(raw.revisionAfter, "receipt.revisionAfter")
  if (revisionAfter < revisionBefore) fail("receipt.revisionAfter", "revision regressed")
  if (status === "applied" && revisionAfter === revisionBefore) {
    fail("receipt.revisionAfter", "an applied command must advance the revision")
  }
  if (status === "accepted" && revisionAfter !== revisionBefore) {
    fail("receipt.revisionAfter", "an accepted command must not claim a revision change")
  }
  return Object.freeze({
    commandId,
    status,
    revisionBefore,
    revisionAfter,
    ...(raw.issue === undefined ? {} : {issue: text(raw.issue, "receipt.issue", {max: 32})})
  })
}
