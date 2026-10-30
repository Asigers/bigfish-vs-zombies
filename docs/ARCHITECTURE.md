# Architecture

Status: control layer implemented and tested; native bridge implemented and
compiled into PvZ-Portable; real-game acceptance blocked (see M0-STATUS.md).

## 1. Layers

```
┌──────────────────────────────────────────────────────────────┐
│ presentation (not built yet)                                 │
│   OBS scene, Live2D overlay, TTS, vote widget                │
└───────────────▲──────────────────────────────────────────────┘
                │ events: narration, vote, command_verified
┌───────────────┴──────────────────────────────────────────────┐
│ controller (Node 22)                                          │
│                                                               │
│  Orchestrator ── one bounded cycle ──────────────────────┐    │
│   1 read snapshot (retryable, bounded)                   │    │
│   2 reconcile pending command against fresh state        │    │
│   3 terminal states: lost / won / level advance          │    │
│   4 urgent sun → emergency defence → agent → bank sun    │    │
│                                                          │    │
│  ActionExecutor: single-flight, at-most-once, verified   │    │
│  Policy: legal action enumeration, scoring, validation   │    │
│  Journal: append-only JSONL audit + restart recovery     │    │
│  AudienceDirector: polls, dedupe, challenges             │    │
└───────────────▲──────────────────────────────────────────────┘
                │ HTTP/1.1 on 127.0.0.1, bearer token
┌───────────────┴──────────────────────────────────────────────┐
│ native bridge (inside the game process)                      │
│  HttpServer  ─ parse, authenticate, enqueue, wait            │
│  BridgeCore  ─ revision, dedupe by commandId, receipts,      │
│                at most ONE command per game frame            │
│  PvzFacade   ─ Capture() + engine calls on the game thread   │
│  hook        ─ bigfish::PumpBridge(this) in UpdateFrames()   │
└───────────────▲──────────────────────────────────────────────┘
                │ in-process calls only
        PvZ-Portable (engine, renderer, collision, waves, saves)
```

Two rules make the topology safe:

- **The Mac bridge only listens on loopback.** There is no inbound path from the
  internet, and the token is required on every request.
- **The game thread owns all state.** HTTP threads never touch a `Board`; they can
  only enqueue a command and wait for the game thread's receipt.

## 2. Control cycle

`Orchestrator.step()` is the only place that decides. It is idempotent with respect
to state: everything it needs is re-read each cycle.

1. **Read.** `game.snapshot()` → `normalizeSnapshot`. Reads may be retried; a
   revision that moves backwards is a hard contract error.
2. **Reconcile.** `ActionExecutor.observe(snapshot)` resolves the previous command:
   the observable effect is present → `verified`; absent after N revisions →
   `abandoned`. Nothing is retried.
3. **Terminal handling.** `lost` ends the session. `won` emits `next_level` on the
   wire (this is the only "no model" level decision) or finishes the campaign.
4. **Priority ladder.** urgent sun (about to expire) → emergency defence near the
   house → agent choice → opportunistic sun banking. A cycle issues **at most one**
   command, because confirming it needs a later snapshot.
5. **Narration** reacts to verified events only, rate-limited, and never blocks the
   loop.

## 3. Invariants

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I1 | An action is only sent if it is legal for the observed revision | `policy/contract.validateAction` | `contract.test.mjs` |
| I2 | At most one command is in flight | `ActionExecutor.pending` | `executor.test.mjs` |
| I3 | A command id is never replayed | executor + bridge dedupe map | `executor.test.mjs`, `core_test.cpp` |
| I4 | Success requires the effect in a fresh snapshot | `effectVisible` + `revisionAfter` | `executor.test.mjs` |
| I5 | Revisions never decrease; applied commands advance them | contract + bridge `Commit` | `contract.test.mjs`, `core_test.cpp` |
| I6 | Model output can only select an offered index | policy + `#decide` | `contract.test.mjs` |
| I7 | Audience bans are re-checked at the engine | policy + `BridgeCore::Validate` | `contract.test.mjs`, `core_test.cpp` |
| I8 | A stalled lane is not fed plants forever | `lost()` in the agent + emergency guard | `campaign.test.mjs` |
| I9 | Stuck detection stops a runaway session | `maxCommandsPerLevel` | `campaign.test.mjs` |

The native side re-validates every action: bounds, occupancy, card presence,
cooldown and sun. Even a compromised controller cannot plant into an occupied cell
or spend sun it does not have.

## 4. Failure model

| Failure | Client behaviour | Engine contract |
|---|---|---|
| Connection refused / 5xx / timeout | command becomes **ambiguous**; never resent | may have applied |
| HTTP 4xx | deterministic reject, no retry | not applied |
| Receipt `rejected` | journal + free slot | not applied |
| Receipt `applied`, effect not visible yet | wait for a later snapshot | applied |
| Effect never appears | abandon intent, resume from fresh state | unknown |
| Bridge dies mid-session | loop keeps retrying reads, then stops after N failures | — |
| Controller restarts | `pendingFromJournal` recovers the intent | — |

`ambiguous` is the important case: a double-plant would waste sun and desync the
journal, so the executor prefers to lose an action over duplicating one.

## 5. Security

- Bridge binds `127.0.0.1` only; rejects non-loopback client URLs as well.
- Bearer token ≥ 16 chars from `BIGFISH_BRIDGE_TOKEN`; missing token disables the
  bridge. Comparison is length-independent.
- Request bodies capped at 64 KiB, headers at 8 KiB, response bodies at 256 KiB on
  the client side; JSON depth capped at 16.
- No tool/file/network access in either Pi session (`noTools: "all"`); unexpected
  tools abort session creation.
- Audience text is untrusted context: it never becomes a model instruction, and its
  only effect is a validated vote or challenge.
- Douyin callbacks must arrive through an authenticated gateway; the verifier is
  defence in depth, not the primary boundary.

## 6. Observation model

The model sees `viewForModel(snapshot)`: level, wave, sun, bounded plant/zombie/card/
sun lists, per-row threat summary. It never sees hidden future waves, raw memory,
filesystem paths or unfiltered chat. Candidates arrive as an ordered array; the
model answers `{"index":n,"speech":"…"}` and stale indices are rejected.

## 7. Douyin topology (M1, not built)

```
approved live-play room
  → official signed callback (HTTP POST, <2s ACK)
  → HTTPS cloud relay (durable queue, dedupe, replay protection)
  → authenticated outbound connection initiated by the Mac
  → AudienceDirector
```

The Mac never exposes a public port. Official live-play packages currently target
Windows EXE clients; the Mac+companion arrangement is unverified and must be
confirmed with the platform before claiming official support.

## 8. Deliberate non-goals

- No memory reading, no DLL injection, no OS-level input automation.
- No retry of ambiguous actions.
- No LLM authority over legality, economy, or challenges.
- No packaged EA/PopCap assets in this repository.
