import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {Journal, pendingFromJournal, readJournal, summariseJournal} from "../src/runtime/journal.mjs"

async function tmpJournal() {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bigfish-journal-"))
  return {dir, file: path.join(dir, "nested", "journal.jsonl")}
}

test("journal records are appended in order and readable", async () => {
  const {file} = await tmpJournal()
  const journal = await Journal.open(file)
  journal.append({kind: "event", type: "started"})
  journal.append({kind: "command", phase: "sent", commandId: "c1", revision: 4, action: {type: "plant"}})
  journal.append({kind: "command", phase: "verified", commandId: "c1"})
  await journal.close()

  const {records, corrupt} = await readJournal(file)
  assert.equal(corrupt, 0)
  assert.deepEqual(records.map((r) => r.seq), [1, 2, 3])
  assert.deepEqual(summariseJournal(records), {sent: 1, verified: 1})
})

test("a torn last line does not lose earlier records", async () => {
  const {file} = await tmpJournal()
  const journal = await Journal.open(file)
  journal.append({kind: "event", type: "a"})
  await journal.flush()
  await fs.promises.appendFile(file, '{"kind":"event","type":"torn"')
  await journal.close()

  const {records, corrupt} = await readJournal(file)
  assert.equal(records.length, 1)
  assert.equal(corrupt, 1)
})

test("pending intents are recovered from the journal across a restart", async () => {
  const {file} = await tmpJournal()
  const journal = await Journal.open(file)
  journal.append({kind: "command", phase: "sent", commandId: "c1", revision: 10, action: {type: "plant", row: 1, col: 1}})
  journal.append({kind: "command", phase: "verified", commandId: "c1"})
  journal.append({kind: "command", phase: "sent", commandId: "c2", revision: 11, action: {type: "collect_sun", id: "s1"}})
  await journal.close()

  const {records} = await readJournal(file)
  const pending = pendingFromJournal(records)
  assert.equal(pending.commandId, "c2")
  assert.equal(pending.action.type, "collect_sun")
  assert.equal(pending.expectedRevision, 11)
})

test("no pending intent after a cleanly resolved command", async () => {
  const {file} = await tmpJournal()
  const journal = await Journal.open(file)
  journal.append({kind: "command", phase: "sent", commandId: "c1", revision: 1, action: {type: "plant"}})
  journal.append({kind: "command", phase: "abandoned", commandId: "c1"})
  await journal.close()
  const {records} = await readJournal(file)
  assert.equal(pendingFromJournal(records), null)
})
