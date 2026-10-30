import assert from "node:assert/strict"
import test from "node:test"
import {ACTION, STATUS} from "../src/domain/contract.mjs"
import {SimulatedGame, levelPlan} from "../src/adapters/simulated-game.mjs"

function clocked(seed = 7, levels = 10) {
  const clock = {ms: 0, now() { return this.ms }}
  const sim = new SimulatedGame({seed, levels, now: () => clock.ms})
  return {clock, sim}
}

test("the same seed reproduces the same scenario", async () => {
  const a = clocked(11, 3)
  const b = clocked(11, 3)
  for (let step = 0; step < 60; step += 1) {
    a.clock.ms += 500
    b.clock.ms += 500
    assert.deepEqual(a.sim.snapshot(), b.sim.snapshot())
  }
})

test("planting debits sun, sets the cooldown and appears in the snapshot", async () => {
  const {sim} = clocked()
  const before = sim.snapshot()
  const action = {type: ACTION.PLANT, plant: "sunflower", row: 1, col: 1, gameId: before.gameId, revision: before.revision}
  const receipt = await sim.command({commandId: "c1", expectedRevision: before.revision, action})
  assert.equal(receipt.status, "applied")
  const after = sim.snapshot()
  assert.equal(after.sun, before.sun - 50)
  assert.equal(after.plants.length, 1)
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.cards.find((c) => c.type === "sunflower").ready, false)
})

test("commands are idempotent by command id and never apply twice", async () => {
  const {sim} = clocked()
  const before = sim.snapshot()
  const action = {type: ACTION.PLANT, plant: "sunflower", row: 1, col: 1, gameId: before.gameId, revision: before.revision}
  const first = await sim.command({commandId: "once", expectedRevision: before.revision, action})
  const second = await sim.command({commandId: "once", expectedRevision: before.revision, action})
  assert.equal(first.status, "applied")
  assert.equal(second.status, "duplicate")
  assert.equal(sim.snapshot().plants.length, 1)
})

test("illegal commands are rejected with a stable issue code", async () => {
  const {sim} = clocked()
  const before = sim.snapshot()
  const base = {gameId: before.gameId, revision: before.revision}
  const reject = (commandId, action) => sim.command({commandId, expectedRevision: before.revision, action})

  assert.equal((await reject("a", {type: ACTION.PLANT, plant: "sunflower", row: 1, col: 1, ...base})).status, "applied")
  const occupied = await reject("b", {type: ACTION.PLANT, plant: "sunflower", row: 1, col: 1, ...base})
  assert.equal(occupied.status, "rejected")
  assert.equal(occupied.issue, "occupied")

  const future = await sim.command({
    commandId: "c",
    expectedRevision: 99,
    action: {type: ACTION.PLANT, plant: "peashooter", row: 2, col: 2, ...base, revision: 99}
  })
  assert.equal(future.status, "rejected")
  assert.equal(future.issue, "future_state")

  const missingSun = await reject("d", {type: ACTION.COLLECT_SUN, id: "nope", ...base})
  assert.equal(missingSun.issue, "sun_missing")
})

test("collecting a sun raises the bank and removes the sun", async () => {
  const {clock, sim} = clocked()
  clock.ms += 12_000
  const before = sim.snapshot()
  assert.ok(before.suns.length > 0, "sky sun should have fallen")
  const sun = before.suns[0]
  const receipt = await sim.command({
    commandId: "sun",
    expectedRevision: before.revision,
    action: {type: ACTION.COLLECT_SUN, id: sun.id, gameId: before.gameId, revision: before.revision}
  })
  assert.equal(receipt.status, "applied")
  const after = sim.snapshot()
  assert.equal(after.sun, before.sun + 25)
  assert.equal(after.suns.some((s) => s.id === sun.id), false)
})

test("a zombie past the last mower loses the level", async () => {
  const {clock, sim} = clocked(7, 10)
  clock.ms += 1000
  sim.state.mowers = [false, false, false, false, false]
  sim.state.zombies.push({id: "z-test", type: "normal", row: 3, x: 0.3, hp: 200, slowMs: 0, eating: false, dead: false})
  clock.ms += 4000
  assert.equal(sim.snapshot().status, STATUS.LOST)
})

test("a cleared level only advances when next_level is commanded", async () => {
  const {clock, sim} = clocked(7, 3)
  // Drive the first level to completion with the reference agent.
  const {ActionExecutor} = await import("../src/runtime/executor.mjs")
  const {HeuristicAgent} = await import("../src/agents/heuristic.mjs")
  const {Orchestrator} = await import("../src/runtime/orchestrator.mjs")
  const executor = new ActionExecutor({game: sim, now: () => clock.ms})
  const orchestrator = new Orchestrator({
    game: sim,
    agent: new HeuristicAgent(),
    executor,
    clock,
    logger: {info() {}, warn() {}, error() {}, debug() {}},
    config: {targetLevels: 3}
  })
  for (let i = 0; i < 6000 && !orchestrator.done; i += 1) {
    clock.ms += 250
    await orchestrator.step()
  }
  assert.equal(orchestrator.finished.reason, "campaign_complete")
  assert.deepEqual(orchestrator.levels.map((l) => l.level), [1, 2, 3])
  assert.ok(orchestrator.levels.every((l) => l.cleared))
})

test("level plans grow with the level and stay bounded", () => {
  for (let level = 1; level <= 10; level += 1) {
    const plan = levelPlan(level)
    assert.ok(plan.totalWaves >= 2 && plan.totalWaves <= 6)
    assert.ok(plan.perWave >= 1 && plan.perWave <= 3)
    assert.ok(plan.pool.length >= 1)
    assert.ok(plan.waveIntervalMs >= 16_000)
  }
  assert.ok(levelPlan(10).pool.includes("bucket"))
})

test("an exported level resumes exactly where it stopped", async () => {
  const {clock, sim} = clocked(7, 2)
  clock.ms += 20_000
  const before = sim.snapshot()
  const saved = sim.exportState()
  const restored = SimulatedGame.restore(saved, {now: () => clock.ms})
  assert.deepEqual(restored.snapshot(), before)

  for (let i = 0; i < 40; i += 1) {
    clock.ms += 500
    assert.deepEqual(restored.snapshot(), sim.snapshot())
  }
})
