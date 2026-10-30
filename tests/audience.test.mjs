import assert from "node:assert/strict"
import test from "node:test"
import {AudienceDirector} from "../src/runtime/audience.mjs"
import {DOUYIN_SIGNED_HEADERS, douyinCommentBatch, signCallback, verifyDouyinCallback} from "../src/adapters/douyin.mjs"

test("one vote per viewer, deduplicated by message id", () => {
  const director = new AudienceDirector({now: () => 0})
  director.open({id: "p1", options: [{id: "a", label: "防守"}, {id: "b", label: "攒钱"}], durationMs: 1000, now: 100})
  assert.equal(director.comment({messageId: "m1", userId: "u1", content: "1"}, 200), "voted")
  assert.equal(director.comment({messageId: "m1", userId: "u1", content: "2"}, 210), "duplicate")
  assert.equal(director.comment({messageId: "m2", userId: "u1", content: "2"}, 220), "already_voted")
  assert.equal(director.comment({messageId: "m3", userId: "u2", content: "9"}, 230), "ignored")
  assert.equal(director.comment({messageId: "m4", userId: "u3", content: "鱼：现在几波？"}, 240), "question")
  assert.equal(director.close(500), null)
  const result = director.close(1100)
  assert.equal(result.winner, "a")
  assert.equal(result.total, 1)
  assert.equal(result.options.find((o) => o.id === "a").votes, 1)
})

test("a tie resolves deterministically to the first option", () => {
  const director = new AudienceDirector()
  director.open({id: "p", options: [{id: "a", label: "A"}, {id: "b", label: "B"}], durationMs: 10, now: 0})
  director.comment({messageId: "1", userId: "u1", content: "1"}, 1)
  director.comment({messageId: "2", userId: "u2", content: "2"}, 2)
  const result = director.close(20)
  assert.equal(result.tied, true)
  assert.equal(result.winner, "a")
})

test("winning a challenge bans plants until it expires", () => {
  const director = new AudienceDirector()
  director.open({
    id: "p",
    options: [
      {id: "a", label: "禁豌豆 60 秒", challenge: {bannedPlants: ["peashooter"], durationMs: 60_000}},
      {id: "b", label: "不限"}
    ],
    durationMs: 10,
    now: 0
  })
  director.comment({messageId: "1", userId: "u1", content: "1"}, 1)
  const result = director.close(20)
  assert.equal(result.winner, "a")
  assert.deepEqual(director.challenge(30_000), {bannedPlants: ["peashooter"]})
  assert.deepEqual(director.challenge(90_000), {bannedPlants: []})
})

test("no poll means no invented challenge", () => {
  const director = new AudienceDirector()
  assert.deepEqual(director.challenge(), {bannedPlants: []})
  assert.equal(director.summary(), null)
  assert.equal(director.close(), null)
})

test("a poll cannot be opened twice or with bad options", () => {
  const director = new AudienceDirector()
  director.open({id: "p", options: [{id: "a", label: "A"}, {id: "b", label: "B"}], durationMs: 100, now: 0})
  assert.throws(() => director.open({id: "q", options: [{id: "a", label: "A"}, {id: "b", label: "B"}]}), /poll_open/)
  assert.throws(() => new AudienceDirector().open({id: "q", options: [{id: "a", label: "A"}]}), /bad_options/)
})

test("comments normalize only from an authenticated, well-formed batch", () => {
  const headers = {"x-msg-type": "live_comment"}
  const batch = douyinCommentBatch(headers, JSON.stringify([
    {msg_id: "m1", sec_openid: "u1", content: "1", timestamp: 1700000000000},
    {msg_id: "m2", content: "no user"}
  ]))
  assert.equal(batch.length, 1)
  assert.deepEqual(batch[0], {
    platform: "douyin", messageId: "m1", userId: "u1", content: "1", timestamp: 1700000000000
  })
  assert.deepEqual(douyinCommentBatch({"x-msg-type": "live_gift"}, "[]"), [])
  assert.throws(() => douyinCommentBatch(headers, "{oops"), /invalid_payload/)
  assert.throws(() => douyinCommentBatch(headers, "{}"), /invalid_payload/)
})

test("callback signatures reject replays and tampering", () => {
  const secret = "gateway-secret"
  const rawBody = JSON.stringify([{msg_id: "m1", sec_openid: "u1", content: "1"}])
  const headers = {
    "x-nonce-str": "n1",
    "x-timestamp": "1700000000000",
    "x-roomid": "r1",
    "x-msg-type": "live_comment"
  }
  headers["x-signature"] = signCallback(headers, rawBody, secret)

  assert.deepEqual(verifyDouyinCallback({headers, rawBody, secret, now: 1_700_000_000_500}), {ok: true})
  assert.equal(verifyDouyinCallback({headers, rawBody, secret, now: 1_700_000_000_000 + 10 * 60_000}).reason, "stale_timestamp")
  assert.equal(verifyDouyinCallback({headers, rawBody: `${rawBody} `, secret, now: 1_700_000_000_000}).reason, "bad_signature")

  const missing = {...headers}
  delete missing["x-nonce-str"]
  assert.equal(verifyDouyinCallback({headers: missing, rawBody, secret, now: 1_700_000_000_000}).reason, "missing_x_nonce_str")
  assert.throws(() => verifyDouyinCallback({headers, rawBody, secret: "", now: 1_700_000_000_000}), /secret is not configured/)
  assert.equal(DOUYIN_SIGNED_HEADERS.length, 4)
})
