import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {OverlayServer} from "../src/overlay/server.mjs"
import {SpeechThrottle, speechForEvent} from "../src/overlay/speech.mjs"

async function fakeOverlayRoot() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bigfish-overlay-"))
  await fs.promises.mkdir(path.join(root, "assets/model"), {recursive: true})
  await fs.promises.mkdir(path.join(root, "assets/vendor"), {recursive: true})
  await fs.promises.mkdir(path.join(root, "assets/model/motions"), {recursive: true})
  await fs.promises.writeFile(path.join(root, "assets/model/motions/自拍简单.motion3.json"), "{}")
  await fs.promises.writeFile(path.join(root, "index.html"), "<html>Live2D stage</html>")
  await fs.promises.writeFile(path.join(root, "live2d.js"), "console.log('rig')")
  for (const file of ["vendor/live2dcubismcore.min.js", "vendor/pixi.min.js", "vendor/cubism4.min.js"]) {
    await fs.promises.writeFile(path.join(root, "assets", file), "// runtime")
  }
  for (const file of ["model/c_0120.model3.json", "model/c_0120.moc3", "model/manifest.json"]) {
    await fs.promises.writeFile(path.join(root, "assets", file), file.endsWith(".moc3") ? "moc" : "{}")
  }
  return root
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({host: "127.0.0.1", port, path: pathname}, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => { body += chunk })
      response.on("end", () => resolve({status: response.statusCode, headers: response.headers, body}))
    }).on("error", reject)
  })
}

test("speech lines only describe confirmed events", () => {
  const plant = speechForEvent({type: "command_verified", action: {type: "plant", plant: "peashooter", row: 3}}, {level: 2})
  assert.match(plant.text, /第3路/)
  assert.equal(plant.emotion, "happy")
  assert.equal(plant.goal, "第 2 关防守")

  assert.equal(speechForEvent({type: "command_verified", action: {type: "plant", plant: "cherrybomb", row: 4}}).emotion, "surprised")
  assert.equal(speechForEvent({type: "command_verified", action: {type: "collect_sun"}}).text, "阳光收下。")
  assert.equal(speechForEvent({type: "command_rejected"}).emotion, "thinking")
  assert.equal(speechForEvent({type: "command_abandoned"}).emotion, "thinking")

  const cleared = speechForEvent({type: "level_summary", level: 5, cleared: true})
  assert.match(cleared.text, /第 5 关/)
  assert.equal(cleared.emotion, "excited")

  assert.equal(speechForEvent({type: "finished", reason: "campaign_complete"}).emotion, "excited")
  assert.equal(speechForEvent({type: "finished", reason: "lost"}).emotion, "sad")
  assert.equal(speechForEvent({type: "narration", text: "稳住别慌"}).text, "稳住别慌")
  assert.equal(speechForEvent({type: "snapshot"}), null)
  assert.equal(speechForEvent({type: "command_verified", action: {type: "shovel"}}), null)
})

test("speech is throttled but level events always pass", () => {
  let now = 0
  const throttle = new SpeechThrottle({minIntervalMs: 5000, now: () => now})
  assert.equal(throttle.accept({type: "command_verified"}), true)
  now = 1000
  assert.equal(throttle.accept({type: "command_verified"}), false)
  now = 1001
  assert.equal(throttle.accept({type: "level_summary"}), true)
  now = 2000
  assert.equal(throttle.accept({type: "level_summary"}), true)
  now = 9000
  assert.equal(throttle.accept({type: "command_verified"}), true)
})

test("overlay server serves the OBS page, assets and status", async () => {
  const root = await fakeOverlayRoot()
  const server = await new OverlayServer({root, port: 0, logger: {info() {}, error() {}}}).start()
  try {
    const page = await get(server.port, "/overlay")
    assert.equal(page.status, 200)
    assert.match(page.headers["content-type"], /text\/html/)
    assert.match(page.body, /Live2D stage/)

    const status = await get(server.port, "/overlay/assets/status")
    assert.equal(JSON.parse(status.body).installed, true)

    const model = await get(server.port, "/overlay/assets/model/manifest.json")
    assert.equal(model.status, 200)
    assert.match(model.headers["content-type"], /json/)

    const motion = await get(server.port, "/overlay/assets/model/motions/%E8%87%AA%E6%8B%8D%E7%AE%80%E5%8D%95.motion3.json")
    assert.equal(motion.status, 200)

    const missing = await get(server.port, "/overlay/../package.json")
    assert.equal(missing.status, 404)
    const traversal = await get(server.port, "/overlay/assets/%2e%2e/%2e%2e/package.json")
    assert.equal(traversal.status, 404)
  } finally {
    await server.stop()
  }
})

test("status reports missing assets instead of failing", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bigfish-empty-"))
  const server = await new OverlayServer({root, port: 0, logger: {info() {}, error() {}}}).start()
  try {
    const status = await get(server.port, "/overlay/assets/status")
    const body = JSON.parse(status.body)
    assert.equal(body.installed, false)
    assert.ok(body.missing.includes("model/c_0120.moc3"))
  } finally {
    await server.stop()
  }
})

test("published speech reaches SSE clients", async () => {
  const root = await fakeOverlayRoot()
  const server = await new OverlayServer({root, port: 0, logger: {info() {}, error() {}}}).start()
  try {
    const received = await new Promise((resolve, reject) => {
      const request = http.get({host: "127.0.0.1", port: server.port, path: "/overlay/events"}, (response) => {
        assert.match(response.headers["content-type"], /text\/event-stream/)
        let buffer = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => {
          buffer += chunk
          if (buffer.includes("event: speech")) {
            request.destroy()
            resolve(buffer)
          }
        })
        setTimeout(() => server.publish({text: "第3路，上豌豆。", emotion: "happy", goal: "防守"}), 60)
      })
      request.on("error", reject)
      setTimeout(() => reject(new Error("no SSE event")), 4000).unref()
    })
    assert.match(received, /"text":"第3路，上豌豆。"/)
    assert.match(received, /"emotion":"happy"/)
  } finally {
    await server.stop()
  }
})

test("overlay refuses to bind a public interface", () => {
  assert.throws(() => new OverlayServer({root: "/tmp", host: "0.0.0.0", port: 0}), /loopback/)
})
