/** Typed failures. Callers branch on `kind`, never on message text. */

export class BigFishError extends Error {
  constructor(message, {kind = "internal", cause, details = {}} = {}) {
    super(message, {cause})
    this.name = new.target.name
    this.kind = kind
    this.details = details
  }
}

/** A value crossing a module boundary did not match the contract. */
export class ContractError extends BigFishError {
  constructor(message, details) {
    super(message, {kind: "contract", details})
  }
}

/** A read failed in a way that is safe to retry (snapshot polling). */
export class TransportError extends BigFishError {
  constructor(message, details) {
    super(message, {kind: "transport", details})
  }
}

/** The engine answered, but not with a well-formed response. */
export class ProtocolError extends BigFishError {
  constructor(message, details) {
    super(message, {kind: "protocol", details})
  }
}

/** The engine refused the command. Deterministic: never retried. */
export class RejectedError extends BigFishError {
  constructor(message, details) {
    super(message, {kind: "rejected", details})
  }
}

/** The loop was asked to stop while an operation was in flight. */
export class CancelledError extends BigFishError {
  constructor(message = "cancelled", details) {
    super(message, {kind: "cancelled", details})
  }
}
