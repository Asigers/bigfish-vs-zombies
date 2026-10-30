# M0 status

Honest gate state, with the exact evidence available on this machine
(macOS 26.6, Apple Silicon arm64, Node 22.23, clang 17, cmake 4.4.5).

Legend: ✅ verified · 🟡 implemented, not runtime-verified · ⛔ blocked.

## Gate table

| # | M0 requirement | State | Evidence / blocker |
|---|---|---|---|
| 1 | Build PvZ-Portable on this Apple Silicon Mac | ✅ | upstream `4585876` builds with clang 17 / Ninja; `pvz-portable` is a 3.7 MB arm64 Mach-O |
| 2 | Run it with legally sourced GOTY assets | ⛔ | no `main.pak` / `properties/` on this machine; the game exits with `Resource file not found: properties/resources.xml` |
| 3 | Embed a game-thread bridge with revisioned snapshots | 🟡 | `native/BridgeCore` + `PvzFacade` compile and link into the game (28 bridge symbols in the binary); no frame has run without assets |
| 4 | Execute seed selection, plant, collect sun, shovel, next level through game mechanics | 🟡 | facade calls `CanPlantAt`/`TakeSunMoney`/`AddPlant`/`SeedPacket::WasPlanted`, `Coin::Collect`, `Plant::Die`, `UpdatePlayerProfileForFinishingLevel` + `NewGame`; all compile; seed-chooser automation is **not** implemented |
| 5 | Never retry ambiguously acknowledged actions; reconcile with next snapshot | ✅ | `tests/executor.test.mjs` (timeout → ambiguous → verified / abandoned, one wire call), `native/tests/core_test.cpp` (duplicate id never re-applies) |
| 6 | Pass ≥ 10 levels plus restart/save tests on the Mac | ⛔ | controller passes 10 deterministically **in the simulator** (`tests/campaign.test.mjs`); the real-game run requires gate 2 |

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

## What is *not* proven

1. **No frame of the real game has been driven by the bridge.** Without assets the
   process stops during resource loading, before `LawnApp::UpdateFrames` runs.
2. **Seed selection is not automated.** PvZ shows a seed chooser before each level;
   the bridge currently cannot dismiss it, so a real run needs a manual seed choice
   (or the next incremental feature).
3. **`next_level` is unverified in-game.** It calls the same profile bookkeeping as
   the award screen and then `NewGame()`, but that path has never executed.
4. **No save/load or restart test on the real engine.** `PvZ-Portable` has a
   mid-level `.v4` save format; the controller has journal-based restart recovery
   (`tests/journal.test.mjs`) but the engine-side path is untested.
5. **Sun lifetime is not projected.** `expiresInMs` is omitted by the facade; the
   controller treats it as unknown, which is safe but less efficient.

## Blockers and owners

| Blocker | Needs |
|---|---|
| GOTY assets | a legally purchased copy; place `main.pak` + `properties/` beside the binary |
| Seed chooser | ~150 lines: drive `SeedChooserScreen` (or a `-bridge-seeds` config in the facade) |
| Real-game verification | an interactive session on this Mac with assets present |
| Douyin official live-play | AppID, approved proposal, IP clearance for derivative game content |

## Next increments (in order)

1. Automate seed selection so a level can start headless.
2. Run one real level end to end with assets; record the snapshot stream as a fixture.
3. Replay that fixture against the controller (no assets needed afterwards) to make
   real-game regressions testable in CI.
4. Only then claim M0, and move to the M1 gateway.

## Rights

PvZ-Portable is LGPL-3.0-or-later; the assets are not redistributable. Official
Douyin live-play approval for derivative game IP requires IP authorisation and
regulatory documentation; owning the original game does not satisfy that.
