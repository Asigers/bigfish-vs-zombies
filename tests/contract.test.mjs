import assert from "node:assert/strict"
import test from "node:test"
import {
  ACTION,
  ISSUE,
  STATUS,
  compareSnapshots,
  normalizeReceipt,
  normalizeSnapshot,
  snapshotId,
  validateAction,
  viewForModel
} from "../src/domain/contract.mjs"
import {bestAction, candidates} from "../src/domain/policy.mjs"
import {ContractError, ProtocolError} from "../src/domain/errors.mjs"
import {snapshot} from "./helpers.mjs"

test("snapshot projection drops hidden data and bounds arrays", () => {
  const withSecret = snapshot({hiddenWaves: ["boss"], futureSpawns: [1, 2, 3]})
  const view = viewForModel(withSecret)
  assert.equal("hiddenWaves" in view, false)
  assert.equal("futureSpawns" in view, false)
  assert.equal(view.plants.length, 1)
  assert.equal(view.threats[0].row, 3)
  assert.equal(snapshotId(withSecret), "g1@1")
})

test("snapshots reject out-of-contract engine output", () => {
  assert.throws(() => snapshot({rows: 9}), ContractError)
  assert.throws(() => snapshot({status: "exploded"}), ContractError)
  assert.throws(() => snapshot({zombies: [{type: "normal", row: 1, x: 1}]}), ContractError)
  assert.throws(() => snapshot({plants: [
    {type: "sunflower", row: 1, col: 1},
    {type: "wallnut", row: 1, col: 1}
  ]}), ContractError)
  assert.throws(() => snapshot({revision: -1}), ContractError)
})

test("a zombie past the house is still a valid observation", () => {
  const state = snapshot({zombies: [{type: "normal", row: 2, x: -3.4, health: 120}]})
  assert.equal(state.zombies[0].x, -3.4)
  assert.throws(() => snapshot({zombies: [{type: "normal", row: 2, x: -9, health: 120}]}), ContractError)
})

test("revision must never rewind", () => {
  const first = snapshot({revision: 5})
  const second = snapshot({revision: 6})
  assert.equal(compareSnapshots(first, second), "advanced")
  assert.equal(compareSnapshots(first, snapshot({revision: 5})), "same")
  assert.equal(compareSnapshots(first, snapshot({revision: 6, level: 2})), "level_changed")
  assert.throws(() => compareSnapshots(second, first), ContractError)
})

test("actions are validated against the observed state", () => {
  const state = snapshot()
  const plant = {type: ACTION.PLANT, plant: "peashooter", row: 3, col: 3, gameId: "g1", revision: 1}
  assert.equal(validateAction(state, plant), null)
  assert.equal(validateAction(state, {...plant, revision: 0}), ISSUE.STALE_STATE)
  assert.equal(validateAction(state, {...plant, gameId: "other"}), ISSUE.STALE_STATE)
  assert.equal(validateAction(state, {...plant, row: 6}), ISSUE.OUT_OF_BOUNDS)
  assert.equal(validateAction(state, {...plant, row: 2, col: 2}), ISSUE.OCCUPIED)
  assert.equal(validateAction(state, {...plant, plant: "wallnut"}), ISSUE.COOLDOWN)
  assert.equal(validateAction(state, {...plant, plant: "unknown"}), ISSUE.MISSING_CARD)
  assert.equal(validateAction(state, {...plant, plant: "peashooter"}, {bannedPlants: ["peashooter"]}), ISSUE.CHALLENGE_BAN)
  assert.equal(validateAction(snapshot({sun: 10}), plant), ISSUE.INSUFFICIENT_SUN)
  assert.equal(validateAction(state, {type: ACTION.COLLECT_SUN, id: "nope", gameId: "g1", revision: 1}), ISSUE.SUN_MISSING)
  assert.equal(validateAction(state, {type: ACTION.SHOVEL, row: 4, col: 4, gameId: "g1", revision: 1}), ISSUE.NO_PLANT)
  assert.equal(validateAction(state, {type: ACTION.SHOVEL, row: 2, col: 2, gameId: "g1", revision: 1}), null)
  assert.equal(validateAction(snapshot({status: STATUS.WON}), plant), ISSUE.NOT_PLAYING)
})

