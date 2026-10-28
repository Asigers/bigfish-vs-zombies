# BigFish vs Zombies — M0 / M1 / M2 architecture

Status: **development foundation, not M0-M2 acceptance complete**.

## Goals

Mac plays PvZ-Portable without manual mouse control. Viewers interact via **approved Douyin live-play comments**, with votes and questions that change verified gameplay and narration. BigFish Pi controls tactics, not the native memory or OS.

## Topology

1. PvZ-Portable C++ remains the sole game engine, renderer, collision and wave logic.
2. An embedded C++ bridge (to be written) reports authoritative public board state and executes validated commands on the native game thread.
3. A Node 22 controller running on the same Mac performs game polling, deterministic sun collection and emergency behavior.
4. Pi SDK: tactical session sees only reduced snapshots and picks one enumerated legal action; a separate no-tools narrator produces Chinese commentary.
5. InteractionDirector receives normalized Douyin audience events and chooses from feasible actions or challenges.
6. OBS captures game window, transparent Live2D overlay, commentary, votes and outcomes.

Douyin transport: approved live-play -> official signed HTTP callback -> HTTPS cloud relay -> authenticated outbound connection from Mac -> InteractionDirector. The Mac bridge binds only to loopback and is never published on the internet.

## Model observation

Visible projection: gameId, revision, current level/wave, sun, rows/columns, currently present plant types and grid locations, currently present zombie types/positions/HP, available seed cards and cooldown, collectable suns. Add an opt-in bounded audience vote, verified recent game receipts and a concise strategy journal. Exclude future unrevealed waves, raw memory, arbitrary filesystem and unfiltered chat.

The model receives a shortlist of **legal actions** with numeric indices. It responds with JSON, e.g. {"index":0,"speech":"先保住第三路"}.
Any stale/invalid action is discarded; native Bridge revalidates all terrain/collision/economy rules. Only success verified from fresh game state counts as action completion. No model call blocks game frames.

## First interaction features

- A 12-second vote with 2-4 current feasible options, one user per round, dedup by messageId.
- Audience chat begins with a recognized command prefix to request an answer; sampling and rate limits prevent speech overload.
- Challenges ban specific plants or restrict resource spending; bans must be enforced by the executor and Bridge, not merely promised by the LLM.
- With no audience, BigFish continues without inventing votes.
- An unexpectedly impossible winning vote must be acknowledged as unavailable rather than silently faked.

## Official Douyin prerequisites (mandatory)

The platform's live-play comment feed is not an unrestricted public-room WebSocket.
It requires developer identity approval, submitted and approved gameplay proposal, AppID, live-play comment capability, configured push callback, a mounted live-play app and a started data-push task.

Official callback protocol: HTTP POST with x-nonce-str, x-timestamp (milliseconds), x-roomid, x-msg-type, x-signature; signature is base64(MD5(sorted signed headers + raw body + configured secret)). This is **different** from the RSA-SHA256 signing method used by platform OpenAPI requests. Verify before normalizing. The initial src/douyin-events.mjs is only a schema normalizer and must only receive events from an authenticated gateway.

A cloud callback receiver needs durable queueing, dedup, HTTPS, replay prevention, ACK tracking, source authentication, failure recovery and prompt responses (<2 s). Official live-play fulfilment reporting is required for production deployment. A platform-approved app/client arrangement must be tested: official live-play gameplay packages currently focus on Windows EXE and may require a Windows companion even if the PvZ engine and OBS live on Mac. Do not claim Mac-only Douyin official deployment without approval.

Official documentation:
- https://developer.open-douyin.com/docs/resource/zh-CN/interaction/introduction/zn/toybox-start
- https://developer.open-douyin.com/docs/resource/zh-CN/interaction/develop/server/live-room-scope/data-open/data-open-desc
- https://developer.open-douyin.com/docs/resource/zh-CN/interaction/jierushuoming/hudongshuju/pinglunshuju
- https://developer.open-douyin.com/docs/resource/zh-CN/interaction/jierushuoming/pingtaijichu/msg-ack-ability

## Gates

### M0: real game

- [ ] Build and run PvZ-Portable on actual Apple Silicon Mac, from legally sourced GOTY assets.
- [ ] Embed native game-thread Bridge, exposing revisioned snapshots.
- [ ] Execute seed selection, plant, collect sun, shovel and next level through real game mechanics.
- [ ] Never retry ambiguously acknowledged actions; reconcile with the next snapshot.
- [ ] Pass at least 10 levels and restart/save tests on the Mac.

### M1: Douyin audience

- [x] Deterministic polling, one vote per viewer and message dedup.
- [x] Initial official live-comment payload normalizer.
- [ ] Authorized callback verification and cloud relay connected to Mac.
- [ ] Douyin AppID and approved comment push data, real room vote modifies a native game action.
- [ ] Official fulfilment reporting and platform tests pass.
- [ ] Confirm approved Mac/Windows client deployment path.

### M2: AI host

- [x] Bounded observable state and legal action contract.
- [ ] Connect no-tools Pi SDK tactical agent and independent speech session.
- [ ] Live2D / OBS / TTS integrated and licensed for intended use.
- [ ] Audience questions answered from real game facts and completed game challenges.
- [ ] All live events matched to verified game changes; sustained hands-free live session.

## Rights

Do not upload EA/PopCap copyrighted assets or a packaged original game's data.
PvZ-Portable source carries LGPL-3.0-or-later obligations. Existing whale-girl
Live2D art is noncommercial upstream and must be cleared before monetized streams.
