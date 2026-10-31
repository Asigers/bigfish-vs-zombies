import assert from "node:assert/strict"
import test from "node:test"
import {normalizeDecision, TACTICAL_RULES} from "../src/adapters/pi-agent.mjs"
import {ACTION} from "../src/domain/contract.mjs"

test("Pi brain uses one prompt contract for strategy, plans and speech", () => {
  assert.match(TACTICAL_RULES, /candidate-action menu/)
  assert.match(TACTICAL_RULES, /1 to 5 sequential actions/)
  assert.match(TACTICAL_RULES, /livestream line/)
})

test("model may propose a multi-step plant and shovel plan", () => {
  const result = normalizeDecision({
    goal: "稳住第二路",
    rationale: "二路有重型僵尸",
    plan: [
      {type: "plant", plant: "snowpea", row: 2, col: 4},
      {type: "shovel", row: 2, col: 2}
    ],
    speech: "第二路先稳住！"
  })
  assert.deepEqual(result.plan, [
    {type: ACTION.PLANT, plant: "snowpea", row: 2, col: 4},
    {type: ACTION.SHOVEL, row: 2, col: 2}
  ])
  assert.equal(result.speech, "第二路先稳住！")
})

test("model plan is bounded and action vocabulary is closed", () => {
  assert.throws(() => normalizeDecision({plan: Array.from({length: 6}, () =>
    ({type: "shovel", row: 1, col: 1}))}), /exceeds 5/)
  assert.throws(() => normalizeDecision({plan: [{type: "collect_sun", row: 1, col: 1}]}), /unsupported AI action/)
  assert.throws(() => normalizeDecision({plan: [{type: "plant", plant: "sunflower", row: 1.2, col: 1}]}), /integer row and col/)
  assert.throws(() => normalizeDecision({index: 0}), /plan array/)
})

test("empty plan is a valid deliberate wait", () => {
  assert.deepEqual(normalizeDecision({plan: [], speech: "我先观察一下。"}).plan, [])
})
