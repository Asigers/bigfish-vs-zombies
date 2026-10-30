# Bridge protocol v1

Loopback HTTP/1.1 between the BigFish controller and the native bridge running
inside PvZ-Portable. Everything is JSON; there is no streaming and no WebSocket.

- Base URL: `http://127.0.0.1:45941` (`BIGFISH_BRIDGE_PORT`)
- Auth: `Authorization: Bearer <BIGFISH_BRIDGE_TOKEN>` on **every** request
- Bind: `127.0.0.1` only; the game refuses to serve other interfaces
- Timeouts: snapshot 1.5 s (client), command 3 s (client) / 2.5 s wait (server)

## Endpoints

### `GET /v1/health`

```json
{"service":"pvz-portable-bridge","schema":1,"session":"pvz-portable",
 "ready":true,"revision":812,"level":4,"status":"playing","uptimeMs":52011}
```

`ready` is false until the game thread has produced the first snapshot. A controller
must not issue commands while `ready` is false.

### `GET /v1/snapshot`

```json
{"snapshot":{
  "schema":1,"gameId":"pvz-portable","revision":812,
  "level":4,"wave":2,"totalWaves":5,"sun":175,
  "rows":5,"columns":9,"status":"playing","hasNextLevel":true,
  "plants":[{"type":"peashooter","row":3,"col":2,"health":300}],
  "zombies":[{"type":"cone","row":3,"x":6.412,"health":420}],
  "cards":[{"type":"peashooter","cost":100,"ready":true}],
  "suns":[{"id":"coin41","x":310.5,"y":208.0,"expiresInMs":8000}],
  "blocked":[]
}}
```

- `revision` increases monotonically for the lifetime of the process. It changes
  whenever the observable projection changes (sun, plants, zombie position/health,
  cards, level, status).
- `suns[].expiresInMs` is omitted when the engine does not expose a lifetime; treat
  a missing value as "not urgent".
- `blocked` lists cells that cannot be planted on (graves). The current PvZ facade
  returns an empty list and relies on `CanPlantAt` for the real check.

### `POST /v1/command`

```json
{"commandId":"7b64c0c2-…","expectedRevision":812,
 "action":{"type":"plant","plant":"peashooter","row":3,"col":2}}
```

Actions:

| type | fields | legality |
|---|---|---|
| `plant` | `plant,row,col` | playing, in bounds, empty, card ready, enough sun |
| `collect_sun` | `id` | playing, sun id present |
| `shovel` | `row,col` | playing, plant present |
| `next_level` | — | `status == "won"` and `hasNextLevel` |

Response (`200`):

```json
{"receipt":{"commandId":"7b64c0c2-…","status":"applied",
            "revisionBefore":812,"revisionAfter":813}}
```

Receipt statuses:

| status | meaning | client action |
|---|---|---|
| `applied` | engine accepted it and the state changed | confirm effect in a later snapshot |
| `rejected` | engine refused it; `issue` explains why | journal, do not retry |
| `duplicate` | this `commandId` was already processed | do not apply again |

`applied` requires `revisionAfter > revisionBefore`. If the engine reports success
but the projection does not change, the bridge converts the receipt to
`rejected` with `issue: "no_effect"` — success without evidence is not success.

Issues: `stale_state`, `future_state`, `not_playing`, `bad_action`,
`unsupported_action`, `out_of_bounds`, `occupied`, `blocked`, `no_plant`,
`missing_card`, `cooldown`, `insufficient_sun`, `sun_missing`, `no_next_level`,
`no_effect`, `duplicate_command`.

HTTP status codes:

| code | meaning |
|---|---|
| 200 | receipt present (including `rejected`) |
| 400 | malformed JSON / unknown action / bad fields — **not applied** |
| 401 | bad or missing token — **not applied** |
| 405 | wrong method |
| 409 | the same `commandId` is already in flight |
| 413 | body over 64 KiB |
| 504 | game thread did not answer in 2.5 s — **outcome unknown** |

## Revision semantics

The controller validates locally against the snapshot it read, then sends
`expectedRevision`. The bridge re-validates against **current** state:

- `expectedRevision > current` → `future_state` (client clock/state is ahead).
- `expectedRevision < current` → the action is re-validated against current state
  and may still apply; the receipt's `revisionBefore` tells the client it acted on
  older information.
- Any later rejection is authoritative and final.

This avoids turning normal one-frame staleness into a stall while keeping the engine
in charge of legality.

## At-most-once semantics

```
controller                          bridge
  │ POST commandId=C1 ───────────────▶│ enqueue, wait
  │                                   │ game thread: validate → apply → capture
  │◀───────────── 200 applied ────────│ remember C1 → receipt
  │ next snapshot: effect present?     │
  │   yes → verified                   │
  │   no  → keep pending, wait         │
  │                                   │
  │ POST times out / 504               │  may or may not have applied
  │   → ambiguous, never resend C1     │
  │   → resolve from snapshots only    │
```

The bridge keeps the last 512 receipts; reusing a `commandId` returns `duplicate`
with the original revisions and never re-executes.

## Threading

- `Pump()` runs once per game frame on the game thread. It applies **at most one**
  queued command, so a frame can never be delayed by a command burst.
- HTTP handlers parse, authenticate, deduplicate, enqueue and wait. They never touch
  `Board`, `Plant`, `Zombie` or `Coin`.
- The bridge answers a waiting request from the game thread, so `Pump()` must keep
  running; a paused/dead game shows up as 504s, which the client treats as unknown.

## Security

- Loopback bind is hard-coded; the client additionally refuses non-loopback URLs.
- Token comparison is length-independent. Missing/short token disables the bridge
  instead of running open.
- No CORS, no unauthenticated routes, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`.
- The wire contract has no way to read files, set memory, or execute code.

## Versioning

`schema` is 1. Additive fields are allowed; removed or re-typed fields require a new
schema number. The controller rejects an unknown status value and any snapshot that
violates its documented bounds.
