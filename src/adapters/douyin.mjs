import {createHash, timingSafeEqual} from "node:crypto"
import {ContractError} from "../domain/errors.mjs"

/**
 * Normalizer for approved Douyin live-play comment pushes.
 *
 * This module is deliberately downstream of authentication: it must only ever
 * be fed events that an approved gateway has already verified. The verification
 * helper below is defence in depth, and its canonical form must be confirmed
 * against the current official documentation before production use.
 */
export const DOUYIN_SIGNED_HEADERS = Object.freeze([
  "x-nonce-str",
  "x-timestamp",
  "x-roomid",
  "x-msg-type"
])

export function douyinCommentBatch(headers, rawBody, {maxBatch = 500} = {}) {
  if (!headers || typeof headers !== "object") throw new ContractError("headers required")
  if (headers["x-msg-type"] !== "live_comment") return []
  if (typeof rawBody !== "string" || rawBody.length > 1_000_000) throw new ContractError("invalid_payload")
  let data
  try {
    data = JSON.parse(rawBody)
  } catch {
    throw new ContractError("invalid_payload")
  }
  if (!Array.isArray(data)) throw new ContractError("invalid_payload")
  return data
    .slice(0, maxBatch)
    .filter((item) => typeof item?.msg_id === "string" &&
      typeof item?.sec_openid === "string" &&
      typeof item?.content === "string")
    .map((item) => ({
      platform: "douyin",
      messageId: item.msg_id,
      userId: item.sec_openid,
      content: item.content.slice(0, 200),
      timestamp: Number(item.timestamp) || 0
    }))
}

export function canonicalCallbackString(headers, rawBody) {
  const parts = DOUYIN_SIGNED_HEADERS.map((name) => `${name}=${headers[name] ?? ""}`)
  return `${parts.join("\n")}\n${rawBody}`
}

export function signCallback(headers, rawBody, secret) {
  return createHash("md5").update(canonicalCallbackString(headers, rawBody) + secret).digest("base64")
}

/**
 * Verify an approved-platform callback. Rejects missing headers, stale
 * timestamps (replay window) and bad signatures. Never logs the secret.
 */
export function verifyDouyinCallback({
  headers,
  rawBody,
  secret,
  now = Date.now(),
  maxSkewMs = 5 * 60 * 1000,
  signature = headers?.["x-signature"]
}) {
  if (!secret) throw new ContractError("callback secret is not configured")
  for (const name of DOUYIN_SIGNED_HEADERS) {
    if (typeof headers?.[name] !== "string" || headers[name].length === 0) {
      return {ok: false, reason: `missing_${name.replace(/-/g, "_")}`}
    }
  }
  const timestamp = Number(headers["x-timestamp"])
  if (!Number.isFinite(timestamp)) return {ok: false, reason: "bad_timestamp"}
  if (Math.abs(now - timestamp) > maxSkewMs) return {ok: false, reason: "stale_timestamp"}
  if (typeof signature !== "string" || !signature) return {ok: false, reason: "missing_signature"}
  const expected = signCallback(headers, rawBody, secret)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return {ok: false, reason: "bad_signature"}
  return {ok: true}
}
