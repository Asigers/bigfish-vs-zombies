import assert from "node:assert/strict"
import test from "node:test"
import {SimulatedGame} from "../src/adapters/simulated-game.mjs"
import {normalizeSnapshot} from "../src/domain/contract.mjs"
import {ActionExecutor} from "../src/runtime/executor.mjs"
import {HeuristicAgent} from "../src/agents/heuristic.mjs"
import {Orchestrator} from "../src/runtime/orchestrator.mjs"

/**
 * End-to-end contract coverage for the controller: ten deterministic levels,
 * driven by the same executor, journal and policy that talk to the native
 * bridge. Simulator levels are not evidence for the native game (see
 * docs/M0-STATUS.md); they are evidence that the control loop is correct.
 */
function harness({seed = 7, levels = 10, agent = new HeuristicAgent(), tick = 250, config = {}} = {}) {
  const clock = {ms: 0, now() { return this.ms }}
  const sim = new SimulatedGame({seed, levels, now: () => clock.ms})
  const records = []
  const journal = {append: (record) => records.push(record), flush: async () => {}, close: async () => {}}
  let seq = 0
  const executor = new ActionExecutor({game: sim, journal, now: () => clock.ms, newId: () => `cmd-${seq += 1}`})
  const orchestrator = new Orchestrator({
    game: sim,
    agent,
    executor,
    journal,
    clock,
    logger: {info() {}, warn() {}, error() {}, debug() {}},
    config: {targetLevels: levels, ...config}
  })
  const run = async (maxCycles = 20_000) => {
    for (let i = 0; i < maxCycles && !orchestrator.done; i += 1) {
      clock.ms += tick
      await orchestrator.step()
    }
    return orchestrator
  }
  return {clock, sim, executor, orchestrator, journal, records, run}
}

test("the controller clears a full ten-level campaign", async () => {
  const {orchestrator, run} = harness()
  await run()
  assert.equal(orchestrator.finished.reason, "campaign_complete")
  assert.equal(orchestrator.finished.level, 10)
  assert.equal(orchestrator.levels.length, 10)
  assert.deepEqual(orchestrator.levels.map((l) => l.level), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.ok(orchestrator.levels.every((l) => l.cleared), "every level must be cleared")
  assert.equal(orchestrator.stats.rejected, 0, "policy and engine must never disagree")
  assert.equal(orchestrator.stats.ambiguous, 0)
  assert.equal(orchestrator.stats.abandoned, 0)
  assert.equal(orchestrator.executor.pending, null)
})

test("the campaign is deterministic across runs and seeds stay winnable", async () => {
  const first = harness({levels: 3})
  await first.run(8000)
  const second = harness({levels: 3})
  await second.run(8000)
  assert.equal(first.orchestrator.finished.reason, "campaign_complete")
  assert.equal(second.orchestrator.finished.reason, "campaign_complete")
  assert.equal(first.orchestrator.stats.verified, second.orchestrator.stats.verified)

  for (const seed of [11, 42]) {
    const third = harness({seed, levels: 10})
    await third.run(20_000)
    assert.equal(third.orchestrator.finished.reason, "campaign_complete", `seed ${seed} must be winnable`)
  }
})

test("every journaled command resolves exactly once", async () => {
  const {orchestrator, records, run} = harness({levels: 4})
  await run(12_000)
  assert.equal(orchestrator.finished.reason, "campaign_complete")

  const sent = records.filter((r) => r.kind === "command" && r.phase === "sent")
  assert.ok(sent.length > 50, `expected a meaningful number of commands, got ${sent.length}`)
  const ids = sent.map((r) => r.commandId)
  assert.equal(new Set(ids).size, ids.length, "a command id must never be reused or retried")

  const terminal = new Map()
  for (const record of records) {
    if (record.kind !== "command") continue
    if (["verified", "rejected", "abandoned", "precheck_rejected"].includes(record.phase)) {
      if (!record.commandId) continue
      terminal.set(record.commandId, (terminal.get(record.commandId) ?? 0) + 1)
    }
  }
  for (const id of ids) assert.equal(terminal.get(id), 1, `command ${id} must resolve exactly once`)
})

test("sun collection never starves planting", async () => {
  const {orchestrator, run} = harness({levels: 3})
  await run(8000)
  const plants = orchestrator.stats.verified - orchestrator.stats.sunsCollected
  assert.ok(orchestrator.stats.sunsCollected > 10, "sun should be collected")
  assert.ok(plants > 10, `planting must continue while sun is collected (${plants})`)
})

test("an action rejected by the engine is not retried at the same revision", async () => {
  const clock = {ms: 0, now() { return this.ms }}
  // A full lawn leaves exactly one legal cell, so a rejection can only be
  // retried by resending the identical action.
  const plants = []
  for (let row = 1; row <= 5; row += 1) {
    for (let col = 1; col <= 9; col += 1) {
      if (row === 2 && col === 6) continue
      plants.push({type: "sunflower", row, col})
    }
  }
  const base = {
    gameId: "g-reject", level: 2, wave: 0, totalWaves: 3, sun: 500,
    rows: 5, columns: 9, status: "playing", plants,
    zombies: [{type: "normal", row: 2, x: 8, health: 200}], suns: [],
    cards: [{type: "peashooter", cost: 100, ready: true}], blocked: []
  }
  let revision = 10
  const calls = []
  const game = {
    async snapshot() { return normalizeSnapshot({...base, revision}) },
    async command(command) {
      calls.push(command.action)
      return {commandId: command.commandId, status: "rejected", issue: "blocked", revisionBefore: revision, revisionAfter: revision}
    }
  }
  const executor = new ActionExecutor({game, now: () => clock.ms, newId: () => `c${calls.length + 1}`})
  const orchestrator = new Orchestrator({
    game,
    agent: new HeuristicAgent(),
    executor,
    clock,
    logger: {info() {}, warn() {}, error() {}, debug() {}},
    config: {targetLevels: 10}
  })

  for (let i = 0; i < 12; i += 1) {
    clock.ms += 250
    await orchestrator.step()
  }
  assert.equal(calls.length, 1, "the same rejected action must not be resent")
  assert.deepEqual([calls[0].row, calls[0].col], [2, 6])
  assert.equal(orchestrator.stats.rejected, 1)

  // Once the world moves, the same intent becomes legal again.
  revision = 11
  clock.ms += 250
  await orchestrator.step()
  assert.equal(calls.length, 2, "a new revision may retry the intent")
})

test("a lost engine state stops the controller cleanly", async () => {
  const clock = {ms: 0, now() { return this.ms }}
  const playing = {
    gameId: "g-lost", revision: 1, level: 4, wave: 2, totalWaves: 5, sun: 50,
    rows: 5, columns: 9, status: "playing", plants: [], zombies: [], suns: [],
    cards: [], blocked: []
  }
  let reads = 0
  const game = {
    async snapshot() {
      reads += 1
      return normalizeSnapshot({...playing, revision: reads, status: reads > 2 ? "lost" : "playing"})
    },
    async command() { throw new Error("must not be called") }
  }
  const executor = new ActionExecutor({game, now: () => clock.ms})
  const orchestrator = new Orchestrator({
    game,
    agent: {async decide() { return null }},
    executor,
    clock,
    logger: {info() {}, warn() {}, error() {}, debug() {}},
    config: {targetLevels: 10}
  })
  for (let i = 0; i < 5; i += 1) {
    clock.ms += 250
    await orchestrator.step()
  }
  assert.equal(orchestrator.finished.reason, "lost")
  assert.equal(orchestrator.finished.level, 4)
})
