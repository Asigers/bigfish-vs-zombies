import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import {BridgeClient} from "../src/adapters/bridge-client.mjs"
import {ContractError, ProtocolError, TransportError} from "../src/domain/errors.mjs"

const TOKEN = "test-token-0123456789"
const SNAPSHOT = {
  gameId: "native-1", revision: 42, level: 3, wave: 1, totalWaves: 5, sun: 125,
  rows: 5, columns: 9, status: "playing",
  plants: [{type: "sunflower", row: 1, col: 1}], zombies: [], suns: [],
  cards: [{type: "peashooter", cost: 100, ready: true}], blocked: []
}

async function serve(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const {port} = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

const json = (res, status, body) => {
  res.writeHead(status, {"content-type": "application/json"})
  res.end(JSON.stringify(body))
}

test("snapshot and command use the documented envelopes", async () => {
  const seen = []
  const srv = await serve((req, res) => {
    seen.push({url: req.url, auth: req.headers.authorization, method: req.method})
    if (req.url === "/v1/snapshot") return json(res, 200, {snapshot: SNAPSHOT})
    if (req.url === "/v1/command") {
      let body = ""
      req.on("data", (chunk) => { body += chunk })
      req.on("end", () => {
        const parsed = JSON.parse(body)
        json(res, 200, {
          receipt: {
            commandId: parsed.commandId,
            status: "applied",
            revisionBefore: parsed.expectedRevision,
            revisionAfter: parsed.expectedRevision + 1
          }
        })
      })
      return
    }
    json(res, 404, {})
  })

  const client = new BridgeClient({url: srv.url, token: TOKEN})
  const snapshot = await client.snapshot()
  assert.equal(snapshot.revision, 42)
  const receipt = await client.command({
    commandId: "c1",
    expectedRevision: 42,
    action: {type: "plant", plant: "peashooter", row: 2, col: 2}
  })
  assert.equal(receipt.status, "applied")
  assert.equal(receipt.commandId, "c1")
  assert.equal(seen.every((entry) => entry.auth === `Bearer ${TOKEN}`), true)
  await srv.close()
})

test("only loopback endpoints with a strong token are accepted", () => {
  assert.throws(() => new BridgeClient({url: "http://10.0.0.5:45941", token: TOKEN}), ContractError)
  assert.throws(() => new BridgeClient({url: "http://example.com:45941", token: TOKEN}), ContractError)
  assert.throws(() => new BridgeClient({url: "http://127.0.0.1:45941", token: "short"}), ContractError)
  assert.throws(() => new BridgeClient({url: "ftp://127.0.0.1:45941", token: TOKEN}), ContractError)
})

test("bad credentials and malformed replies are protocol errors", async () => {
  const unauthorized = await serve((req, res) => json(res, 401, {error: "unauthorized"}))
  const client = new BridgeClient({url: unauthorized.url, token: TOKEN})
  await assert.rejects(() => client.snapshot(), ProtocolError)
  await unauthorized.close()

  const garbage = await serve((req, res) => {
    res.writeHead(200, {"content-type": "application/json"})
    res.end("not json")
  })
  const client2 = new BridgeClient({url: garbage.url, token: TOKEN})
  await assert.rejects(() => client2.snapshot(), ProtocolError)
  await garbage.close()

  const noEnvelope = await serve((req, res) => json(res, 200, {ok: true}))
  const client3 = new BridgeClient({url: noEnvelope.url, token: TOKEN})
  await assert.rejects(() => client3.snapshot(), ProtocolError)
  await noEnvelope.close()
})

test("a command timeout surfaces as a retryable-safe transport error", async () => {
  const slow = await serve((req, res) => {
    setTimeout(() => json(res, 200, {receipt: {}}), 500)
  })
  const client = new BridgeClient({url: slow.url, token: TOKEN, commandTimeoutMs: 60})
  await assert.rejects(
    () => client.command({commandId: "slow", expectedRevision: 1, action: {type: "plant"}}),
    (error) => error instanceof TransportError && error.kind === "transport"
  )
  await slow.close()
})

test("server errors are transport errors, not rejections", async () => {
  const broken = await serve((req, res) => json(res, 503, {error: "busy"}))
  const client = new BridgeClient({url: broken.url, token: TOKEN})
  await assert.rejects(() => client.snapshot(), TransportError)
  await broken.close()
})

test("oversized responses are refused", async () => {
  const huge = await serve((req, res) => {
    res.writeHead(200, {"content-type": "application/json"})
    res.end(JSON.stringify({snapshot: {blob: "x".repeat(300 * 1024)}}))
  })
  const client = new BridgeClient({url: huge.url, token: TOKEN})
  await assert.rejects(() => client.snapshot(), ProtocolError)
  await huge.close()
})
