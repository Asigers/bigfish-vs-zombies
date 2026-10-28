# BigFish vs Zombies

Mac-first autonomous Plants vs Zombies streamer with audience interaction.

**Development foundation only — M0, M1 and M2 are NOT complete.**

Read [M0–M2 architecture and Douyin release gates](docs/ARCHITECTURE.md).

Run contract tests on Node.js 22+: `npm test`.

Implemented: bounded game-state projection and command policy, no-tools Pi session adapter, localhost bridge client, vote handling and Douyin event normalization. Still missing: a compiled PvZ-Portable C++ bridge, approved Douyin gateway/transport, real game testing, OBS/Live2D wiring and verified live comments.

Use legally obtained PvZ GOTY assets locally only. Official Douyin live-play approval for derivative game IP requires separate rights/eligibility checks.
