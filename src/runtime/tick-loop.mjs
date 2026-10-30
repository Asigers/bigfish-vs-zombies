import {CancelledError} from "../domain/errors.mjs"

export const systemClock = {now: () => Date.now()}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fixed-cadence control loop with single-flight semantics.
 *
 * A slow cycle never stacks up: the next tick is skipped and counted instead of
 * queued. Failures are isolated per tick; only a sustained run of failures
 * stops the loop, so a transient bridge hiccup cannot kill a live stream.
 */
export class TickLoop {
  constructor({
    intervalMs = 250,
    onTick,
    onError = null,
    onSkip = null,
    clock = systemClock,
    logger = console,
    maxConsecutiveErrors = 6
  }) {
    this.intervalMs = intervalMs
    this.onTick = onTick
    this.onError = onError
    this.onSkip = onSkip
    this.clock = clock
    this.logger = logger
    this.maxConsecutiveErrors = maxConsecutiveErrors

    this.running = false
    this.inFlight = false
    this.stopped = false
    this.tickCount = 0
    this.skipped = 0
    this.consecutiveErrors = 0
    this.lastError = null
    this.promise = null
    this.stopRequested = false
  }

  async step() {
    if (this.inFlight) {
      this.skipped += 1
      this.onSkip?.({skipped: this.skipped})
      return {skipped: true}
    }
    this.inFlight = true
    try {
      const result = await this.onTick({tick: this.tickCount})
      this.tickCount += 1
      this.consecutiveErrors = 0
      return {skipped: false, result}
    } catch (error) {
      this.tickCount += 1
      this.consecutiveErrors += 1
      this.lastError = error
      this.onError?.(error)
      this.logger?.error?.(`tick failed (${this.consecutiveErrors}/${this.maxConsecutiveErrors}): ${error.message}`)
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        this.stopRequested = true
        throw error
      }
      return {skipped: false, error}
    } finally {
      this.inFlight = false
    }
  }

  /** Run a bounded number of cycles. Used by tests and by `--cycles`. */
  async run({cycles = 100, advance = null} = {}) {
    for (let i = 0; i < cycles; i += 1) {
      if (this.stopped) break
      advance?.(this.intervalMs)
      const result = await this.step()
      if (result.error && this.consecutiveErrors >= this.maxConsecutiveErrors) break
    }
    return {ticks: this.tickCount, skipped: this.skipped}
  }

  start() {
    if (this.running) throw new Error("loop already started")
    this.running = true
    this.promise = this.#runReal()
    return this
  }

  async #runReal() {
    let next = this.clock.now()
    while (!this.stopRequested) {
      next += this.intervalMs
      const wait = next - this.clock.now()
      if (wait > 0) await sleep(wait)
      if (this.stopRequested) break
      try {
        await this.step()
      } catch {
        break
      }
      if (this.clock.now() - next > this.intervalMs * 4) next = this.clock.now()
    }
    this.running = false
  }

  async stop({drain = true} = {}) {
    this.stopRequested = true
    this.stopped = true
    if (drain && this.promise) {
      try {
        await this.promise
      } catch {
        // surfaced through onError
      }
    }
  }

  /** Wait for the in-flight cycle to finish (used on shutdown). */
  async idle() {
    while (this.inFlight) await sleep(5)
  }
}

export function withTimeout(promise, ms, onTimeout = () => new CancelledError(`timeout after ${ms}ms`)) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
