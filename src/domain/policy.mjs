import {ACTION, ISSUE, STATUS, validateAction} from "./contract.mjs"

/** Preferred order; the engine decides what is actually available. */
export const PLANT_TYPES = Object.freeze([
  "sunflower", "peashooter", "snowpea", "wallnut", "repeater", "chomper",
  "cherrybomb", "potatomine", "jalapeno", "squash"
])

/** Card types the engine offers this level, preferred first. */
export function plantOrder(snapshot) {
  const available = snapshot.cards.map((card) => card.type)
  const preferred = PLANT_TYPES.filter((type) => available.includes(type))
  const extra = available.filter((type) => !PLANT_TYPES.includes(type))
  return [...preferred, ...extra]
}

/** Rows under pressure, nearest zombie first. */
export function threatRows(snapshot) {
  const byRow = new Map()
  for (const zombie of snapshot.zombies) {
    const current = byRow.get(zombie.row)
    if (current === undefined || zombie.x < current) byRow.set(zombie.row, zombie.x)
  }
  return [...byRow.entries()]
    .map(([row, closestX]) => ({row, closestX}))
    .sort((a, b) => a.closestX - b.closestX)
}

const countPlants = (snapshot, type) => snapshot.plants.filter((p) => p.type === type).length

function placementColumns(snapshot, plant, closestX) {
  if (plant === "wallnut") {
    // A blocker is only useful in front of the nearest zombie: start at the
    // cell it is about to enter and walk back towards the house.
    const limit = Math.min(7, snapshot.columns)
    const front = closestX === undefined
      ? limit
      : Math.min(limit, Math.max(1, Math.ceil(closestX)))
    const columns = []
    for (let col = front; col >= 1; col -= 1) columns.push(col)
    return columns
  }
  const columns = []
  for (let col = 1; col <= Math.min(6, snapshot.columns); col += 1) columns.push(col)
  return columns
}

/**
 * Deterministic priority score for one legal action. Used to order candidate
 * indices for the model and to drive the offline heuristic agent.
 * @returns {number} higher is more urgent
 */
export function scoreAction(snapshot, action) {
  const pressure = threatRows(snapshot)
  switch (action.type) {
    case ACTION.ENTER_ADVENTURE:
    case ACTION.CHOOSE_SEEDS:
    case ACTION.NEXT_LEVEL:
      return 1000
    case ACTION.COLLECT_SUN: {
      const sun = snapshot.suns.find((s) => s.id === action.id)
      const urgency = sun?.expiresInMs === undefined ? 0 : Math.max(0, 60 - sun.expiresInMs / 1000)
      return 900 + urgency
    }
    case ACTION.SHOVEL:
      return 100
    case ACTION.PLANT: {
      const rowThreat = pressure.find((t) => t.row === action.row)
      const closer = rowThreat ? Math.max(0, snapshot.columns + 1 - rowThreat.closestX) : 0
      const front = action.col >= snapshot.columns - 2
      switch (action.plant) {
        case "peashooter": {
          const shooters = countPlants(snapshot, "peashooter") + countPlants(snapshot, "snowpea")
          return 500 + closer * 8 + (rowThreat ? 60 : 0) - shooters * 6 - (front ? 25 : 0)
        }
        case "wallnut": {
          if (!rowThreat) return 120
          return 470 + (rowThreat.closestX < 3 ? 220 : 0) + closer * 4
        }
        case "snowpea": {
          const snow = countPlants(snapshot, "snowpea")
          return 430 + closer * 6 - snow * 60 - (front ? 25 : 0)
        }
        case "sunflower": {
          const sunflowers = countPlants(snapshot, "sunflower")
          const inRow = snapshot.plants.filter((p) => p.row === action.row && p.type === "sunflower").length
          const safe = rowThreat ? 0 : 40
          return 380 + safe + Math.max(0, 5 - sunflowers) * 70 - snapshot.sun / 20 - inRow * 120
        }
        default:
          // Any other seed the engine offers is treated as a usable attacker.
          return 330 + closer * 4 - (front ? 20 : 0)
      }
    }
    default:
      return 0
  }
}

/**
 * Enumerate legal actions for the current snapshot, best first. The list is
 * small on purpose: a model only ever picks an index from this array.
 */
export function candidates(snapshot, challenge = {}) {
  if (snapshot.status === STATUS.MENU) {
    const action = {type: ACTION.ENTER_ADVENTURE, gameId: snapshot.gameId, revision: snapshot.revision}
    return validateAction(snapshot, action) ? [] : [action]
  }
  if (snapshot.status === STATUS.INTRO) {
    const action = {type: ACTION.CHOOSE_SEEDS, gameId: snapshot.gameId, revision: snapshot.revision}
    return validateAction(snapshot, action) ? [] : [action]
  }
  if (snapshot.status === STATUS.WON) {
    if (!snapshot.hasNextLevel) return []
    const action = {type: ACTION.NEXT_LEVEL, gameId: snapshot.gameId, revision: snapshot.revision}
    return validateAction(snapshot, action) ? [] : [action]
  }
  if (snapshot.status !== STATUS.PLAYING) return []

  const out = []
  const seen = new Set()
  const push = (action) => {
    if (validateAction(snapshot, action, challenge)) return
    const key = `${action.type}:${action.plant ?? action.id ?? ""}:${action.row ?? ""}:${action.col ?? ""}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(action)
  }

  for (const sun of snapshot.suns.slice(0, 3)) {
    push({type: ACTION.COLLECT_SUN, id: sun.id, gameId: snapshot.gameId, revision: snapshot.revision})
  }

  const threat = threatRows(snapshot)
  const rows = [...threat.map((t) => t.row)]
  for (let row = 1; row <= snapshot.rows; row += 1) if (!rows.includes(row)) rows.push(row)

  const order = plantOrder(snapshot)
  const shooters = order.filter((type) => type !== "sunflower" && type !== "wallnut")
  const rowPlan = (row, hasThreat) => (hasThreat
    ? [shooters[0], "wallnut", ...shooters.slice(1), "sunflower"].filter(Boolean)
    : ["sunflower", ...shooters.slice(0, 2)])

  for (const row of rows) {
    const rowThreat = threat.find((t) => t.row === row)
    const hasThreat = Boolean(rowThreat)
    for (const plant of rowPlan(row, hasThreat)) {
      for (const col of placementColumns(snapshot, plant, rowThreat?.closestX)) {
        const action = {type: ACTION.PLANT, plant, row, col, gameId: snapshot.gameId, revision: snapshot.revision}
        if (validateAction(snapshot, action, challenge) === null) {
          push(action)
          break
        }
      }
    }
  }

  return out
    .map((action, index) => ({action, index, score: scoreAction(snapshot, action)}))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 12)
    .map((entry) => entry.action)
}

/** The single most urgent legal action, or null. */
export function bestAction(snapshot, challenge = {}) {
  return candidates(snapshot, challenge)[0] ?? null
}

export {ISSUE}
