import {ContractError, ProtocolError, RejectedError, TransportError} from "../domain/errors.mjs"

const MAX_BODY_BYTES = 256 * 1024
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

async function readBounded(response) {
  const text = await response.text()
  if (text.length > MAX_BODY_BYTES) throw new ProtocolError("bridge response too large")
  return text
}

/**
 * Authenticated loopback client for the native PvZ bridge.
 *
 * Reads may be retried by the caller. Commands are never retried here: a
 * timeout is surfaced as `TransportError` so the executor can treat the command
 * as ambiguous instead of double-planting.
 */
export class BridgeClient {
  constructor({
    url = "http://127.0.0.1:45941",
    token,
    fetchImpl = globalThis.fetch,
    snapshotTimeoutMs = 1500,
    commandTimeoutMs = 3000,
    logger = null
  } = {}) {
    const parsed = new URL(url)
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new ContractError(`bridge must be loopback-only, got ${parsed.hostname}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ContractError(`unsupported bridge protocol ${parsed.protocol}`)
    }
    if (typeof token !== "string" || token.length < 16) {
      throw new ContractError("bridge token must be a string of at least 16 characters")
    }
    if (typeof fetchImpl !== "function") throw new ContractError("fetch implementation required")

    this.origin = parsed.origin
    this.token = token
    this.fetchImpl = fetchImpl
    this.snapshotTimeoutMs = snapshotTimeoutMs
    this.commandTimeoutMs = commandTimeoutMs
    this.logger = logger
  }

  async #request(path, {method = "GET", body = null, timeoutMs} = {}) {
    const headers = {authorization: `Bearer ${this.token}`, accept: "application/json"}
    if (body) headers["content-type"] = "application/json"
    let response
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      throw new TransportError(`bridge ${method} ${path} failed: ${error.message}`, {path, cause: error})
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProtocolError(`bridge rejected credentials (${response.status})`, {status: response.status})
    }
    if (response.status === 409) {
      const text = await readBounded(response).catch(() => "")
      throw new RejectedError(text || "bridge conflict", {status: 409})
    }
    if (response.status >= 500) {
      throw new TransportError(`bridge unavailable (${response.status})`, {status: response.status})
    }
    if (!response.ok) {
      throw new ProtocolError(`bridge ${path} returned ${response.status}`, {status: response.status})
    }

    const text = await readBounded(response)
    try {
      return JSON.parse(text)
    } catch {
      throw new ProtocolError("bridge returned malformed JSON")
    }
  }

  async snapshot() {
    const body = await this.#request("/v1/snapshot", {timeoutMs: this.snapshotTimeoutMs})
    if (!body || typeof body !== "object" || !body.snapshot) {
      throw new ProtocolError("bridge snapshot envelope missing `snapshot`")
    }
    return body.snapshot
  }

  async command({commandId, expectedRevision, action}) {
    const body = await this.#request("/v1/command", {
      method: "POST",
      body: {commandId, expectedRevision, action},
      timeoutMs: this.commandTimeoutMs
    })
    if (!body || typeof body !== "object" || !body.receipt) {
      throw new ProtocolError("bridge command envelope missing `receipt`")
    }
    return body.receipt
  }

  async health() {
    return this.#request("/v1/health", {timeoutMs: this.snapshotTimeoutMs})
  }

  async close() {}
}
