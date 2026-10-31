import {ACTION} from "../domain/contract.mjs"
import {candidates} from "../domain/policy.mjs"

const SHOOTERS = new Set(["peashooter", "snowpea", "repeater", "chomper"])

const SPEECH = {
  save: "攒点阳光，等一手。",
  wall: (row) => "第" + row + "路先顶个坚果。",
  shooter: (row) => "第" + row + "路加个输出。",
  sunPlant: () => "补个向日葵。"
}

const countType = (snapshot, type) => snapshot.plants.filter((plant) => plant.type === type).length

/**
 * Deterministic fallback only. PiAgent never receives this candidate list:
 * the LLM proposes its own plant/shovel actions in normal live play.
 */
export class HeuristicAgent {
  constructor({challenge = {}} = {}) {
    this.challenge = challenge
    this.name = "heuristic"
  }

  async decide({snapshot, context = {}}) {
    const challenge = context.challenge ?? this.challenge
    const legal = candidates(snapshot, challenge).filter((action) =>
      action.type === ACTION.PLANT || action.type === ACTION.SHOVEL)
    if (!legal.length) return null

    const threats = [...snapshot.zombies]
      .filter((zombie) => zombie.x < snapshot.columns + 1)
      .sort((a, b) => a.x - b.x)
    const closest = threats[0]
    const sunflowers = countType(snapshot, "sunflower")
    const shootersIn = (row) => snapshot.plants.filter((plant) =>
      plant.row === row && SHOOTERS.has(plant.type)).length
    const wallsIn = (row) => snapshot.plants.filter((plant) =>
      plant.row === row && plant.type === "wallnut").length

    const lost = (row) => threats.some((threat) => threat.row === row && threat.x < 1.5)
    const banned = new Set(challenge.bannedPlants ?? [])
    const available = legal.filter((action) =>
      !(action.type === ACTION.PLANT && banned.has(action.plant)) && !lost(action.row))

    const pick = (predicate) => {
      const action = available.find(predicate)
      return action ? {
        plan: [{
          type: action.type,
          ...(action.plant ? {plant: action.plant} : {}),
          row: action.row,
          col: action.col
        }],
        goal: "保持防线并寻找经济发展机会",
        rationale: "使用确定性规则作为模型不可用时的降级策略。",
        speech: this.#speech(action)
      } : null
    }

    const liveThreats = threats.filter((threat) => !lost(threat.row))

    // Emergency defence is normally handled by the orchestrator. This is a
    // conservative fallback for ordinary lanes when the LLM is unavailable.
    for (const threat of liveThreats) {
      if (threat.x >= 1.5 && threat.x < 3.2 && wallsIn(threat.row) === 0) {
        const wall = pick((action) =>
          action.type === ACTION.PLANT && action.plant === "wallnut" && action.row === threat.row)
        if (wall) return wall
      }
    }

    for (const threat of liveThreats) {
      const desired = threat.x < 6 ? 2 : 1
      if (shootersIn(threat.row) >= desired) continue
      const shooter = pick((action) =>
        action.type === ACTION.PLANT && SHOOTERS.has(action.plant) && action.row === threat.row)
      if (shooter) return shooter
    }

    const economyTarget = Math.min(5, 2 + Math.floor(snapshot.level / 2))
    if (sunflowers < economyTarget) {
      const quiet = pick((action) =>
        action.type === ACTION.PLANT &&
        action.plant === "sunflower" &&
        !threats.some((threat) => threat.row === action.row && threat.x < 5))
      if (quiet) return quiet
    }

    if (closest && shootersIn(closest.row) < 3) {
      const shooter = pick((action) =>
        action.type === ACTION.PLANT && SHOOTERS.has(action.plant) && action.row === closest.row)
      if (shooter) return shooter
    }

    if (snapshot.sun >= 150) {
      const any = pick((action) =>
        action.type === ACTION.PLANT && (SHOOTERS.has(action.plant) || action.plant === "sunflower"))
      if (any) return any
    }

    return null
  }

  #speech(action) {
    if (action.type === ACTION.PLANT) {
      if (action.plant === "wallnut") return SPEECH.wall(action.row)
      if (action.plant === "sunflower") return SPEECH.sunPlant()
      return SPEECH.shooter(action.row)
    }
    return SPEECH.save
  }

  async close() {}
}
