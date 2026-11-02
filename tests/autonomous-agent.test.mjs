import assert from "node:assert/strict"
import test from "node:test"
import {normalizeDecision, normalizeDeckDecision, TACTICAL_RULES} from "../src/adapters/pi-agent.mjs"
import {ACTION} from "../src/domain/contract.mjs"

test("Pi brain uses one prompt contract for strategy, plans and speech", () => {
  assert.match(TACTICAL_RULES, /candidate-action menu/)
  assert.match(TACTICAL_RULES, /0 to 5 sequential actions/)
  assert.match(TACTICAL_RULES, /livestream line in speech/)
  assert.match(TACTICAL_RULES, /complete ordered seed deck/)
  assert.match(TACTICAL_RULES, /never substitutes a default deck/)
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

test("Pi deck selection is complete, ordered and respects engine requirements", () => {
  const seedChooser = {
    active: true,
    ready: true,
    slots: 3,
    availablePlants: [
      {type: "sunflower", cost: 50, recommended: true, warnings: [], requirements: []},
      {type: "peashooter", cost: 100, recommended: true, warnings: [], requirements: []},
      {type: "repeater", cost: 200, recommended: true, warnings: [], requirements: []},
      {type: "gatlingpea", cost: 250, recommended: false, warnings: [], requirements: ["repeater"]}
    ],
    preselected: ["sunflower"],
    required: ["sunflower"]
  }
  const result = normalizeDeckDecision({
    plants: ["sunflower", "peashooter", "repeater"],
    strategy: "经济与输出平衡",
    speech: "先搭建稳定的经济。"
  }, {seedChooser})
  assert.deepEqual(result.plants, ["sunflower", "peashooter", "repeater"])
  assert.equal(result.strategy, "经济与输出平衡")
  assert.throws(() => normalizeDeckDecision({
    plants: ["sunflower", "peashooter", "gatlingpea"]
  }, {seedChooser}), /requires repeater/)
  assert.throws(() => normalizeDeckDecision({
    plants: ["peashooter", "repeater", "gatlingpea"]
  }, {seedChooser}), /mandatory tutorial plant/)
  assert.throws(() => normalizeDeckDecision({
    plants: ["sunflower", "peashooter", "peashooter"]
  }, {seedChooser}), /duplicate/)
  assert.throws(() => normalizeDeckDecision({
    plants: ["sunflower", "peashooter", "repeater"]
  }, {seedChooser, challenge: {bannedPlants: ["repeater"]}}), /challenge-banned/)
})
