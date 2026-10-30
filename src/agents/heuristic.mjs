import {ACTION} from "../domain/contract.mjs"

const SHOOTERS = new Set(["peashooter", "snowpea"])
const HEAVY = new Set(["bucket", "cone", "gargantuar"])

const SPEECH = {
  sun: "先把阳光收好。",
  save: "攒点阳光，等一手。",
  wall: (row) => `第${row}路先顶个坚果。`,
  shooter: (row) => `第${row}路加个输出。`,
  sunPlant: () => "补个向日葵。",
  next: "这一关拿下，继续。"
}

const countType = (snapshot, type) => snapshot.plants.filter((p) => p.type === type).length

/**
 * Deterministic, offline strategy implementing the same `decide` port as the
 * Pi agent. It encodes a simple but honest plan: economy first, one shooter per
 * threatened row, wallnuts only when a zombie is already close. Returning
 * `null` means "wait" — the controller will bank sun instead of wasting it.
 */
export class HeuristicAgent {
  constructor({challenge = {}} = {}) {
    this.challenge = challenge
    this.name = "heuristic"
  }

  async decide({snapshot, candidates, context = {}}) {
    if (!candidates.length) return null
    if (!candidates.length) return null
    const banned = new Set(context.challenge?.bannedPlants ?? [])
    const threats = [...snapshot.zombies]
      .filter((z) => z.x < snapshot.columns + 1)
      .sort((a, b) => a.x - b.x)
    const closest = threats[0]
    const sunflowers = countType(snapshot, "sunflower")
    const shootersIn = (row) => snapshot.plants.filter((p) => p.row === row && SHOOTERS.has(p.type)).length
    const safeRow = (a) => !threats.some((t) => t.row === a.row && t.x < 6)

    // A lane whose zombie is already chewing on the front plants cannot be
    // saved by feeding it one replacement after another: let the mower work.
    const lost = (row) => threats.some((t) => t.row === row && t.x < 2.6)
    const legal = candidates.filter((a) => !(a.type === ACTION.PLANT && banned.has(a.plant)) && !lost(a.row))

    const pick = (predicate) => {
      const action = legal.find(predicate)
      return action ? {index: candidates.indexOf(action), speech: this.#speech(action, snapshot)} : null
    }

    const nextLevel = pick((a) => a.type === ACTION.NEXT_LEVEL)
    if (nextLevel) return nextLevel

    // 1. A zombie at the door: block it, whatever the economy says.
    if (closest && closest.x >= 2 && closest.x < 3.2) {
      const wall = pick((a) => a.type === ACTION.PLANT && a.plant === "wallnut" && a.row === closest.row)
      if (wall) return wall
    }

    // 2. Every lane with a zombie gets a shooter. If we cannot afford it yet,
    //    wait: saving for coverage beats buying more economy.
    const uncovered = threats.find((t) => shootersIn(t.row) === 0)
    if (uncovered) {
      const shooter = pick((a) => a.type === ACTION.PLANT && SHOOTERS.has(a.plant) && a.row === uncovered.row)
      if (shooter) return shooter
      return null
    }

    // 3. A lane carrying a big zombie needs a second shooter before more economy.
    if (closest && !HEAVY.has(closest.type) === false) {
      const thin = shootersIn(closest.row) < 2
      if (thin) {
        const shooter = pick((a) => a.type === ACTION.PLANT && SHOOTERS.has(a.plant) && a.row === closest.row)
        if (shooter) return shooter
      }
    }

    // 4. Economy, but only in a row that is not under pressure.
    const economyTarget = Math.min(4, 2 + Math.floor(snapshot.level / 3))
    if (sunflowers < economyTarget) {
      const sunflower = pick((a) => a.type === ACTION.PLANT && a.plant === "sunflower" && safeRow(a))
      if (sunflower) return sunflower
    }

    // 5. Deepen the lane closest to the house.
    if (closest) {
      const shooter = pick((a) => a.type === ACTION.PLANT && SHOOTERS.has(a.plant) && a.row === closest.row)
      if (shooter) return shooter
      if (closest.x < 5) {
        const wall = pick((a) => a.type === ACTION.PLANT && a.plant === "wallnut" && a.row === closest.row)
        if (wall) return wall
      }
    }

    // 6. Fall back to the best-scored legal move.
    const fallback = legal[0]
    return fallback ? {index: candidates.indexOf(fallback), speech: this.#speech(fallback, snapshot)} : null
  }

  #speech(action, snapshot) {
    if (action.type === ACTION.NEXT_LEVEL) return SPEECH.next
    if (action.type === ACTION.COLLECT_SUN) return SPEECH.sun
    if (action.type === ACTION.PLANT) {
      if (action.plant === "wallnut") return SPEECH.wall(action.row)
      if (action.plant === "sunflower") return SPEECH.sunPlant()
      return SPEECH.shooter(action.row)
    }
    return SPEECH.save
  }

  async say() {
    return SPEECH.save
  }

  async close() {}
}
