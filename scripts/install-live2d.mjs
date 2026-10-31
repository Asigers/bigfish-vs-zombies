#!/usr/bin/env node
/**
 * Fetches optional noncommercial Live2D assets from a pinned upstream Git commit.
 * Keep verified files in an ignored persistent cache, so network failures do not
 * require downloading everything again. Never add model art to BigFish Git.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM = "Andersen216/dsh-whale-girl-live2d";
export const REVISION = "f977bef508690e75ba6535cd8f4ce18e7f6ba9b0";
const sourceRoot = "assets/";
const vendors = new Set([
  "vendor/live2dcubismcore.min.js",
  "vendor/pixi.min.js",
  "vendor/cubism4.min.js",
]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overlay = join(root, "overlay");
const output = join(overlay, "assets");
const cache = join(overlay, ".live2d-cache", REVISION);

export function safeAssetPath(path) {
  if (typeof path !== "string" || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some(p => !p || p === "." || p === "..")) return false;
  return vendors.has(path) ||
    (path.startsWith("model/") && /\.(?:json|moc3|png)$/.test(path));
}
export function blobSha(buffer) {
  return createHash("sha1").update(Buffer.from("blob " + buffer.length + "\0")).update(buffer).digest("hex");
}
export function selectAssets(tree) {
  if (!Array.isArray(tree)) throw Error("Invalid Git tree response");
  const list = tree.filter(e => e.type === "blob" && typeof e.path === "string" &&
    e.path.startsWith(sourceRoot) && safeAssetPath(e.path.slice(sourceRoot.length)))
    .map(e => ({ path: e.path.slice(sourceRoot.length), sha: e.sha, size: e.size }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!list.some(x => x.path === "model/c_0120.model3.json") ||
      !list.some(x => x.path === "model/c_0120.moc3") ||
      !list.some(x => x.path === "model/manifest.json") ||
      [...vendors].some(name => !list.some(x => x.path === name))) {
    throw Error("Missing required Live2D model or runtime files");
  }
  if (list.length > 120 || list.some(x => !Number.isInteger(x.size) || x.size > 12_000_000 || x.size < 1 ||
      !/^[0-9a-f]{40}$/.test(x.sha))) throw Error("Unexpected upstream file inventory");
  return list;
}
export function configFromEnv(env = process.env) {
  function bounded(key, fallback, min, max) {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw Error(key + " must be an integer from " + min + " to " + max);
    return value;
  }
  return {
    timeoutSeconds: bounded("BIGFISH_DOWNLOAD_TIMEOUT", 120, 20, 600),
    concurrency: bounded("BIGFISH_DOWNLOAD_CONCURRENCY", 2, 1, 4),
    attempts: bounded("BIGFISH_DOWNLOAD_RETRIES", 4, 1, 8),
  };
}
export async function verifiedAsset(file, entry) {
  try {
    if ((await stat(file)).size !== entry.size) return false;
    const bytes = await readFile(file);
    return blobSha(bytes) === entry.sha;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
export function assetUrl(asset) {
  if (!safeAssetPath(asset.path)) throw Error("Unsafe upstream asset path");
  return "https://raw.githubusercontent.com/" + UPSTREAM + "/" + REVISION + "/assets/" +
    asset.path.split("/").map(encodeURIComponent).join("/");
}
// curl respects HTTPS_PROXY / ALL_PROXY on macOS, unlike some Node 22 fetch
// configurations. No shell is used; bytes are verified before becoming assets.
async function curlFile(url, target, timeoutSeconds) {
  await new Promise((resolve, reject) => {
    const args = ["--fail", "--location", "--silent", "--show-error",
      "--connect-timeout", "20", "--max-time", String(timeoutSeconds),
      "--proto", "=https", "--proto-redir", "=https",
      "--output", target, "--url", url];
    const p = spawn("curl", args, {stdio: ["ignore", "ignore", "pipe"]});
    let errors = "";
    p.stderr.on("data", chunk => { errors = (errors + chunk.toString("utf8")).slice(-2000); });
    p.once("error", err => reject(err));
    p.once("close", code => code === 0 ? resolve() :
      reject(Error("curl exit " + code + (errors ? ": " + errors.trim() : ""))));
  });
}
// Node fallback for platforms without curl.
async function fetchFile(url, target, timeoutSeconds) {
  const response = await fetch(url, {
    headers: {"user-agent": "BigFish-Live2D-installer"},
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
  });
  if (!response.ok) throw Error("HTTP " + response.status + " for " + url);
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
}
async function transferFile(url, target, timeoutSeconds) {
  try { await curlFile(url, target, timeoutSeconds); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fetchFile(url, target, timeoutSeconds);
  }
}
async function pause(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}
export async function downloadVerifiedAsset(entry, cacheRoot, options = {}) {
  if (!safeAssetPath(entry.path) || !/^[0-9a-f]{40}$/.test(entry.sha) ||
      !Number.isInteger(entry.size) || entry.size < 1 || entry.size > 12_000_000) {
    throw Error("Invalid asset manifest entry");
  }
  const dest = join(cacheRoot, entry.path);
  if (await verifiedAsset(dest, entry)) return "cached";
  await mkdir(dirname(dest), {recursive: true});
  const attempts = options.attempts ?? 4;
  const timeoutSeconds = options.timeoutSeconds ?? 120;
  const downloader = options.downloader ?? transferFile;
  const delayMs = options.delayMs ?? 1300;
  const url = assetUrl(entry);
  let failure;
  for (let i = 1; i <= attempts; i++) {
    const partial = dest + ".partial-" + randomUUID();
    try {
      await downloader(url, partial, timeoutSeconds);
      if (!(await verifiedAsset(partial, entry)))
        throw Error("Downloaded file did not match upstream Git SHA or file size");
      await rename(partial, dest);
      return "downloaded";
    } catch (error) {
      failure = error;
      if (i < attempts) {
        console.warn("[live2d] " + entry.path + " attempt " + i + "/" + attempts +
          " failed: " + (error?.message ?? error) + "; retrying");
        await pause(delayMs * i);
      }
    } finally {
      await rm(partial, {force: true});
    }
  }
  throw Error("Failed " + entry.path + " after " + attempts + " attempts: " +
    (failure?.message ?? failure) +
    ". Verified earlier files are cached; rerun the same install command.");
}
export async function prepareAssets(assets, {cacheRoot, outputRoot, stageRoot, downloader, attempts, timeoutSeconds, concurrency = 2, delayMs = 1300}) {
  let cursor = 0, completed = 0, cached = 0;
  // All checked assets are preserved outside the staging dir. Each worker has
  // its own file path, so a partial download cannot corrupt another file.
  const workers = Array.from({length: Math.min(concurrency, assets.length)}, async () => {
    while (cursor < assets.length) {
      const entry = assets[cursor++];
      const cachedFile = join(cacheRoot, entry.path);
      const existingFile = join(outputRoot, entry.path);
      if (!(await verifiedAsset(cachedFile, entry)) && await verifiedAsset(existingFile, entry)) {
        await mkdir(dirname(cachedFile), {recursive: true});
        await copyFile(existingFile, cachedFile);
      }
      const result = await downloadVerifiedAsset(entry, cacheRoot,
        {downloader, attempts, timeoutSeconds, delayMs});
      if (result === "cached") cached++;
      const destination = join(stageRoot, entry.path);
      await mkdir(dirname(destination), {recursive: true});
      await copyFile(cachedFile, destination);
      completed++;
      console.log("[" + completed + "/" + assets.length + "] ✓ " + entry.path +
        (result === "cached" ? " (cached)" : ""));
    }
  });
  // Wait for every in-flight write to finish before the caller can remove
  // the staging directory after a failed worker.
  const outcomes = await Promise.allSettled(workers);
  const failed = outcomes.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return {completed, cached};
}
async function getInventory(options) {
  await mkdir(cache, {recursive: true});
  const destination = join(cache, "pinned-tree.json");
  const url = "https://api.github.com/repos/" + UPSTREAM + "/git/trees/" + REVISION + "?recursive=1";
  async function parseInventory() {
    const json = JSON.parse(await readFile(destination, "utf8"));
    if (json.truncated) throw Error("Upstream tree listing is truncated");
    return selectAssets(json.tree);
  }
  // An earlier attempt may have populated the inventory even if a model
  // download later timed out. Reuse that pinned inventory on retries.
  try { return await parseInventory(); }
  catch { /* cache absent or corrupt */ }
  let failure;
  for (let i = 1; i <= options.attempts; i++) {
    const partial = destination + ".partial-" + randomUUID();
    try {
      await transferFile(url, partial, options.timeoutSeconds);
      const json = JSON.parse(await readFile(partial, "utf8"));
      if (json.truncated) throw Error("Upstream tree listing is truncated");
      const assets = selectAssets(json.tree);
      await rename(partial, destination);
      return assets;
    } catch (error) {
      failure = error;
      if (i < options.attempts) {
        console.warn("[live2d] tree listing attempt " + i + " failed: " + error.message);
        await pause(i * 1300);
      }
    } finally {
      await rm(partial, {force: true});
    }
  }
  throw Error("Could not fetch pinned inventory: " + failure.message);
}
async function install() {
  if (!process.argv.includes("--acknowledge-noncommercial")) {
    console.error("Artwork: CC BY-NC-SA 4.0 (noncommercial). Credits: 上善无形 / ZipZipPipe / 氵六青.\n" +
      "Using this model for monetized livestreams requires checking rights with relevant creators.\n" +
      "For noncommercial or separately authorized use run:\n" +
      "  npm run live2d:install -- --acknowledge-noncommercial");
    process.exitCode = 2;
    return;
  }
  const options = configFromEnv();
  console.log("[live2d] model revision " + REVISION +
    "; timeout " + options.timeoutSeconds + "s, " + options.attempts +
    " attempts, concurrency " + options.concurrency);
  console.log("[live2d] files successfully verified are saved between runs in overlay/.live2d-cache/");
  const assets = await getInventory(options);
  const staging = await mkdtemp(join(overlay, ".live2d-stage-"));
  const backup = output + ".previous";
  try {
    const result = await prepareAssets(assets, {
      cacheRoot: cache, outputRoot: output, stageRoot: staging, ...options,
    });
    await writeFile(join(staging, "SOURCE.json"), JSON.stringify({
      repo: UPSTREAM, revision: REVISION, license: "CC BY-NC-SA 4.0",
      creators: ["上善无形", "ZipZipPipe", "氵六青"],
      files: assets.length, installedAt: new Date().toISOString(),
    }, null, 2));
    await rm(backup, {recursive: true, force: true});
    let movedPrevious = false;
    try {
      await rename(output, backup);
      movedPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try { await rename(staging, output); }
    catch (error) {
      if (movedPrevious) await rename(backup, output);
      throw error;
    }
    await rm(backup, {recursive: true, force: true});
    console.log("[live2d] Installed " + result.completed + " assets (" + result.cached +
      " from cache). Launch npm run demo and open /overlay?preview=1");
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch(e => { console.error("[live2d:install]", e.message ?? e); process.exitCode = 1; });
}
