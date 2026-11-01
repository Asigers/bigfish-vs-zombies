# BigFish vs Zombies

Mac-first autonomous **Plants vs. Zombies** livestream. BigFish is an LLM-driven
on-air character playing PvZ-Portable; audience preferences and challenges can
influence its strategy.

## AI-first control model

One persistent Pi session is BigFish's brain. The same session chooses the
complete seed deck at each real chooser, plans gameplay, proposes tactical
actions and writes the Chinese livestream line. It is not a scripted policy
choosing from a small menu.

- **LLM decides:** the ordered seed deck, economy vs. defence, plant composition,
  lanes, placement, timing, shovel/replacement, multi-step plans and responses
  to viewers.
- **Runtime automates:** expiring/opportunistic sun collection, menu entry,
  chooser-free intro transitions and next-level progression. It never invents a
  default deck or places emergency plants.
- **Runtime enforces:** model-output validity and audience challenge bans
  before submitting an action.
- **Native bridge enforces:** revision semantics, chooser readiness and slot count,
  unlocked/allowed plants, mandatory tutorial picks, upgrade dependencies, board
  bounds, occupancy, cooldown, sun balance and at-most-once execution.
- **One Pi session** produces deck decisions, gameplay decisions and speech.
  Speech associated with an action is published only after the action is
  verified.
- **HeuristicAgent** remains a deterministic fallback and simulator agent; live
  bridge mode defaults to Pi.

The chooser snapshot includes unlocked plants, costs, advisory stage warnings,
mandatory/preselected picks and upgrade dependencies. Imitater is intentionally
excluded until its secondary plant choice is represented in the bridge protocol.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/BRIDGE-PROTOCOL.md](docs/BRIDGE-PROTOCOL.md).

## Quick start

\`\`\`bash
npm test
npm run sim

# Real game: live defaults to Pi / LLM
export BIGFISH_BRIDGE_TOKEN="$(openssl rand -hex 24)"
native/vendor/build/pvz-portable -resdir "/path/to/GOTY" &
node src/main.mjs --engine=bridge

# Explicit deterministic fallback (debugging only)
node src/main.mjs --engine=bridge --agent=heuristic
\`\`\`

Configure the Pi provider/model with BIGFISH_PROVIDER and BIGFISH_MODEL
when required by the installed Pi runtime.

## Repository layout

\`\`\`
src/
  domain/        snapshot/action/receipt contract and action validation
  runtime/       LLM-first orchestrator, executor, tick loop, journal, audience
  adapters/      bridge client, simulator, single-session Pi brain, Douyin
  agents/        deterministic fallback strategy
  main.mjs       entrypoint (sim | bridge, auto | pi | heuristic)
  overlay/       Live2D OBS surface and speech feed
native/          loopback HTTP bridge and PvZ-Portable game-thread facade
tests/           contract, executor, simulator, campaign, audience and overlay tests
docs/            architecture, bridge protocol, M0 status, runbook
\`\`\`

## Rights and assets

This repository contains no PopCap/EA assets. PvZ-Portable (LGPL-3.0-or-later)
requires game assets from a legally purchased PvZ GOTY copy. Game-IP streaming
approval and Live2D model licensing must be cleared separately before
monetization.
