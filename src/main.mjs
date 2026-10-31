#!/usr/bin/env node
/**
 * BigFish vs Zombies controller entrypoint.
 *
 *   node src/main.mjs --engine=sim
 *   node src/main.mjs --engine=bridge
 *   node src/main.mjs --engine=bridge --agent=pi
 *
 * Live bridge defaults to the autonomous Pi brain. Simulation defaults to the
 * deterministic fallback so tests and offline campaigns need no model login.
 */
import path from "node:path"
import process from "node:process"
import {AudienceDirector} from "./runtime/audience.mjs"
import {BridgeClient} from "./adapters/bridge-client.mjs"
import {HeuristicAgent} from "./agents/heuristic.mjs"
import {Journal} from "./runtime/journal.mjs"
import {Orchestrator} from "./runtime/orchestrator.mjs"
import {ActionExecutor} from "./runtime/executor.mjs"
import {SimulatedGame} from "./adapters/simulated-game.mjs"
import {TickLoop, systemClock} from "./runtime/tick-loop.mjs"

function parseArgs(argv) {
  const args = {
    engine: "sim",
    agent: "auto",
    levels: 10,
    tick: 250,
    cycles: 0,
    quiet: false,
    journal: null,
    seed: 7,
    url: null,
    token: null,
    overlay: false,
    help: false
  }
  for (const raw of argv.slice(2)) {
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(raw)
    if (!match) continue
    const [, key, value] = match
    switch (key) {
      case "engine": args.engine = value ?? "sim"; break
      case "agent": args.agent = value ?? "auto"; break
      case "levels": args.levels = Number(value); break
      case "tick": args.tick = Number(value); break
      case "cycles": args.cycles = Number(value); break
      case "journal": args.journal = value; break
      case "url": args.url = value; break
      case "token": args.token = value; break
      case "seed": args.seed = Number(value); break
      case "overlay":
        args.overlay = value === undefined ? 45931 : Number(value)
        break
      case "quiet": args.quiet = true; break
      case "help": args.help = true; break
      default: break
    }
  }
  return args
}

function usage() {
  return [
    "Usage: node src/main.mjs [options]",
    "",
    "  --engine=sim|bridge       game backend (default: sim)",
    "  --agent=auto|pi|heuristic decision maker (bridge auto=pi, sim auto=heuristic)",
    "  --levels=10               campaign target level",
    "  --tick=250                control cycle in ms (sim: virtual ms)",
    "  --cycles=N                stop after N cycles (0 = until finished)",
    "  --journal=PATH            JSONL audit trail (default .state/journal.jsonl)",
    "  --url=URL --token=T       bridge endpoint (or BIGFISH_BRIDGE_URL/TOKEN)",
    "  --seed=N                  simulator seed",
    "  --overlay[=PORT]          serve the Live2D OBS browser source (default 45931)",
    "  --quiet                   no progress output"
  ].join("\n")
}

class VirtualClock {
  constructor(start = 0) { this.ms = start }
  now() { return this.ms }
  advance(ms) { this.ms += ms }
}

function makeLogger(quiet) {
  return {
    info: (msg) => { if (!quiet) process.stdout.write("[info] " + msg + "\n") },
    warn: (msg) => process.stderr.write("[warn] " + msg + "\n"),
    error: (msg) => process.stderr.write("[error] " + msg + "\n"),
    debug: () => {}
  }
}

