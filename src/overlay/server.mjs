import {createReadStream} from "node:fs"
import fs from "node:fs/promises"
import http from "node:http"
import path from "node:path"

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".moc3": "application/octet-stream",
  ".exp3.json": "application/json; charset=utf-8",
  ".motion3.json": "application/json; charset=utf-8"
})

const REQUIRED_ASSETS = [
  "vendor/live2dcubismcore.min.js",
  "vendor/pixi.min.js",
  "vendor/cubism4.min.js",
  "model/c_0120.model3.json",
  "model/c_0120.moc3",
  "model/manifest.json"
]

function contentType(file) {
  const lower = file.toLowerCase()
  for (const [suffix, type] of Object.entries(MIME)) {
    if (lower.endsWith(suffix)) return type
  }
  return "application/octet-stream"
}

/**
 * Serves the OBS browser source for the Live2D character and streams speech
 * events to it over SSE.
 *
 * Everything binds to loopback: the overlay is a local capture surface, never a
 * public page. Model and runtime files live outside git (see docs/LIVE2D.md).
 */
export class OverlayServer {
  constructor({root, host = "127.0.0.1", port = 45931, logger = console} = {}) {
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error("overlay must bind loopback")
    this.root = path.resolve(root)
    this.host = host
    this.port = port
    this.logger = logger
    this.server = null
    this.clients = new Set()
    this.heartbeat = null
    this.last = null
  }

  async assetStatus() {
    const missing = []
    for (const relative of REQUIRED_ASSETS) {
      try {
        await fs.access(path.join(this.root, "assets", relative))
      } catch {
        missing.push(relative)
      }
    }
    return {installed: missing.length === 0, missing}
  }

  async start() {
    if (this.server) return this
    const status = await this.assetStatus()
    this.server = http.createServer((request, response) => {
      this.#handle(request, response).catch((error) => {
        this.logger?.error?.(`overlay request failed: ${error.message}`)
        if (!response.headersSent) response.writeHead(500, {"content-type": "text/plain"})
        response.end("overlay error")
      })
    })
    this.server.keepAliveTimeout = 5000
    await new Promise((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(this.port, this.host, resolve)
    })
    this.port = this.server.address().port
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) client.write(": ping\n\n")
    }, 15_000)
    this.heartbeat.unref?.()
    this.logger?.info?.(`overlay http://${this.host}:${this.port}/overlay` +
      (status.installed ? "" : " (model not installed: npm run overlay:install)"))
    return this
  }

  async stop() {
    clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const client of this.clients) client.end()
    this.clients.clear()
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise((resolve) => server.close(resolve))
  }

  /** Push one speech event to every connected OBS browser source. */
  publish(event) {
    if (!event || typeof event.text !== "string" || !event.text) return false
    const payload = {
      text: event.text.slice(0, 120),
      emotion: typeof event.emotion === "string" ? event.emotion.slice(0, 16) : "idle",
      goal: typeof event.goal === "string" ? event.goal.slice(0, 60) : "打僵尸"
    }
    this.last = payload
    const frame = `event: speech\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of this.clients) client.write(frame)
    return this.clients.size > 0
  }

  async #handle(request, response) {
    const url = new URL(request.url ?? "/", `http://${this.host}:${this.port}`)
    let pathname
    try {
      // Model and motion files use Chinese names; match the decoded filesystem path.
      pathname = decodeURIComponent(url.pathname)
    } catch {
      response.writeHead(400, {"content-type": "text/plain; charset=utf-8"}).end("bad path")
      return
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end()
      return
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {"allow": "GET, HEAD"}).end()
      return
    }

    if (pathname === "/overlay/events") {
      this.#stream(response)
      return
    }
    if (pathname === "/overlay/assets/status") {
      this.#json(response, await this.assetStatus())
      return
    }
    if (pathname === "/overlay/health") {
      this.#json(response, {ok: true, clients: this.clients.size, last: this.last})
      return
    }

    let relative
    if (pathname === "/overlay" || pathname === "/overlay/") {
      relative = "index.html"
    } else if (pathname === "/overlay/live2d.js") {
      relative = "live2d.js"
    } else if (pathname.startsWith("/overlay/assets/")) {
      relative = pathname.slice("/overlay/".length)
    } else {
      response.writeHead(404, {"content-type": "text/plain; charset=utf-8"}).end("not found")
      return
    }

    const resolved = path.resolve(this.root, relative)
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      response.writeHead(404, {"content-type": "text/plain; charset=utf-8"}).end("not found")
      return
    }
    let stat
    try {
      stat = await fs.stat(resolved)
    } catch {
      response.writeHead(404, {"content-type": "text/plain; charset=utf-8"}).end("not found")
      return
    }
    if (!stat.isFile()) {
      response.writeHead(404, {"content-type": "text/plain; charset=utf-8"}).end("not found")
      return
    }

    response.writeHead(200, {
      "content-type": contentType(resolved),
      "content-length": stat.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    })
    if (request.method === "HEAD") {
      response.end()
      return
    }
    createReadStream(resolved).pipe(response)
  }

  #stream(response) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    })
    response.write("retry: 2000\n\n")
    if (this.last) response.write(`event: speech\ndata: ${JSON.stringify(this.last)}\n\n`)
    this.clients.add(response)
    const drop = () => this.clients.delete(response)
    response.on("close", drop)
    response.on("error", drop)
  }

  #json(response, body) {
    const text = JSON.stringify(body)
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store"
    })
    response.end(text)
  }
}
