import {randomUUID} from "node:crypto"
import {
  ACTION,
  actionKey,
  buildCommand,
  normalizeReceipt,
  validateAction
} from "../domain/contract.mjs"
import {ContractError, ProtocolError, TransportError} from "../domain/errors.mjs"

export const OUTCOME = Object.freeze({
  VERIFIED: "verified",
  REJECTED: "rejected",
  /** Accepted by the engine, but not yet visible in a fresh snapshot. */
  ACKNOWLEDGED: "acknowledged",
  /** No trustworthy answer: the command may or may not have happened. */
  AMBIGUOUS: "ambiguous",
  ABANDONED: "abandoned",
  IN_FLIGHT: "in_flight"
})

/** Observable effect used to decide whether a command actually happened. */
export function effectVisible(snapshot, action, {level} = {}) {
  switch (action.type) {
    case ACTION.PLANT:
      return snapshot.plants.some((p) => p.row === action.row && p.col === action.col && p.type === action.plant)
    case ACTION.COLLECT_SUN:
      return !snapshot.suns.some((s) => s.id === action.id)
    case ACTION.SHOVEL:
      return !snapshot.plants.some((p) => p.row === action.row && p.col === action.col)
    case ACTION.NEXT_LEVEL:
      return snapshot.level > (level ?? snapshot.level) || snapshot.status !== "won"
    default:
      return false
  }
}

/**
 * Executes at most one game command at a time with deliberate at-most-once
 * semantics.
 *
 * A command is never resent: after a timeout or malformed response the bridge
 * may already have mutated the game, so the executor keeps the command as
 * `pending` and waits for a fresh snapshot. `observe()` then either confirms
 * the effect, or abandons the intent. A later cycle may derive a *new* intent
 * from fresh state, but it will never replay the old command id.
 */
export class ActionExecutor {
  constructor({
    game,
    journal = null,
    logger = null,
    newId = randomUUID,
    maxAmbiguityRevisions = 3,
    now = () => Date.now()
  }) {
    this.game = game
    this.journal = journal
    this.logger = logger
    this.newId = newId
    this.maxAmbiguityRevisions = maxAmbiguityRevisions
    this.now = now
    this.pending = null
    this.stats = {attempted: 0, verified: 0, rejected: 0, ambiguous: 0, abandoned: 0}
  }

  #log(record) {
    this.journal?.append({kind: "command", ...record})
  }

  async submit(snapshot, action, {challenge = {}, reason = "agent"} = {}) {
    if (this.pending) {
      return {outcome: OUTCOME.IN_FLIGHT, commandId: this.pending.commandId}
    }
    const issue = validateAction(snapshot, action, challenge)
    if (issue) {
      this.stats.rejected += 1
      this.logger?.warn?.(`precheck rejected ${actionKey(action)}: ${issue}`)
      this.#log({phase: "precheck_rejected", issue, action, revision: snapshot.revision, reason})
      return {outcome: OUTCOME.REJECTED, issue, action}
    }

    const command = buildCommand(snapshot, action, {newId: this.newId})
    this.stats.attempted += 1
    this.pending = {
      commandId: command.commandId,
      action,
      expectedRevision: snapshot.revision,
      level: snapshot.level,
      gameId: snapshot.gameId,
      reason,
      sentAt: this.now(),
      receipt: null
    }
    this.#log({phase: "sent", commandId: command.commandId, revision: snapshot.revision, action, reason})

    let receipt
    try {
      const raw = await this.game.command(command)
      receipt = normalizeReceipt(raw, command.commandId)
    } catch (error) {
      if (error instanceof ContractError || error instanceof ProtocolError || error instanceof TransportError) {
        return this.#markAmbiguous(error)
      }
      throw error
    }

    this.pending.receipt = receipt
    if (receipt.status === "rejected") {
      const result = {outcome: OUTCOME.REJECTED, issue: receipt.issue ?? "rejected", receipt, commandId: command.commandId, action}
      this.stats.rejected += 1
      this.pending = null
      this.#log({phase: "rejected", ...result})
      return result
    }
    this.#log({phase: "acknowledged", commandId: command.commandId, receipt})
    // Applied or duplicate: still confirm against a fresh snapshot.
    return {outcome: OUTCOME.ACKNOWLEDGED, commandId: command.commandId, receipt, action, awaiting: "snapshot"}
  }

  #markAmbiguous(error) {
    const pending = this.pending
    if (!pending) throw new ContractError("ambiguous without pending command")
    pending.transportError = String(error?.message ?? error)
    this.stats.ambiguous += 1
    this.#log({phase: "ambiguous", commandId: pending.commandId, error: pending.transportError, action: pending.action})
    return {
      outcome: OUTCOME.AMBIGUOUS,
      commandId: pending.commandId,
      action: pending.action,
      error: pending.transportError
    }
  }

  /**
   * Reconcile the pending command against a fresh snapshot.
   * @returns {null|{outcome: string, commandId: string, action: object}}
   */
  observe(snapshot) {
    const pending = this.pending
    if (!pending) return null
    if (snapshot.gameId !== pending.gameId) {
      this.pending = null
      const result = {outcome: OUTCOME.ABANDONED, commandId: pending.commandId, action: pending.action, reason: "engine_changed"}
      this.stats.abandoned += 1
      this.#log({phase: "abandoned", ...result})
      return result
    }
    if (snapshot.revision <= pending.expectedRevision) return null

    if (effectVisible(snapshot, pending.action, {level: pending.level})) {
      this.pending = null
      this.stats.verified += 1
      const result = {
        outcome: OUTCOME.VERIFIED,
        commandId: pending.commandId,
        action: pending.action,
        revision: snapshot.revision,
        receipt: pending.receipt
      }
      this.#log({phase: "verified", ...result})
      return result
    }

    const advanced = snapshot.revision - pending.expectedRevision
    if (advanced >= this.maxAmbiguityRevisions) {
      this.pending = null
      this.stats.abandoned += 1
      const result = {
        outcome: OUTCOME.ABANDONED,
        commandId: pending.commandId,
        action: pending.action,
        reason: "effect_not_observed",
        revision: snapshot.revision
      }
      this.#log({phase: "abandoned", ...result})
      this.logger?.warn?.(`abandoned ${actionKey(pending.action)} after ${advanced} revisions`)
      return result
    }
    return null
  }

  /** True when a new command may be issued. */
  get ready() {
    return this.pending === null
  }

  describe() {
    return this.pending
      ? {commandId: this.pending.commandId, action: this.pending.action, expectedRevision: this.pending.expectedRevision}
      : null
  }
}
