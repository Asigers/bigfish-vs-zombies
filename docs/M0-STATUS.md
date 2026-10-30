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
| 4 | Execute seed selection, plant, collect sun, shovel, next level through game mechanics | 🟡 | seed choice, planting, sun collection and level advance work in the real game; shovel and Crazy-Dave/tutorial edge cases are unit-tested only |
| 5 | Never retry ambiguously acknowledged actions; reconcile with next snapshot | ✅ | `tests/executor.test.mjs` (timeout → ambiguous → verified / abandoned, one wire call), `native/tests/core_test.cpp` (duplicate id never re-applies), live journal shows 0 ambiguous / 0 abandoned across 226+ commands |
| 6 | Pass ≥ 10 levels plus restart/save tests on the Mac | 🟡 | real game: levels **1 and 2 cleared** end-to-end (seed choice → play → next level); 10-level soak + engine save/restart still pending |

## Real-game evidence (2026-10-30, macOS 26.6 / arm64)

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
2. `choose_seeds` — dismissed Crazy Dave, filled the bank deterministically
   (sunflower/peashooter/wallnut/snowpea/repeater…), closed the chooser
   (intro → playing);
3. planted 18–24 plants per level, collected sun, defended lanes;
4. on win, `next_level` advanced the profile and started the next board.

Journal for that run: `verified` equals `sent`, `rejected = 0`,
`ambiguous = 0`, `abandoned = 0`. Two hardware/engine behaviours were found and
fixed on the way:

- seed packets only refresh while **inactive**, so the facade must `Deactivate()`
  before `WasPlanted()` (otherwise every card locks after one use);
- the intro cutscene is frozen while Crazy Dave holds a dialog line; the facade
  now advances/ends it exactly like a click.

## What is actually proven

```bash
npm test          # 48 passing: contract, policy, executor, sim, campaign, journal,
                  #            bridge client, audience, Douyin callback verifier
npm run test:native
                  # clones + patches PvZ-Portable at a pinned commit, builds the
                  # bridge into the game, runs 28 native checks
```

- Ten deterministic simulated levels complete with zero rejected commands, zero
  abandoned intents, no command-id reuse, and every journaled command resolved
  exactly once.
- The native bridge compiles against real upstream headers, so the facade API calls
  are type-correct (not guesses).
- The bridge's protocol, idempotency and revision rules are exercised natively over
  a real loopback socket.

## What is *not* proven yet

1. **Ten consecutive real levels.** Levels 1–2 cleared; the soak run to level 10 is
   the remaining acceptance step, and long sessions may expose new engine edges.
2. **Shovel in the real game.** Implemented (`Plant::Die`) and unit-tested, not yet
   exercised live.
3. **Engine save/restart.** `Board::SaveGame`/`LoadGame` (`.v4`) is untouched; the
   controller has journal recovery (`tests/journal.test.mjs`), the engine path is
   not covered. A stale auto-save from an interrupted session is intentionally
   ignored at bootstrap.
4. **Sun lifetime units.** The facade reports `(GetDisappearTime - counter) * 10 ms`;
   it matches observed behaviour (~7.5 s) but the tick length is an assumption.
5. **Non-adventure modes** (pool/roof/night, conveyor levels, mini-games) are
   untested; the facade assumes the day-lawn grid.

## Blockers and owners

| Blocker | Needs |
|---|---|
| Ten-level soak | ~1 h of unattended play on this Mac; watch for engine edges (graves, huge wave, mowers) |
| Shovel/restart coverage | a scripted real-game scenario per action |
| Douyin official live-play | AppID, approved proposal, IP clearance for derivative game content |

## Next increments (in order)

1. Finish the 10-level soak and record the snapshot stream as a fixture.
2. Replay that fixture against the controller so real-game regressions are testable
   without assets.
3. Cover shovel and engine save/restart with scripted scenarios.
4. Only then claim M0, and move to the M1 gateway.

## Rights

PvZ-Portable is LGPL-3.0-or-later; the assets are not redistributable. Official
Douyin live-play approval for derivative game IP requires IP authorisation and
regulatory documentation; owning the original game does not satisfy that.
