import {ACTION} from "../domain/contract.mjs"

const SHOOTERS = new Set(["peashooter", "snowpea", "repeater", "chomper"])
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
    const wallsIn = (row) => snapshot.plants.filter((p) => p.row === row && p.type === "wallnut").length

    // Only a lane that is literally at the mower is written off; everything
    // else still deserves a shooter.
    const lost = (row) => threats.some((t) => t.row === row && t.x < 1.5)
    const legal = candidates.filter((a) => !(a.type === ACTION.PLANT && banned.has(a.plant)) && !lost(a.row))

    const pick = (predicate) => {
      const action = legal.find(predicate)
      return action ? {index: candidates.indexOf(action), speech: this.#speech(action, snapshot)} : null
    }

    const nextLevel = pick((a) => a.type === ACTION.NEXT_LEVEL)
    if (nextLevel) return nextLevel

    const liveThreats = threats.filter((t) => !lost(t.row))

    // 1. Block the door when a lane has nothing to shoot with yet.
    if (closest && closest.x >= 1.5 && closest.x < 3.2 && wallsIn(closest.row) === 0) {
      const wall = pick((a) => a.type === ACTION.PLANT && a.plant === "wallnut" && a.row === closest.row)
      if (wall) return wall
    }

    // 2. Firepower first: every live lane wants one shooter, two once a zombie
    //    is within six cells. Closest lane wins when sun is tight.
    for (const threat of liveThreats) {
      const desired = threat.x < 6 ? 2 : 1
      if (shootersIn(threat.row) >= desired) continue
      const shooter = pick((a) => a.type === ACTION.PLANT && SHOOTERS.has(a.plant) && a.row === threat.row)
      if (shooter) return shooter
    }

    // 3. Economy, preferring lanes without a zombie in the front half.
    const economyTarget = Math.min(5, 2 + Math.floor(snapshot.level / 2))
    if (sunflowers < economyTarget) {
      const quiet = pick((a) => a.type === ACTION.PLANT && a.plant === "sunflower" &&
        !threats.some((t) => t.row === a.row && t.x < 5))
      if (quiet) return quiet
    }

    // 4. Deepen the front lane before the wave stacks up.
    if (closest && shootersIn(closest.row) < 3) {
      const shooter = pick((a) => a.type === ACTION.PLANT && SHOOTERS.has(a.plant) && a.row === closest.row)
      if (shooter) return shooter
    }

    // 5. Sun is piling up: convert it into firepower or economy.
    if (snapshot.sun >= 150) {
      const any = pick((a) => a.type === ACTION.PLANT && (SHOOTERS.has(a.plant) || a.plant === "sunflower"))
      if (any) return any
    }

    // 6. Nothing worth buying: wait. Sun collection is the controller's lane,
    //    never a "choice" here, so the agent cannot silently skip defence.
    return null
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
