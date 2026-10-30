# Native bridge

The bridge lives inside the game process and exposes a small authenticated HTTP API
on loopback. It is the only place where game state is read or written.

## Layout

| File | Role |
|---|---|
| `Protocol.h` | schema version, limits, snapshot structs, stable issue names |
| `Json.{h,cpp}` | minimal writer/parser (no dependencies, depth-limited) |
| `GameFacade.h` | the only interface the bridge needs from an engine |
| `BridgeCore.{h,cpp}` | revisions, dedupe, queue, receipts, `Validate` (game-agnostic) |
| `HttpServer.{h,cpp}` | HTTP/1.1 on `127.0.0.1`, bearer auth, 3 s socket timeouts |
| `PvzFacade.{h,cpp}` | PvZ-Portable implementation (game thread) |
| `Module.{h,cpp}` | `PumpBridge(LawnApp*)` / `ShutdownBridge()` |
| `Bridge.cmake` | injected into the PvZ-Portable build |
| `patches/0001-bridge-hooks.patch` | 2 hook lines + 1 CMake include, pinned to a commit |
| `tests/core_test.cpp` | 28 checks with a fake engine, including real HTTP |

## Build and test without the game

```bash
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
native/build/bigfish_core_test
```

## Build into PvZ-Portable

```bash
npm run test:native               # or PVZ_DIR=/path/to/checkout npm run test:native
```

The script clones the commit in `pvz-portable.lock`, copies this directory into the
checkout as `bigfish-bridge/`, applies the hook patch, configures with
`-DBIGFISH_BRIDGE=ON` and builds.

## Runtime configuration

| Variable | Default | Meaning |
|---|---|---|
| `BIGFISH_BRIDGE_TOKEN` | — | required; ≥ 16 chars; absent means the bridge stays disabled |
| `BIGFISH_BRIDGE_PORT` | `45941` | loopback port |

On startup the game prints `[bigfish-bridge] listening on http://127.0.0.1:45941`.

## Design notes

- **One command per frame.** `Pump()` drains a single queued command; a burst of
  requests can never stall rendering, and every command runs on the game thread.
- **Evidence-based success.** After applying, the bridge re-captures and compares.
  An "applied" action that changes nothing becomes `rejected: no_effect`.
- **Dedupe before execution.** A repeated `commandId` returns the stored receipt and
  is never applied twice; the same id while in flight returns HTTP 409.
- **No direct state writes.** `PvzFacade` uses the engine's own functions
  (`CanPlantAt`, `TakeSunMoney`, `AddPlant`, `SeedPacket::WasPlanted`,
  `Coin::Collect`, `Plant::Die`, `NewGame`), mirroring what a click does.
- **No assets in this repo.** The bridge contains no PopCap/EA data.

## Platform support

The HTTP server and hook are POSIX-only today (macOS and Linux). Windows support
needs a Winsock implementation of `HttpServer.cpp`; the rest of the bridge is
portable C++20.

## Known gaps

- Seed chooser automation (PvZ asks for seeds before each level).
- `next_level` is compiled but never executed against a real board.
- `blocked` cells are empty; `CanPlantAt` is the authority.
- Sun lifetime (`expiresInMs`) is not projected.
