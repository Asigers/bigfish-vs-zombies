import assert from "node:assert/strict"
import test from "node:test"
import {ACTION, STATUS, normalizeSnapshot} from "../src/domain/contract.mjs"
import {ActionExecutor, OUTCOME} from "../src/runtime/executor.mjs"
import {TransportError} from "../src/domain/errors.mjs"
import {snapshot as makeSnapshot, plantAction} from "./helpers.mjs"

function state(overrides = {}) {
  return makeSnapshot({
    revision: 1,
    plants: [],
    zombies: [],
    suns: [],
    cards: [{type: "peashooter", cost: 100, ready: true}],
    sun: 500,
    ...overrides
  })
}

/** Records every wire call and replays a scripted response. */
class ScriptedGame {
  constructor(handler) {
    this.handler = handler
    this.calls = []
  }

  async command(command) {
    this.calls.push(command)
    return this.handler(command, this.calls.length)
  }
}

test("applied commands are only verified from fresh state", async () => {
  const game = new ScriptedGame(async (command) => ({
    commandId: command.commandId, status: "applied", revisionBefore: 1, revisionAfter: 2
  }))
  const executor = new ActionExecutor({game, newId: () => "cmd-1"})

  const first = await executor.submit(state(), plantAction())
  assert.equal(first.outcome, OUTCOME.ACKNOWLEDGED)
  assert.equal(executor.ready, false)

  const pending = await executor.submit(state(), plantAction())
  assert.equal(pending.outcome, OUTCOME.IN_FLIGHT)
  assert.equal(game.calls.length, 1, "a second command must not reach the wire")

  assert.equal(executor.observe(state({revision: 2})), null, "revision advanced but effect absent")
  const verified = executor.observe(normalizeSnapshot({
    ...state({revision: 2, plants: [{type: "peashooter", row: 3, col: 3}]})
  }))
  assert.equal(verified.outcome, OUTCOME.VERIFIED)
  assert.equal(executor.stats.verified, 1)
  assert.equal(executor.ready, true)
})

test("a timeout is ambiguous, never retried, and may still be verified", async () => {
  let applied = false
  const game = new ScriptedGame(async () => {
    if (!applied) {
      applied = true
      throw new TransportError("socket hang up")
    }
    throw new Error("must never be called twice")
  })
  const executor = new ActionExecutor({game, newId: () => "cmd-timeout"})

  const result = await executor.submit(state(), plantAction())
  assert.equal(result.outcome, OUTCOME.AMBIGUOUS)
  assert.equal(executor.stats.ambiguous, 1)
  assert.equal(executor.ready, false)

  // The command did land natively even though the answer was lost.
  const verified = executor.observe(normalizeSnapshot(state({
    revision: 2,
    plants: [{type: "peashooter", row: 3, col: 3}]
  })))
  assert.equal(verified.outcome, OUTCOME.VERIFIED)
  assert.equal(game.calls.length, 1)
})

test("an ambiguous command with no visible effect is abandoned, not replayed", async () => {
  const game = new ScriptedGame(async () => {
    throw new TransportError("timeout")
  })
  const executor = new ActionExecutor({game, newId: () => "cmd-lost", maxAmbiguityRevisions: 2})

  await executor.submit(state(), plantAction())
  assert.equal(executor.observe(state({revision: 2})), null)
  const abandoned = executor.observe(state({revision: 3}))
  assert.equal(abandoned.outcome, OUTCOME.ABANDONED)
  assert.equal(abandoned.reason, "effect_not_observed")
  assert.equal(executor.ready, true)
  assert.equal(game.calls.length, 1)
})

test("rejections surface the engine issue and free the executor", async () => {
  const game = new ScriptedGame(async (command) => ({
    commandId: command.commandId, status: "rejected", issue: "cooldown", revisionBefore: 1, revisionAfter: 1
  }))
  const executor = new ActionExecutor({game, newId: () => "cmd-reject"})
  const result = await executor.submit(state(), plantAction())
  assert.equal(result.outcome, OUTCOME.REJECTED)
  assert.equal(result.issue, "cooldown")
  assert.equal(executor.ready, true)
  assert.equal(executor.stats.rejected, 1)
})

test("illegal actions never reach the engine", async () => {
  const game = new ScriptedGame(async () => {
    throw new Error("must not be called")
  })
  const executor = new ActionExecutor({game, newId: () => "cmd-illegal"})
  const result = await executor.submit(state({sun: 0}), plantAction())
  assert.equal(result.outcome, OUTCOME.REJECTED)
  assert.equal(result.issue, "insufficient_sun")
  assert.equal(game.calls.length, 0)
})

test("stale client state is rejected before the wire", async () => {
  const game = new ScriptedGame(async () => {
    throw new Error("must not be called")
  })
  const executor = new ActionExecutor({game, newId: () => "cmd-stale"})
  const result = await executor.submit(state({revision: 7}), plantAction(6))
  assert.equal(result.outcome, OUTCOME.REJECTED)
  assert.equal(result.issue, "stale_state")
  assert.equal(game.calls.length, 0)
})

test("a collect_sun is confirmed by the sun disappearing", async () => {
  const game = new ScriptedGame(async (command) => ({
    commandId: command.commandId, status: "applied", revisionBefore: 1, revisionAfter: 2
  }))
  const executor = new ActionExecutor({game, newId: () => "cmd-sun"})
  const withSun = state({suns: [{id: "s1", x: 1, y: 1}]})
  await executor.submit(withSun, {type: ACTION.COLLECT_SUN, id: "s1", gameId: "g1", revision: 1})
  const verified = executor.observe(state({revision: 2, suns: []}))
  assert.equal(verified.outcome, OUTCOME.VERIFIED)
})

test("a new game session abandons the pending intent", async () => {
  const game = new ScriptedGame(async () => {
    throw new TransportError("timeout")
  })
  const executor = new ActionExecutor({game, newId: () => "cmd-session"})
  await executor.submit(state(), plantAction())
  const result = executor.observe(state({revision: 2, gameId: "g2"}))
  assert.equal(result.outcome, OUTCOME.ABANDONED)
  assert.equal(result.reason, "engine_changed")
  assert.equal(executor.ready, true)
})

test("next_level is confirmed by a level transition", async () => {
  const game = new ScriptedGame(async (command) => ({
    commandId: command.commandId, status: "applied", revisionBefore: 10, revisionAfter: 11
  }))
  const executor = new ActionExecutor({game, newId: () => "cmd-next"})
  const won = state({revision: 10, level: 2, status: STATUS.WON, zombies: []})
  await executor.submit(won, {type: ACTION.NEXT_LEVEL, gameId: "g1", revision: 10})
  const verified = executor.observe(state({revision: 11, level: 3, status: STATUS.PLAYING}))
  assert.equal(verified.outcome, OUTCOME.VERIFIED)
})
