# Architecture

Status: LLM-first autonomous controller. The native bridge, snapshot contract,
command journal and at-most-once executor remain the trusted game-control
boundary.

## 1. Authority model

BigFish is an LLM-driven livestream character, not a scripted strategy with an
LLM choosing from a small menu.

- **LLM owns strategic decisions:** complete seed-deck composition and order,
  economy vs. defence, plant composition, lane priorities, placement,
  shovel/replacement, multi-step plans and responses to viewers.
- **Runtime owns housekeeping:** collect expiring sun, collect opportunistic sun
  when the model deliberately waits or has no actionable plan, enter adventure,
  advance after a confirmed win, and dismiss chooser-free intro dialogue.
- **Runtime owns constraints:** validate model output against the latest
  snapshot and audience challenge bans. The native bridge validates engine
  legality again.
- **Pi is the model runtime:** one persistent, tool-free session handles seed
  selection, gameplay strategy, tactical actions, audience context and speech.
- **HeuristicAgent is fallback only:** deterministic and useful for offline
  simulation; it is not the default live strategy.

There is no automatic emergency plant-placement policy. If the model is
unavailable, the controller waits and retries instead of silently taking over
the character's strategic role.

## 2. Control topology

\`\`\`
PvZ-Portable engine
  → Native Bridge (game-thread snapshot / command validation)
  → Game Observer (bounded snapshot projection)
  → Pi Brain (seed deck OR strategy + up to 5 tentative actions + Chinese speech)
  → Action Validator (revision, chooser rules, card, sun, cooldown, cell, challenge)
  → ActionExecutor (single-flight, at-most-once, journal)
  → Native Bridge
  → fresh snapshot / verified outcome
  → Pi Brain (continue or revise plan)
\`\`\`

The bridge remains loopback-only and all board mutation remains on the game
thread. HTTP worker threads only enqueue commands.

## 3. Model-selected seed deck

At every actual seed chooser, the bridge reports:

- exact seed-bank slot count;
- all currently unlocked and level-allowed plants that can be selected;
- sun cost and per-plant stage warnings;
- upgrade dependencies (for example, Gatling Pea requires Repeater);
- preselected plants and mandatory Crazy Dave tutorial picks;
- whether chooser animations have finished and the deck can be applied.

The same Pi session chooses an ordered list of exactly the required number of
unique plant IDs. Warnings are strategic advice, not automatic bans. Mandatory
picks, unavailable plants, challenge bans and upgrade dependencies are hard
constraints. The runtime never chooses a default deck.

Imitater is excluded until its secondary plant-type choice is represented in
the bridge protocol. Survival repicks are surfaced even when the coarse game
status is paused or playing.

A level without a chooser (for example, a conveyor level) follows the
chooser-free intro transition with an empty deck. Crazy Dave dialogue is
advanced by the runtime as lifecycle work; the model is asked to choose only
after the actual chooser is ready.

## 4. Rolling-horizon gameplay planning

During play the model returns a goal, short rationale, a plan of 0–5 actions
and one livestream line. The supported gameplay action vocabulary is:

- plant: choose any currently held seed and any board coordinate.
- shovel: remove a plant at a board coordinate.

The model does not receive a precomputed candidate list and does not choose
an integer index. The runtime attaches gameId and revision, validates the
first action, and executes only that action. After the next fresh snapshot, it
reassesses the remaining plan. A plan is discarded on level/wave changes,
material threat changes, audience-context changes, age limit or an illegal next
action. At most one game command is in flight.

A future plan is a proposal, not a macro. Never blindly execute all planned
actions against an old board state.

## 5. Housekeeping versus strategy

Automatic operations:

- collect sun that is about to expire;
- collect available sun when the model deliberately waits or has no actionable
  plan;
- enter adventure and advance after a confirmed win;
- dismiss Crazy Dave / chooser-free intro transitions without selecting plants.

LLM decisions:

- choose the complete ordered seed deck at each real chooser;
- decide whether to spend sun or save it;
- choose what to plant, where and when;
- decide whether to shovel/rebuild;
- choose lane priorities, economy, defence, unusual tactics and responses to
  viewer challenges.

## 6. Single Pi session

One in-memory Pi session carries the character and strategic context across
turns. It is tool-free (noTools: all) and returns JSON only. The same
session selects seed decks, proposes gameplay plans and writes livestream
speech. Speech associated with an action is published only after that action is
confirmed; deliberate-wait speech can be published immediately. This avoids
maintaining a second narrator conversation with a different view of the match.

## 7. Audience context

Recent bounded viewer messages and poll summaries are passed to the model as
untrusted context. They are preferences and suggestions, not instructions.
Validated audience challenges (for example, temporary plant bans) remain hard
constraints enforced by runtime policy before command submission. The native
bridge independently enforces game-state legality; it does not interpret viewer
challenges. Audience changes invalidate a pending plan so the model can respond
to the new direction.

## 8. Safety invariants

1. The engine is the source of truth; controller never mutates game memory.
2. Every action is validated against the current gameId and revision.
3. The native bridge revalidates chooser state, slot count, unlocked plants,
   mandatory picks, upgrade dependencies, bounds, occupancy, card, cooldown
   and sun.
4. Runtime enforces audience challenge bans before submission.
5. At most one command is in flight.
6. Ambiguous commands are never resent with the same command id.
7. Success is only announced after a fresh snapshot verifies the effect.
8. Model output is bounded JSON; gameplay plans contain only plant/shovel
   actions and deck decisions contain only validated plant IDs.
9. Viewer messages are untrusted and cannot change system instructions.
10. A stalled/invalid model response never bypasses action validation.

## 9. Failure behaviour

- Model timeout/error: no speculative action; collect available sun if useful,
  otherwise wait and retry after a cooldown. No default deck or emergency plant
  is inserted.
- Invalid model action/deck: reject the proposal, record the reason and ask the
  model again on a later cycle.
- Command timeout: keep the intent pending until a fresh snapshot verifies or
  abandons it; never replay the old command id.
- Bridge read failure: bounded retries, then stop through the existing failure
  path.
- Simulation mode can continue using the deterministic heuristic fallback.

## 10. Douyin integration

AudienceDirector currently handles bounded messages, deduplicated votes and
validated challenge bans. The existing official callback / relay integration
remains a separate delivery task; this refactor makes the AI decision interface
ready to consume those events.
