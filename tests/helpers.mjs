import {STATUS, normalizeSnapshot} from "../src/domain/contract.mjs"

/** Minimal legal snapshot for unit tests. */
export function snapshot(overrides = {}) {
  return normalizeSnapshot({
    gameId: "g1",
    revision: 1,
    level: 1,
    wave: 0,
    totalWaves: 3,
    sun: 150,
    rows: 5,
    columns: 9,
    status: STATUS.PLAYING,
    plants: [{type: "sunflower", row: 2, col: 2}],
    zombies: [{type: "normal", row: 3, x: 7.5, health: 200}],
    suns: [{id: "s1", x: 3, y: 2, expiresInMs: 8000}],
    cards: [
      {type: "peashooter", cost: 100, ready: true},
      {type: "sunflower", cost: 50, ready: true},
      {type: "wallnut", cost: 50, ready: false}
    ],
    blocked: [],
    ...overrides
  })
}

export const plantAction = (revision = 1) => ({
  type: "plant", plant: "peashooter", row: 3, col: 3, gameId: "g1", revision
})
