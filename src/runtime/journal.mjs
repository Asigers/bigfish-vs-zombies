import fs from "node:fs"
import path from "node:path"

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * Append-only JSONL audit trail. Writes are serialised through a promise chain
 * so a slow disk cannot interleave lines or block the control loop.
 */
export class Journal {
  constructor(file) {
    this.file = file
    this.seq = 0
    this.handle = null
    this.chain = Promise.resolve()
    this.closed = false
    this.errors = 0
  }

  static async open(file) {
    const journal = new Journal(file)
    await fs.promises.mkdir(path.dirname(file), {recursive: true})
    journal.handle = await fs.promises.open(file, "a")
    return journal
  }

  append(record) {
    if (this.closed) return
    if (!isRecord(record)) throw new TypeError("journal record must be an object")
    this.seq += 1
    const line = `${JSON.stringify({ts: Date.now(), seq: this.seq, ...record})}\n`
    this.chain = this.chain
      .then(() => this.handle.write(line))
      .catch((error) => {
        this.errors += 1
        process.emitWarning(`journal write failed: ${error.message}`)
      })
    return this.chain
  }

  async flush() {
    await this.chain
    await this.handle?.sync().catch(() => {})
  }

  async close() {
    if (this.closed) return
    await this.flush()
    this.closed = true
    await this.handle?.close()
    this.handle = null
  }
}

export async function readJournal(file) {
  const text = await fs.promises.readFile(file, "utf8")
  const records = []
  let corrupt = 0
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      corrupt += 1
    }
  }
  return {records, corrupt}
}

/** Reconstruct the executor's pending intent so a restart is never a replay. */
export function pendingFromJournal(records) {
  const open = new Map()
  for (const record of records) {
    if (record.kind !== "command" || typeof record.commandId !== "string") continue
    if (record.phase === "sent") open.set(record.commandId, record)
    if (["verified", "rejected", "abandoned", "precheck_rejected"].includes(record.phase)) {
      open.delete(record.commandId)
    }
  }
  const last = [...open.values()].pop()
  return last
    ? {
      commandId: last.commandId,
      action: last.action,
      expectedRevision: last.revision,
      gameId: last.action?.gameId,
      level: last.action?.level,
      reason: last.reason
    }
    : null
}

export function summariseJournal(records) {
  const phases = {}
  for (const record of records) {
    if (record.kind !== "command" || typeof record.phase !== "string") continue
    phases[record.phase] = (phases[record.phase] ?? 0) + 1
  }
  return phases
}