function progressLine(orchestrator) {
  const snapshot = orchestrator.snapshot
  if (!snapshot) return null
  const verified = orchestrator.stats.verified
  const pending = orchestrator.executor.pending ? " (confirming)" : ""
  return "L" + snapshot.level + " wave " + snapshot.wave + "/" + snapshot.totalWaves +
    " sun " + snapshot.sun + " zombies " + snapshot.zombies.length +
    " verified " + verified + pending
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    process.stdout.write(usage() + "\n")
    return 0
  }
  if (!["sim", "bridge"].includes(args.engine)) throw new Error("unknown engine: " + args.engine)

  const agentName = args.agent === "auto"
    ? (args.engine === "bridge" ? "pi" : "heuristic")
    : args.agent
  if (!["pi", "heuristic"].includes(agentName)) throw new Error("unknown agent: " + agentName)

  const logger = makeLogger(args.quiet)
  const journalPath = args.journal ?? path.resolve(process.cwd(), ".state/journal.jsonl")
  const journal = await Journal.open(journalPath)
  const audience = new AudienceDirector()

  let clock = systemClock
  let game
  if (args.engine === "sim") {
    clock = new VirtualClock(0)
    game = new SimulatedGame({seed: args.seed, levels: args.levels, now: () => clock.now()})
  } else {
    game = new BridgeClient({
      url: args.url ?? process.env.BIGFISH_BRIDGE_URL ?? "http://127.0.0.1:45941",
      token: args.token ?? process.env.BIGFISH_BRIDGE_TOKEN,
      logger
    })
  }

  let agent
  if (agentName === "pi") {
    const {PiAgent} = await import("./adapters/pi-agent.mjs")
    agent = new PiAgent({logger})
    await agent.start()
  } else {
    agent = new HeuristicAgent()
  }

  const {OverlayServer} = await import("./overlay/server.mjs")
  const {SpeechThrottle, speechForEvent} = await import("./overlay/speech.mjs")
  let overlay = null
  const speech = new SpeechThrottle()
  if (args.overlay !== false && args.overlay > 0) {
    overlay = new OverlayServer({
      root: path.resolve(process.cwd(), "overlay"),
      port: args.overlay,
      logger
    })
    await overlay.start()
  }

  const executor = new ActionExecutor({game, journal, logger, now: () => clock.now()})
  const orchestrator = new Orchestrator({
    game,
    agent,
    executor,
    journal,
    clock,
    logger,
    audience,
    config: {targetLevels: args.levels},
    onEvent: (event) => {
      if (event.type === "narration") logger.info("BigFish: " + event.text)
      if (event.type === "strategy_update") logger.info("BigFish strategy: " + event.goal)
      if (overlay && speech.accept(event)) {
        const line = speechForEvent(event, {level: event.level ?? 1})
        if (line) overlay.publish(line)
      }
      if (event.type === "level_summary" && !args.quiet) {
        const seconds = (event.durationMs / 1000).toFixed(1)
        logger.info("level " + event.level + " " + (event.cleared ? "cleared" : "ended") +
          " in " + seconds + "s (" + event.commands + " commands)")
      }
    }
  })

  const loop = new TickLoop({
    intervalMs: args.tick,
    clock,
    logger,
    onTick: () => orchestrator.step()
  })

  let interrupted = false
  const onSignal = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    logger.warn("shutting down…")
    loop.stopRequested = true
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  let failure = null
  try {
    if (args.engine === "sim") {
      const budget = args.cycles > 0 ? args.cycles : Math.max(2000, args.levels * 3000)
      let printed = 0
      for (let index = 0; index < budget && !orchestrator.done && !interrupted; index += 1) {
        clock.advance(args.tick)
        const result = await loop.step()
        if (result.error) throw result.error
        if (!args.quiet && index >= printed) {
          printed = index + 40
          const line = progressLine(orchestrator)
          if (line) process.stdout.write("[sim t=" + (clock.now() / 1000).toFixed(1) + "s] " + line + "\n")
        }
      }
    } else {
      const health = await game.health().catch((error) => {
        throw new Error("bridge is not reachable: " + error.message)
      })
      logger.info("bridge " + (health.service ?? "pvz") + " schema " +
        (health.schema ?? "?") + " at " + game.origin)
      loop.start()
      while (!orchestrator.done && !interrupted) {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      await loop.stop()
    }
  } catch (error) {
    failure = error
    logger.error(error.stack ?? error.message)
  } finally {
    await loop.stop({drain: true}).catch(() => {})
    await agent.close?.().catch(() => {})
    await game.close?.().catch(() => {})
    await overlay?.stop().catch(() => {})
    await journal.close()
  }

  const summary = orchestrator.summary()
  process.stdout.write(JSON.stringify({
    engine: args.engine,
    agent: agentName,
    finished: summary.finished,
    failure: failure?.message ?? null,
    levels: summary.levels.map((level) => ({
      level: level.level,
      cleared: level.cleared,
      seconds: Math.round(level.durationMs / 1000)
    })),
    stats: summary.stats
  }, null, 2) + "\n")

  if (failure) return 2
  return summary.finished?.reason === "campaign_complete" ? 0 : 1
}

const code = await main()
process.exitCode = code