test("menu and seed-chooser have exactly one legal bootstrap action", () => {
  const menu = snapshot({status: STATUS.MENU})
  assert.deepEqual(candidates(menu).map((a) => a.type), [ACTION.ENTER_ADVENTURE])
  assert.equal(validateAction(menu, {type: ACTION.CHOOSE_SEEDS, gameId: "g1", revision: 1}), ISSUE.NOT_PLAYING)
  assert.equal(validateAction(menu, {type: ACTION.NEXT_LEVEL, gameId: "g1", revision: 1}), ISSUE.NOT_PLAYING)

  const intro = snapshot({status: STATUS.INTRO})
  assert.deepEqual(candidates(intro).map((a) => a.type), [ACTION.CHOOSE_SEEDS])
  assert.equal(validateAction(intro, {type: ACTION.ENTER_ADVENTURE, gameId: "g1", revision: 1}), ISSUE.NOT_PLAYING)

  const playing = snapshot()
  assert.equal(validateAction(playing, {type: ACTION.ENTER_ADVENTURE, gameId: "g1", revision: 1}), ISSUE.NOT_PLAYING)
  assert.equal(validateAction(playing, {type: ACTION.CHOOSE_SEEDS, gameId: "g1", revision: 1}), ISSUE.NOT_PLAYING)
})

test("next_level is only legal after a win", () => {
  const won = snapshot({status: STATUS.WON, hasNextLevel: true})
  assert.equal(validateAction(won, {type: ACTION.NEXT_LEVEL, gameId: "g1", revision: 1}), null)
  assert.equal(candidates(won).length, 1)
  const finished = snapshot({status: STATUS.WON, hasNextLevel: false})
  assert.equal(candidates(finished).length, 0)
})

test("candidate list is bounded, legal, and prioritised", () => {
  const state = snapshot({
    zombies: [
      {type: "normal", row: 3, x: 2.4, health: 200},
      {type: "cone", row: 5, x: 8.9, health: 560}
    ]
  })
  const offered = candidates(state)
  assert.ok(offered.length > 0)
  assert.ok(offered.length <= 12)
  for (const action of offered) assert.equal(validateAction(state, action), null)
  assert.equal(offered[0].type, ACTION.COLLECT_SUN)

  const blocked = candidates(state, {bannedPlants: ["peashooter", "snowpea", "sunflower", "wallnut"]})
  assert.deepEqual(blocked.map((a) => a.type), [ACTION.COLLECT_SUN])
  assert.ok(bestAction(state))
})

test("wallnuts are offered in front of the nearest zombie", () => {
  const state = snapshot({
    zombies: [{type: "normal", row: 3, x: 6.4, health: 200}],
    cards: [
      {type: "peashooter", cost: 100, ready: true},
      {type: "wallnut", cost: 50, ready: true}
    ]
  })
  const walls = candidates(state).filter((a) => a.type === ACTION.PLANT && a.plant === "wallnut")
  assert.ok(walls.length > 0)
  assert.equal(walls[0].col, 7)
  assert.equal(walls[0].row, 3)
})

test("receipts are checked for identity and monotonic revisions", () => {
  const receipt = normalizeReceipt({
    commandId: "c1", status: "applied", revisionBefore: 3, revisionAfter: 4
  }, "c1")
  assert.equal(receipt.status, "applied")
  assert.throws(() => normalizeReceipt({
    commandId: "c2", status: "applied", revisionBefore: 3, revisionAfter: 4
  }, "c1"), ProtocolError)
  assert.throws(() => normalizeReceipt({
    commandId: "c1", status: "applied", revisionBefore: 4, revisionAfter: 4
  }, "c1"), ContractError)
  const accepted = normalizeReceipt({
    commandId: "c1", status: "accepted", revisionBefore: 4, revisionAfter: 4
  }, "c1")
  assert.equal(accepted.status, "accepted")
  assert.throws(() => normalizeReceipt({
    commandId: "c1", status: "accepted", revisionBefore: 4, revisionAfter: 5
  }, "c1"), ContractError)
  assert.throws(() => normalizeReceipt({
    commandId: "c1", status: "maybe", revisionBefore: 4, revisionAfter: 4
  }, "c1"), ContractError)
})

test("conveyor banks hand out free seeds", () => {
  const conveyor = snapshot({sun: 0, freeSeeds: true, cards: [{type: "wallnut", cost: 50, ready: true}]})
  assert.equal(validateAction(conveyor, {type: ACTION.PLANT, plant: "wallnut", row: 1, col: 1, gameId: "g1", revision: 1}), null)
  assert.ok(candidates(conveyor).some((a) => a.type === ACTION.PLANT))
  const paid = snapshot({sun: 0, cards: [{type: "wallnut", cost: 50, ready: true}]})
  assert.equal(validateAction(paid, {type: ACTION.PLANT, plant: "wallnut", row: 1, col: 1, gameId: "g1", revision: 1}), ISSUE.INSUFFICIENT_SUN)
})
