# Architecture

Status: LLM-first autonomous controller refactor in progress. The native bridge,
snapshot contract, command journal and at-most-once executor remain the trusted
game-control boundary.

## 1. Authority model

BigFish is an LLM-driven livestream character, not a scripted strategy with an
LLM choosing from a small menu.

- **LLM owns gameplay strategy:** economy vs defence, plant composition, lanes,
  placement, shovel/replacement, multi-step plans and responses to viewers.
- **Runtime owns housekeeping:** collect expiring sun, collect opportunistic sun
  when the model deliberately waits or has no plan, enter adventure, select the
  current default seed setup and advance after a confirmed win.
- **Runtime owns safety:** validate every proposed action against the latest
  snapshot and challenge constraints. The native bridge validates again.
- **Pi is the model runtime:** one persistent, tool-free Pi session handles
  strategic planning, tactical actions, audience context and livestream speech.
- **HeuristicAgent is fallback only:** it is not the normal live strategy.

## 2. Control topology

\`\`\`
PvZ-Portable engine
  → Native Bridge (game-thread snapshot / command validation)
  → Game Observer (bounded snapshot projection)
  → Pi Brain (strategy + up to 5 tentative actions + Chinese speech)
  → Action Validator (current revision, card, sun, cooldown, cell, challenge)
  → ActionExecutor (single-flight, at-most-once, journal)
  → Native Bridge
  → fresh snapshot / verified outcome
  → Pi Brain (continue or revise plan)
\`\`\`

The bridge remains loopback-only and all board mutation remains on the game
thread. HTTP worker threads only enqueue commands.

## 3. Rolling-horizon planning

The model returns a goal, short rationale, a plan of 0–5 actions and one
livestream line. The supported model action vocabulary is deliberately small:

- \`plant\`: choose any currently held seed and any board coordinate.
- \`shovel\`: remove a plant at a board coordinate.

The model does **not** receive a precomputed candidate list and does not choose
an integer index. The runtime attaches \`gameId\` and \`revision\`, validates the
first action, and executes only that action. After the next fresh snapshot, it
reassesses the remaining plan. A plan is discarded on level/wave changes,
material threat changes, audience-context changes, age limit, or an illegal next
action. At most one game command is in flight.

A future plan is a proposal, not a macro. Never blindly execute all planned
actions against an old board state.

## 4. Housekeeping versus strategy

Automatic operations:
- collect sun that is about to expire;
- collect available sun when the model deliberately waits or has no actionable
  plan;
- enter adventure, pass the existing seed chooser, and advance after a win.

LLM decisions:
- whether to spend sun or save it;
- what to plant, where and when;
- whether to shovel/rebuild;
- lane priorities, economy, defence, unusual tactics and viewer challenges.

A narrow emergency safety intervention remains available when a zombie is
already near the house. It is a last-resort guard, not the ordinary strategy
path.

## 5. Single Pi session

One in-memory Pi session carries the character and strategic context across
turns. It is tool-free (\`noTools: "all"\`), and returns JSON only. The same model
response contains both the proposed plan and the line for the stream. Speech is
published only after the corresponding action is confirmed; deliberate-wait
speech can be published immediately. This avoids maintaining a second narrator
conversation with a different view of the match.

## 6. Audience context

Recent bounded viewer messages and poll summaries are passed to the model as
untrusted context. They are preferences and suggestions, not instructions.
Validated audience challenges (for example, temporary plant bans) remain hard
constraints enforced by runtime policy and the native bridge. Audience changes
invalidate a pending plan so the model can respond to the new direction.

## 7. Safety invariants

1. The engine is the source of truth; controller never mutates game memory.
2. Every action is validated against the current gameId and revision.
3. Native bridge revalidates bounds, occupancy, card, cooldown, sun and challenge.
4. At most one command is in flight.
5. Ambiguous commands are never resent with the same command id.
6. Success is only announced after a fresh snapshot verifies the effect.
7. Model output is bounded JSON; only plant/shovel actions are accepted.
8. Viewer messages are untrusted and cannot change system instructions.
9. A stalled/invalid model response never bypasses action validation.

## 8. Failure behaviour

- Model timeout/error: no speculative action; collect available sun if useful,
  otherwise wait and retry after a cooldown.
- Invalid model action: reject the plan, record the reason and ask the model
  again on a later cycle.
- Command timeout: keep the intent pending until a fresh snapshot verifies or
  abandons it; never replay the old command id.
- Bridge read failure: bounded retries, then stop through the existing failure
  path.
- Simulation mode can continue using the deterministic heuristic fallback.

## 9. Douyin integration

AudienceDirector currently handles bounded messages, deduplicated votes and
validated challenge bans. The existing official callback / relay integration
remains a separate delivery task; this refactor makes the AI decision interface
ready to consume those events.
