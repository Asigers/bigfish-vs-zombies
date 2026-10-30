# Runbook

## 1. Controller only (no assets needed)

```bash
npm install            # only dependency: the Pi SDK
npm test               # 48 tests
npm run sim            # deterministic 10-level campaign on the simulator
npm run sim -- --seed=11 --quiet
```

The simulator uses a virtual clock: ten levels finish in about a second. It exercises
the same contract, executor, journal, policy and orchestrator as the native path.

## 2. Native bridge check (no assets needed)

Requires `git`, `cmake`, `ninja` and a C++20 compiler.

```bash
npm run test:native
```

What it does:

1. builds the game-agnostic bridge core and runs 28 protocol/idempotency/HTTP checks;
2. clones PvZ-Portable at the commit pinned in `native/pvz-portable.lock`;
3. copies `native/` into the checkout as `bigfish-bridge/` and applies
   `native/patches/0001-bridge-hooks.patch` (two hook lines + one CMake include);
4. configures with `-DBIGFISH_BRIDGE=ON` and builds `pvz-portable`.

Use an existing checkout instead of cloning:

```bash
PVZ_DIR="$HOME/src/PvZ-Portable" npm run test:native
```

The checkout and build are cached under `native/vendor/` (git-ignored).

## 3. Real game session

Prerequisites:

- legally purchased PvZ GOTY assets (`main.pak` + `properties/`) — this repository
  ships none and `.gitignore` refuses to commit them;
- macOS with the dependencies from `native/README.md` (SDL2, libopenmpt, libpng,
  jpeg-turbo).

### What "legally purchased assets" means

`main.pak` is PopCap's asset archive (art, animation, audio, fonts, level data) and
`properties/` holds the XML/txt resource definitions (`properties/resources.xml` is
loaded at boot). PvZ-Portable is an engine reimplementation, so it needs the data
from a copy you own.

- Buy PvZ GOTY (Steam app `3590`, ¥21 / $4.99, or the EA store) and copy the files
  out of your own install directory. Recommended: **1.2.0.1073 EN**; Steam
  1.2.0.1096 works, and `scripts/make-compat-overrides.py` in the upstream repo
  fixes cosmetic strings.
- The Steam listing does offer a macOS build, but it targets OS X 10.5.8–10.6.x and
  is **32-bit**: macOS 10.15+ dropped 32-bit apps and Rosetta 2 does not translate
  them, so that executable cannot launch on a current Mac. This does not matter
  here — only the data files are needed, and the depot still downloads.
- On Apple Silicon the reliable way to fetch the data is SteamCMD with the Windows
  depot forced, since the Steam client refuses incompatible 32-bit titles:

  ```bash
  ./steamcmd.sh +force_install_dir ~/pvz-steam +login <account> \
    +@sSteamCmdForcePlatformType windows +app_update 3590 validate +quit
  ```

  `~/pvz-steam` then contains `main.pak` and `properties/`.
- Do **not** use repacks, "green" editions, cracked installers, APK dumps, files
  downloaded from asset-sharing sites, or a friend's copy. Those are not your
  licence, and they are the usual source of corrupted or missing data.
- Owning the game does not grant redistribution: keep the files on your machine,
  never commit them, never upload them to the relay, OBS scene collection, or any
  cloud drive.
- Layout expected by the engine:

  ```
  <resdir>/
    main.pak
    properties/
      resources.xml
      ...
  ```

  Launch with `-resdir <resdir>` (or place both beside the binary). Extracted loose
  asset folders are also accepted, but `properties/` is mandatory.

```bash
# 1) bridge-enabled binary
export BIGFISH_BRIDGE_TOKEN="$(openssl rand -hex 24)"
native/vendor/build/pvz-portable -resdir "/path/to/GOTY"

# 2) sanity check from another shell
curl -s -H "Authorization: Bearer $BIGFISH_BRIDGE_TOKEN" \
  http://127.0.0.1:45941/v1/health | python3 -m json.tool
curl -s -H "Authorization: Bearer $BIGFISH_BRIDGE_TOKEN" \
  http://127.0.0.1:45941/v1/snapshot | python3 -m json.tool

# 3) controller
BIGFISH_BRIDGE_TOKEN="$BIGFISH_BRIDGE_TOKEN" \
  node src/main.mjs --engine=bridge --agent=heuristic --levels=10
```

With an LLM tactical host:

```bash
BIGFISH_PROVIDER=anthropic BIGFISH_MODEL=claude-… \
BIGFISH_BRIDGE_TOKEN="$BIGFISH_BRIDGE_TOKEN" \
  node src/main.mjs --engine=bridge --agent=pi
```

The Pi sessions have no tools and use only the projected snapshot. If the model
fails or times out, the loop keeps playing with the deterministic strategy rules
plus emergency defence; it never blocks the game.

### What the controller handles by itself (verified live)

- Title screen → `enter_adventure`: creates a `BigFish` profile if none exists,
  marks it as a returning player (skips the scripted tutorial that freezes waves),
  and builds the board.
- Seed chooser → `choose_seeds`: clicks Crazy Dave's dialog to completion, fills the
  bank deterministically (sunflower, peashooter, wallnut, snowpea, repeater, …) and
  closes the chooser.
- Level win → `next_level`: advances the profile and starts the next board, which
  loops back into the seed chooser.

### Known gaps in a real run

- Only adventure day levels are exercised; pool/roof/night, conveyor and mini-game
  levels are untested.
- Shovel is implemented and unit-tested but has not been used in a live level.
- Engine save/restart (`Board::SaveGame`/`LoadGame`) is not covered; a stale
  mid-level auto-save is deliberately ignored at bootstrap.
- Sun lifetime assumes ~10 ms engine ticks; it matches observed behaviour (~7.5 s).

## 4. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `[bigfish-bridge] disabled: set BIGFISH_BRIDGE_TOKEN` | token missing or shorter than 16 chars in the game process |
| `disabled: bind 127.0.0.1:45941: address already in use` | another instance (or a previous run) holds the port; `BIGFISH_BRIDGE_PORT=45942` |
| bridge not reachable | game is at the resource-missing dialog, or the window never starts updating |
| controller prints `no snapshot` / `bridge unavailable` | game paused, minimised in a blocking dialog, or bridge disabled |
| `command_rejected` with `cooldown`/`insufficient_sun` | expected: another actor (or the model) raced the state; the loop re-plans |
| `abandoned ... effect_not_observed` | engine accepted but nothing changed; check the facade mapping |
| campaign stops with `stuck` | safety stop after `maxCommandsPerLevel`; inspect `.state/journal.jsonl` |
| `revision went backwards` | engine/projection bug; do not paper over it |

## 5. Observability

- `.state/journal.jsonl` — append-only audit: every `sent`, `acknowledged`,
  `verified`, `rejected`, `ambiguous`, `abandoned` with command id, revision and
  action. `ts` is wall-clock, pinning a record to a live moment.
- Final JSON summary on stdout: per-level timings, command counts, ambiguity counts.
- `pendingFromJournal()` recovers the last unresolved intent after a crash, so a
  restart resumes rather than replays.

## 6. Rights checklist before streaming

- [ ] assets obtained legally, never redistributed;
- [ ] PvZ-Portable LGPL notices preserved;
- [ ] Live2D/character art cleared for the intended use;
- [ ] Douyin live-play approval for derivative game IP confirmed in writing;
- [ ] no copyrighted assets uploaded to any relay or cloud service.
