# BigFish vs Zombies

Mac-first autonomous **Plants vs. Zombies** streamer: BigFish (a Pi-powered on-air
character) plays PvZ-Portable through a closed control loop while audience votes and
challenges change real, verified gameplay.

**Status: the controller plays the real game.** With a purchased PvZ GOTY asset set
on this Mac it boots PvZ-Portable, chooses seeds, plants, collects sun and advances
levels without human input (levels 1–2 cleared end to end so far). See
[docs/M0-STATUS.md](docs/M0-STATUS.md) for gate-by-gate evidence.

## What works today

| Layer | State | Evidence |
|---|---|---|
| Control loop, policy, executor, journal | working | 48 Node tests |
| Native bridge protocol + HTTP server | working | 32 native checks |
| PvZ-Portable facade (plant/sun/shovel/next level) | compiles against upstream headers | `scripts/native-check.sh` |
| Simulated 10-level campaign, end to end | passes | `tests/campaign.test.mjs` |
| Real-game levels 1–2 (seed choice → win → next level) | cleared unattended | `docs/M0-STATUS.md` |
| Real game on this Mac | **working**: boots, plays, clears levels | `docs/M0-STATUS.md` |
| Douyin gateway, OBS/Live2D, TTS | not implemented | `docs/ARCHITECTURE.md` |

## Quick start

```bash
npm test                    # Node contract, executor, sim, campaign, bridge tests (50)
npm run sim                 # offline 10-level campaign (virtual clock, no assets)
npm run sim -- --seed=11    # deterministic scenario variant

# Verify the bridge and compile it into PvZ-Portable (needs cmake + ninja + git):
npm run test:native         # clones upstream at a pinned commit, patches, builds, tests
```

Run against a real game once assets exist:

```bash
# 1) bridge-enabled game binary from npm run test:native
BIGFISH_BRIDGE_TOKEN="$(openssl rand -hex 24)" \
  native/vendor/build/pvz-portable -resdir "/path/to/GOTY" &
# 2) controller
BIGFISH_BRIDGE_TOKEN="<same token>" \
  node src/main.mjs --engine=bridge --agent=heuristic
```

`--agent=pi` swaps the deterministic strategy for the isolated, tool-free Pi
sessions. See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Layout

```
src/
  domain/        contract (snapshot/action/receipt), policy (legal actions), errors
  runtime/       executor (at-most-once), orchestrator (control cycle),
                 tick-loop, journal, audience
  adapters/      bridge-client (native HTTP), simulated-game, pi-agent, douyin
  agents/        heuristic offline strategy
  main.mjs       entrypoint (sim | bridge, heuristic | pi)
native/
  Protocol.h     wire contract, issue codes, snapshot structs
  BridgeCore     revisioning, command queue, idempotency (game-agnostic, unit-tested)
  HttpServer     127.0.0.1-only HTTP/1.1 + bearer token
  PvzFacade      PvZ-Portable implementation on the game thread
  Module         two-line hook into LawnApp::UpdateFrames
  patches/       version-pinned upstream patch
tests/           contract, executor, sim, campaign, journal, bridge client, audience
docs/            architecture, bridge protocol, M0 status, runbook
```

## Design rules

1. The game engine is the only authority. The controller never mutates memory.
2. A command is **at most once**. After a timeout the intent stays pending until a
   fresh snapshot proves or disproves it; the old command id is never replayed.
3. The model may only pick an index from an enumerated legal-action list; audience
   constraints are re-enforced by policy, executor *and* the native bridge.
4. Everything the model sees is a bounded, frozen projection. No future waves, no
   filesystem, no raw chat as instructions.
5. Every attempt is journaled with its command id, revision and outcome.

## Rights and assets

This repository contains **no** PopCap/EA assets. PvZ-Portable (LGPL-3.0-or-later)
requires `main.pak` and `properties/` from a legally purchased copy of PvZ GOTY.
Douyin live-play approval for derivative game IP requires separate IP/regulatory
clearance; owning the game files is not sufficient. Live2D art licensing must be
cleared before monetized streaming.
