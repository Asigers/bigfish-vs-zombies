# BigFish vs Zombies

Mac-first autonomous **Plants vs. Zombies** livestream: BigFish is an LLM-driven
on-air character playing PvZ-Portable while audience preferences and challenges
can influence its strategy.

## AI-first control model

The live controller uses one persistent Pi session as BigFish's brain. It sees a
bounded projection of the real game state and recent audience context, then
proposes its own strategy and up to five tentative plant/shovel actions. The
runtime executes only the first action, confirms it against a fresh engine
snapshot, and asks the model to continue or revise the plan.

The model is not restricted to a precomputed top-12 candidate list.

- **LLM decides:** economy, defence, lane priorities, plant selection/placement,
  shovel/rebuild, multi-step plans and responses to audience challenges.
- **Runtime automates:** expiring sun collection, opportunistic collection when
  the model waits, menu/seed bootstrap and next-level progression.
- **Runtime + native bridge enforce:** board bounds, occupancy, card ownership,
  cooldown, sun balance, challenge bans, revision checks and at-most-once
  execution.
- **One Pi session** generates both strategy/actions and Chinese livestream
  speech. The line associated with an action is published only after the action
  is verified.
- **HeuristicAgent** remains available as a deterministic fallback and for
  offline simulation, not as the default live strategy.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the authority model and
rolling-horizon control loop.

## Quick start

\`\`\`bash
npm test
npm run sim

# Real game: live defaults to Pi / LLM
BIGFISH_BRIDGE_TOKEN="$(openssl rand -hex 24)" \\
  native/vendor/build/pvz-portable -resdir "/path/to/GOTY" &
BIGFISH_BRIDGE_TOKEN="<same token>" node src/main.mjs --engine=bridge

# Explicit deterministic fallback (debugging only)
node src/main.mjs --engine=bridge --agent=heuristic
\`\`\`

Configure the Pi provider/model with \`BIGFISH_PROVIDER\` and \`BIGFISH_MODEL\`
when required by the installed Pi runtime.

## Repository layout

\`\`\`
src/
  domain/        snapshot/action/receipt contract and action validation
  runtime/       executor, LLM-first orchestrator, tick loop, journal, audience
  adapters/      bridge client, simulator, single-session Pi brain, Douyin
  agents/        deterministic fallback strategy
  main.mjs       entrypoint (sim | bridge, auto | pi | heuristic)
  overlay/       Live2D OBS surface and speech feed
native/          loopback HTTP bridge and PvZ-Portable game-thread facade
tests/           contract, executor, sim, campaign, audience and overlay tests
docs/            architecture, bridge protocol, M0 status, runbook
\`\`\`

## Rights and assets

This repository contains no PopCap/EA assets. PvZ-Portable (LGPL-3.0-or-later)
requires game assets from a legally purchased PvZ GOTY copy. Game-IP streaming
approval and Live2D model licensing must be cleared separately before
monetization.
