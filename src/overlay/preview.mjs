#!/usr/bin/env node
/**
 * Preview the Live2D OBS surface without starting a game:
 *
 *   npm run overlay            # http://127.0.0.1:45931/overlay
 *   npm run overlay -- --port=45932
 *
 * Cycles sample reactions so the model, expressions and mouth movement can be
 * checked in a browser or in an OBS browser source.
 */
import path from "node:path"
import process from "node:process"
import {OverlayServer} from "./server.mjs"

const SAMPLES = [
  {text: "第3路，上豌豆。", emotion: "happy", goal: "第 1 关防守"},
  {text: "阳光收下。", emotion: "happy", goal: "第 1 关攒经济"},
  {text: "第5路，坚果顶住。", emotion: "thinking", goal: "第 1 关防守"},
  {text: "樱桃炸弹！", emotion: "surprised", goal: "第 2 关救场"},
  {text: "第 2 关，拿下！", emotion: "excited", goal: "过关"},
  {text: "这局没守住，重来。", emotion: "sad", goal: "复盘"}
]

const portArg = process.argv.find((arg) => arg.startsWith("--port="))
const port = portArg ? Number(portArg.slice("--port=".length)) : 45931

const server = new OverlayServer({root: path.resolve(process.cwd(), "overlay"), port})
await server.start()
const status = await server.assetStatus()
if (!status.installed) {
  process.stderr.write(`模型或运行时缺失：${status.missing.join(", ")}\n` +
    "先执行：npm run overlay:install -- --acknowledge-noncommercial\n")
}

let index = 0
const tick = () => server.publish(SAMPLES[index++ % SAMPLES.length])
setTimeout(tick, 1500)
const timer = setInterval(tick, 6000)

const shutdown = async () => {
  clearInterval(timer)
  await server.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
process.stdout.write(`preview: http://127.0.0.1:${server.port}/overlay?preview=0\n`)
