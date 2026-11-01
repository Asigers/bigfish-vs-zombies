# M0 status

Honest gate state, with the exact evidence available on this machine
(macOS 26.6, Apple Silicon arm64, Node 22.23, clang 17, cmake 4.4.5).

Legend: ✅ verified · 🟡 implemented, not runtime-verified · ⛔ blocked.

## Gate table

| # | M0 requirement | State | Evidence / blocker |
|---|---|---|---|
| 1 | Build PvZ-Portable on this Apple Silicon Mac | ✅ | upstream `4585876` builds with clang 17 / Ninja; `pvz-portable` is a 3.7 MB arm64 Mach-O |
| 2 | Run it with legally sourced GOTY assets | ✅ | Steam GOTY 1.2.0.1096 assets load (`Resource Loading Time ~1.2s`), title screen and level 1 render |
| 3 | Embed a game-thread bridge with revisioned snapshots | ✅ | bridge serves `health`/`snapshot`/`command` from the live game; snapshots track sun, plants, zombies, cards, cutscene state |
| 4 | Model-selected seed deck and game actions | 🟡 | Controller CI passes 69/69 tests; native bridge tests pass and the pinned PvZ-Portable target compiles in CI; model-selected decks still need live-game verification |
| 5 | Never retry ambiguously acknowledged actions; reconcile with next snapshot | ✅ | `tests/executor.test.mjs` (timeout → ambiguous → verified / abandoned, one wire call), `native/tests/core_test.cpp` (duplicate id never re-applies), live journal shows 0 ambiguous / 0 abandoned across 226+ commands |
| 6 | Pass ≥ 10 levels plus restart/save tests on the Mac | 🟡 | real game: levels **1 and 2 cleared** end-to-end (seed choice → play → next level); 10-level soak + engine save/restart still pending |

## Real-game evidence before the current seed-deck refactor (2026-10-30, macOS 26.6 / arm64)

Controller against the live game (`--engine=bridge --tick=300`), assets from a
purchased Steam copy, bridge token kept local:

```
level 1 cleared in 393.3s (106 commands)
level 2 cleared in 356.4s (120 commands)
level 3 … running
```

Per level the controller performed, with no human input:

1. `enter_adventure` — created the bot profile, skipped the first-time tutorial,
   built the board (menu → intro);
2. `choose_seeds` — the previous live implementation dismissed Crazy Dave and
   filled the bank deterministically (sunflower/peashooter/wallnut/snowpea/repeater…)
   before closing the chooser (intro → playing); the current refactor replaces this
   fixed deck with a model-selected ordered deck.
3. planted 18–24 plants per level, collected sun, defended lanes;
4. on win, `next_level` advanced the profile and started the next board.

Journal for that run: `verified` equals `sent`, `rejected = 0`,
`ambiguous = 0`, `abandoned = 0`. Two hardware/engine behaviours were found and
fixed on the way:

- seed packets only refresh while **inactive**, so the facade must `Deactivate()`
  before `WasPlanted()` (otherwise every card locks after one use);
- the intro cutscene is frozen while Crazy Dave holds a dialog line; the facade
  now advances/ends it exactly like a click.

## Current refactor CI evidence (2026-11-01)

GitHub Actions passed both jobs on commit
`bc4ddd650b37ef6f6c8520f4d6afe46fc981940a`:

- **Controller:** `npm test` passed all 69 tests, including the deterministic
  campaign, model-selected deck validation, per-level deck history, Survival repicks, rejection/retry and speech tests.
- **Native:** bridge protocol/idempotency tests passed and the
  `pvz-portable` target compiled against the pinned upstream source and headers.

This proves the controller suite and native build are green. The CI runner has no
game assets and cannot prove that a live game exposes the chooser correctly or
that the model-selected ordered deck appears in the real seed bank.

The existing level 1–2 live evidence predates the current model-selected seed-deck
refactor. It does not validate the new chooser snapshot, deck selection or ordered
seed-bank application.

## What is *not* proven yet

1. **Live model-selected deck.** The chooser snapshot, LLM deck decision and
   ordered seed-bank application pass CI but have not been exercised in the real
   game with Pi credentials. Verify the normal adventure chooser and a Survival
   repick, including the visible card order.
2. **Ten consecutive real levels.** Levels 1–2 cleared before this refactor; the
   soak run to level 10 remains pending, and long sessions may expose new engine
   edges.
3. **Shovel in the real game.** Implemented (`Plant::Die`) and unit-tested, not yet
   exercised live.
4. **Engine save/restart.** `Board::SaveGame`/`LoadGame` (`.v4`) is untouched; the
   controller has journal recovery (`tests/journal.test.mjs`), the engine path is
   not covered. A stale auto-save from an interrupted session is intentionally
   ignored at bootstrap.
5. **Sun lifetime units.** The facade reports `(GetDisappearTime - counter) * 10 ms`;
   it matches observed behaviour (~7.5 s) but the tick length is an assumption.
6. **Non-adventure modes** (pool/roof/night, conveyor levels, mini-games) are
   untested; the facade assumes the day-lawn grid.

## Blockers and owners

| Blocker | Needs |
|---|---|
| Ten-level soak | ~1 h of unattended play on this Mac; watch for engine edges (graves, huge wave, mowers) |
| Shovel/restart coverage | a scripted real-game scenario per action |
| Douyin official live-play | AppID, approved proposal, IP clearance for derivative game content |

## Next increments (in order)

1. Run the live model-selected deck smoke test: normal chooser, visible ordered
   seed bank, then a Survival repick; preserve the journal and snapshots.
2. Finish the 10-level soak and record the snapshot stream as a fixture.
3. Replay that fixture against the controller so real-game regressions are testable
   without assets.
4. Cover shovel and engine save/restart with scripted scenarios.
5. Only then claim M0, and move to the M1 gateway.

## Rights

PvZ-Portable is LGPL-3.0-or-later; the assets are not redistributable. Official
Douyin live-play approval for derivative game IP requires IP authorisation and
regulatory documentation; owning the original game does not satisfy that.
