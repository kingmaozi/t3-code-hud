"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { wrap } = require("node:module");
const { Script } = require("node:vm");
const { assembleRenderer, readInstalledVersion } = require("./hud-release.cjs");

const REPOSITORY = "kingmaozi/t3-code-hud";
const RELEASES = `https://github.com/${REPOSITORY}/releases`;
const LATEST = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const ASSET_NAME = "t3-hub-update.json";
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const REDIRECT_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const HOT_SOURCES = Object.freeze({
  "hud-release.cjs": "src/hud-release.cjs",
  "hub-update.cjs": "src/hub-update.cjs",
  "backend.cjs": "src/backend.cjs",
  "renderer-base.js": "src/renderer-ui.js",
});
const OPTIONAL_HOT_SOURCES = Object.freeze({
  "hub-agy-quota.cjs": "src/hub-agy-quota.cjs",
  "hub-drawer-ui.js": "src/hub-drawer-ui.js",
  "hub-memory-access.cjs": "src/hub-memory-access.cjs",
  "hub-memory-connections.cjs": "src/hub-memory-connections.cjs",
  "hub-task-board.cjs": "src/hub-task-board.cjs",
  "hub-telemetry-guard.cjs": "src/hub-telemetry-guard.cjs",
  "hub-devin-quota.cjs": "src/hub-devin-quota.cjs",
  "hud-config.cjs": "src/hud-config.cjs",
});
const ALL_HOT_SOURCES = Object.freeze({
  ...HOT_SOURCES,
  ...OPTIONAL_HOT_SOURCES,
});
const STABLE_VERSION = /^(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})\.(0|[1-9]\d{0,6})$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const invalidPackage = () => new UpdateError("UPDATE_INVALID", "HUD update package failed validation.");
const unavailable = () => new UpdateError("HUD_UNAVAILABLE", "The running HUD is unavailable for a hot update.");

function isStable(version) {
  return typeof version === "string" && STABLE_VERSION.test(version);
}

function isNewer(version, current) {
  const available = version.split(".").map(Number);
  const installed = current.split(".").map(Number);
  const changed = available.findIndex((part, index) => part !== installed[index]);
  return changed >= 0 && available[changed] > installed[changed];
}

function validateBundle(bundle, expectedVersion) {
  if (!bundle || bundle.schema !== 1 || !isStable(expectedVersion) || bundle.version !== expectedVersion ||
      !bundle.files || typeof bundle.files !== "object" || Array.isArray(bundle.files)) throw invalidPackage();
  const names = Object.keys(bundle.files);
  if (!names.every(name => Object.hasOwn(ALL_HOT_SOURCES, name))) throw invalidPackage();
  for (const name of Object.keys(HOT_SOURCES)) {
    if (!Object.hasOwn(bundle.files, name)) throw invalidPackage();
  }
  for (const name of names) {
    const code = bundle.files[name];
    if (typeof code !== "string" || !code.trim()) throw invalidPackage();
    try { new Script(name.endsWith(".cjs") ? wrap(code) : code, { filename: name }); }
    catch { throw invalidPackage(); }
  }
  return bundle;
}

// Publish a four-file transition release for the baseline updater first.
// A subsequent, higher version can carry the optional modules.
function createBundle(sourceDir, { includeOptional = true } = {}) {
  const { version } = JSON.parse(fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"));
  const files = Object.fromEntries(Object.entries(HOT_SOURCES).map(([name, file]) =>
    [name, fs.readFileSync(path.join(sourceDir, file), "utf8")]));
  if (includeOptional) {
    for (const [name, file] of Object.entries(OPTIONAL_HOT_SOURCES)) {
      const full = path.join(sourceDir, file);
      if (fs.existsSync(full)) files[name] = fs.readFileSync(full, "utf8");
    }
  }
  return validateBundle({ schema: 1, version, files }, version);
}

async function download(fetchImpl, address, { maxBytes, accept, redirect = false, timeout }) {
  const signal = AbortSignal.timeout(timeout);
  let url = new URL(address);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetchImpl(url, {
      redirect: "manual", signal,
      headers: { Accept: accept, "User-Agent": "T3-Code-HUD-Updater" },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!redirect || !location) throw invalidPackage();
      url = new URL(location, url);
      if (url.protocol !== "https:" || url.port || url.username || url.password || !REDIRECT_HOSTS.has(url.hostname)) {
        throw invalidPackage();
      }
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new UpdateError("UPDATE_UNAVAILABLE", "HUD release download is unavailable.");
    }
    const reader = response.body.getReader();
    try {
      let size = 0;
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return Buffer.concat(parts, size);
        size += value.byteLength;
        if (size > maxBytes) throw invalidPackage();
        parts.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  throw invalidPackage();
}

function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalidPackage(); }
}

async function lookupRelease(fetchImpl, currentVersion) {
  const response = await download(fetchImpl, LATEST, {
    maxBytes: 1024 * 1024, accept: "application/vnd.github+json", timeout: 5000,
  });
  const release = parseJson(response);
  const version = typeof release?.tag_name === "string" && release.tag_name.startsWith("v")
    ? release.tag_name.slice(1) : null;
  if (!isStable(version) || release.draft !== false || release.prerelease !== false) {
    throw new UpdateError("UPDATE_UNAVAILABLE", "A stable HUD release is unavailable.");
  }
  if (!isNewer(version, currentVersion)) return { status: "current", currentVersion };
  const releaseUrl = `${RELEASES}/tag/v${version}`;
  const asset = Array.isArray(release.assets) && release.assets.find(item => item?.name === ASSET_NAME);
  const assetUrl = `${RELEASES}/download/v${version}/${ASSET_NAME}`;
  const compatible = asset?.state === "uploaded" && asset.browser_download_url === assetUrl &&
    typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(asset.digest) &&
    Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_ASSET_BYTES;
  return {
    status: compatible ? "available" : "unsupported", currentVersion, availableVersion: version, releaseUrl,
    ...(compatible ? { asset: { url: assetUrl, digest: asset.digest.slice(7), size: asset.size } } : {}),
  };
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function readRegularNoFollow(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) throw unavailable();
    return fs.readFileSync(fd, "utf8");
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readRuntime(pluginDir, expectedPid) {
  const runDir = path.join(pluginDir, "run");
  try {
    const runStat = fs.lstatSync(runDir);
    if (runStat.isSymbolicLink() || !runStat.isDirectory()) throw unavailable();
    const pidText = readRegularNoFollow(path.join(runDir, "active.pid")).trim();
    if (!/^\d{1,10}$/.test(pidText)) throw unavailable();
    const pid = Number(pidText);
    const main = JSON.parse(readRegularNoFollow(path.join(runDir, `rpc-${pid}.json`)));
    let bridge = null;
    for (const candidate of [path.join(runDir, `hub-bridge-${pid}.json`), path.join(runDir, "hub-bridge.json")]) {
      try {
        const parsed = JSON.parse(readRegularNoFollow(candidate));
        if (parsed && parsed.watchPid === pid) {
          bridge = parsed;
          break;
        }
      } catch {}
    }
    if (!bridge) throw unavailable();
    function validEndpoint(endpoint, token) {
      const url = new URL(endpoint.url);
      return /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url) && Number(url.port) > 0 &&
        typeof token === "string" && /^[a-f0-9]{64}$/.test(token);
    }
    if (pid < 1 || (expectedPid != null && pid !== expectedPid) || main.pid !== pid || bridge.watchPid !== pid ||
        !Number.isSafeInteger(bridge.pid) || bridge.pid < 1 || bridge.pid === pid ||
        !validEndpoint(main, main.adminToken) || !validEndpoint(bridge, bridge.token)) throw unavailable();
    process.kill(pid, 0);
    process.kill(bridge.pid, 0);
    return { main, bridge };
  } catch {
    throw unavailable();
  }
}

function runtimeController(fetchImpl, pluginDir, expectedPid) {
  const { main, bridge } = readRuntime(pluginDir, expectedPid);
  async function request(endpoint, route, { method = "POST", body } = {}) {
    const response = await fetchImpl(new URL(route, endpoint.url), {
      method, redirect: "error", signal: AbortSignal.timeout(7000),
      headers: { "X-T3-Hud-Token": endpoint.adminToken || endpoint.token, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw unavailable();
    const result = await response.json();
    if (!result.ok) throw unavailable();
    return result;
  }
  const status = () => request(main, "/admin/status", { method: "GET" });
  async function ready() {
    const current = readRuntime(pluginDir, main.pid);
    if (current.main.url !== main.url || current.bridge.pid !== bridge.pid ||
        current.bridge.url !== bridge.url) throw unavailable();
    const result = await status();
    if (result.pid !== main.pid || !result.mounted || result.lastInjectError ||
        !Array.isArray(result.windows) || result.windows.some(window => window.loading)) throw unavailable();
  }
  async function reload(expectedHash) {
    await request(bridge, "/reload");
    const result = await request(main, "/admin/reload-ui");
    if (!Array.isArray(result.results) || !result.results.length ||
        result.results.some(window => !window.injected) || result.lastInjectError) throw unavailable();
    if (expectedHash) {
      const [mainBackend, bridgeBackend] = await Promise.all([
        request(main, "/rpc", { body: { method: "hubCall", args: ["hub:update:runtime"] } }),
        request(bridge, "/hub-rpc", { body: { action: "hub:update:runtime" } }),
      ]);
      if (mainBackend.backendHash !== expectedHash || bridgeBackend.backendHash !== expectedHash) throw unavailable();
    }
    const after = await status();
    if (after.pid !== main.pid || !after.mounted || after.lastInjectError) throw unavailable();
  }
  return { bridge: { url: bridge.url, token: bridge.token }, ready, reload };
}

function readOriginal(filename) {
  const info = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile()) throw new UpdateError("UPDATE_FAILED", "An installed HUD file is not a regular file.");
  return { data: fs.readFileSync(filename), mode: info.mode & 0o777 };
}

function restoreOriginal(pluginDir, directory, name, original) {
  const destination = path.join(pluginDir, name);
  if (!original) return fs.rmSync(destination, { force: true });
  const temporary = path.join(directory, "restore-" + name);
  fs.writeFileSync(temporary, original.data, { mode: original.mode, flag: "wx" });
  fs.renameSync(temporary, destination);
}

const REQUIRED_TARGETS = [...Object.keys(HOT_SOURCES), "renderer-ui.js", "hud-release.json"];
const ALL_TARGETS = new Set([...Object.keys(ALL_HOT_SOURCES), "renderer-ui.js", "hud-release.json"]);
const recoveryError = () => new UpdateError("UPDATE_ROLLBACK_FAILED", "HUD recovery needs attention. A local backup was kept.");

function loadJournal(pending) {
  try {
    const file = readOriginal(pending);
    if (!file) return null;
    const journal = JSON.parse(file.data);
    const fileKeys = journal.files && typeof journal.files === "object" && !Array.isArray(journal.files)
      ? Object.keys(journal.files)
      : null;
    if (!/^hud-update-[A-Za-z0-9]{6}$/.test(journal.backup) || !isStable(journal.version) ||
        !fileKeys ||
        !REQUIRED_TARGETS.every(name => Object.hasOwn(journal.files, name)) ||
        !fileKeys.every(name => ALL_TARGETS.has(name) &&
          (journal.files[name] === null || (/^[a-f0-9]{64}$/.test(journal.files[name]?.hash) &&
           Number.isInteger(journal.files[name]?.mode) && journal.files[name].mode >= 0 && journal.files[name].mode <= 0o777)))) {
      throw recoveryError();
    }
    return journal;
  } catch {
    throw recoveryError();
  }
}

async function recoverUpdate(pluginDir, pending, journal, runtime) {
  const backup = path.join(pluginDir, "backups", journal.backup);
  const originals = new Map();
  const journalTargets = Object.keys(journal.files);
  try {
    if (!fs.lstatSync(backup).isDirectory()) throw recoveryError();
    for (const name of journalTargets) {
      const entry = journal.files[name];
      const original = entry ? readOriginal(path.join(backup, name)) : null;
      if (entry && (!original || sha256(original.data) !== entry.hash)) throw recoveryError();
      originals.set(name, entry ? { data: original.data, mode: entry.mode } : null);
    }
    const stage = fs.mkdtempSync(path.join(pluginDir, ".hud-restore-"));
    try {
      for (const name of journalTargets) restoreOriginal(pluginDir, stage, name, originals.get(name));
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    // Versions with the updater support checking the previous running backend's identity.
    await runtime.reload(journal.files["hub-update.cjs"] && journal.files["backend.cjs"]?.hash);
    fs.unlinkSync(pending);
  } catch {
    throw recoveryError();
  }
}

async function activateBundle(bundle, pluginDir, runtime, pending, currentVersion, { beforeWrite } = {}) {
  await runtime.ready();
  let drawerCode;
  if (Object.hasOwn(bundle.files, "hub-drawer-ui.js")) {
    drawerCode = bundle.files["hub-drawer-ui.js"];
  } else {
    const drawer = readOriginal(path.join(pluginDir, "hub-drawer-ui.js"));
    if (!drawer) throw unavailable();
    drawerCode = drawer.data.toString("utf8");
  }
  const renderer = assembleRenderer(bundle.files["renderer-base.js"], drawerCode, {
    version: bundle.version, bridge: runtime.bridge,
  });
  try { new Script(renderer, { filename: "renderer-ui.js" }); }
  catch { throw invalidPackage(); }
  if (typeof beforeWrite === "function") beforeWrite();
  const files = {
    ...bundle.files,
    "renderer-ui.js": renderer,
    "hud-release.json": JSON.stringify({ version: bundle.version }) + "\n",
  };
  const originals = new Map(Object.keys(files).map(name => [name, readOriginal(path.join(pluginDir, name))]));
  const backupsRoot = path.join(pluginDir, "backups");
  fs.mkdirSync(backupsRoot, { mode: 0o700, recursive: true });
  if (!fs.lstatSync(backupsRoot).isDirectory()) throw new UpdateError("UPDATE_FAILED", "HUD backup directory is unavailable.");
  const backup = fs.mkdtempSync(path.join(backupsRoot, "hud-update-"));
  fs.chmodSync(backup, 0o700);
  const stage = fs.mkdtempSync(path.join(pluginDir, ".hud-stage-"));
  let journal;
  try {
    for (const [name, data] of Object.entries(files)) {
      const original = originals.get(name);
      if (original) fs.writeFileSync(path.join(backup, name), original.data, { mode: 0o600, flag: "wx" });
      fs.writeFileSync(path.join(stage, name), data, { mode: 0o600, flag: "wx" });
    }
    const transaction = {
      backup: path.basename(backup),
      version: currentVersion,
      files: Object.fromEntries([...originals].map(([name, entry]) => [
        name, entry ? { hash: sha256(entry.data), mode: entry.mode } : null,
      ])),
    };
    const stagedJournal = path.join(stage, "journal.json");
    fs.writeFileSync(stagedJournal, JSON.stringify(transaction), { mode: 0o600, flag: "wx" });
    fs.renameSync(stagedJournal, pending);
    journal = transaction;
    for (const name of Object.keys(files)) {
      fs.renameSync(path.join(stage, name), path.join(pluginDir, name));
    }
    await runtime.reload(sha256(bundle.files["backend.cjs"]));
    fs.unlinkSync(pending);
    return { ok: true, status: "updated", currentVersion: bundle.version };
  } catch {
    if (journal) await recoverUpdate(pluginDir, pending, journal, runtime);
    throw new UpdateError("UPDATE_FAILED", "The running HUD did not accept the update. Its previous files were kept.");
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function lockOwner(lock) {
  const info = fs.lstatSync(lock, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isDirectory()) throw recoveryError();
  const names = fs.readdirSync(lock);
  if (!names.length) return { name: null, alive: false };
  const match = names.length === 1 && names[0].match(/^owner-(\d{1,10})-[a-f0-9-]{36}$/);
  if (!match || Number(match[1]) < 1) throw recoveryError();
  try { process.kill(Number(match[1]), 0); }
  catch (error) {
    if (error.code === "ESRCH") return { name: names[0], alive: false };
    if (error.code !== "EPERM") throw error;
  }
  return { name: names[0], alive: true };
}

const busy = () => new UpdateError("UPDATE_BUSY", "Another HUD update is in progress.");

function takeLock(lock) {
  const run = path.dirname(lock);
  const candidate = fs.mkdtempSync(path.join(run, ".hud-lock-"));
  const name = `owner-${process.pid}-${randomUUID()}`;
  const release = () => {
    fs.rmSync(path.join(lock, name), { force: true });
    try { fs.rmdirSync(lock); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
  };
  try {
    fs.writeFileSync(path.join(candidate, name), "", { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(candidate, lock);
        return release;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      }
      const owner = lockOwner(lock);
      if (owner?.alive) throw busy();
      // Only the exact stale marker can be removed. A new owner has a
      // different filename and makes rmdir fail while its lock is occupied.
      if (owner?.name) fs.rmSync(path.join(lock, owner.name), { force: true });
      try { fs.rmdirSync(lock); }
      catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error; }
    }
    throw busy();
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

const DEFAULT_BACKGROUND_CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_AUTO_ATTEMPT_VERSIONS = 32;

function readAutoHotUpdateEnabled(configPath) {
  let fd = null;
  try {
    fd = fs.openSync(configPath, fs.constants.O_RDONLY | O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
    if (!fs.fstatSync(fd).isFile()) return false;
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    if (!Object.hasOwn(parsed, "autoHotUpdate") || parsed.autoHotUpdate === undefined) return true;
    return typeof parsed.autoHotUpdate === "boolean" ? parsed.autoHotUpdate : false;
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function readAutoAttempt(attemptFile) {
  const st = fs.lstatSync(attemptFile, { throwIfNoEntry: false });
  if (!st) return Object.create(null);
  if (st.isSymbolicLink() || !st.isFile()) throw unavailable();
  try {
    const parsed = JSON.parse(readRegularNoFollow(attemptFile));
    const versions = Object.create(null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return versions;
    if (parsed.versions && typeof parsed.versions === "object" && !Array.isArray(parsed.versions)) {
      for (const [ver, ts] of Object.entries(parsed.versions)) {
        if (isStable(ver)) {
          const num = Number(ts);
          versions[ver] = Number.isFinite(num) && num >= 0 ? num : 0;
        }
      }
    }
    if (isStable(parsed.version) && !Object.hasOwn(versions, parsed.version)) {
      const num = Number(parsed.attemptedAt);
      versions[parsed.version] = Number.isFinite(num) && num >= 0 ? num : 0;
    }
    return versions;
  } catch (err) {
    if (err instanceof UpdateError) throw err;
    return Object.create(null);
  }
}

function writeAutoAttempt(attemptFile, expectedVersion, attemptedAt) {
  const runDir = path.dirname(attemptFile);
  const runStat = fs.lstatSync(runDir, { throwIfNoEntry: false });
  if (!runStat || runStat.isSymbolicLink() || !runStat.isDirectory()) throw unavailable();
  const existing = fs.lstatSync(attemptFile, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw unavailable();
  const ts = Number.isFinite(Number(attemptedAt)) && Number(attemptedAt) >= 0 ? Number(attemptedAt) : Date.now();
  const prev = readAutoAttempt(attemptFile);
  prev[expectedVersion] = ts;
  const entries = Object.entries(prev);
  if (entries.length > MAX_AUTO_ATTEMPT_VERSIONS) {
    entries.sort((a, b) => {
      if (a[0] === expectedVersion) return -1;
      if (b[0] === expectedVersion) return 1;
      return b[1] - a[1];
    });
    entries.length = MAX_AUTO_ATTEMPT_VERSIONS;
  }
  const versions = {};
  for (const [ver, time] of entries) versions[ver] = time;
  const tmp = path.join(runDir, `.hud-auto-attempt-${process.pid}-${randomUUID()}.tmp`);
  let fd = null;
  let created = false;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify({ version: expectedVersion, attemptedAt: ts, versions }) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, attemptFile);
    created = false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (created) {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

function clearAutoAttempt(attemptFile) {
  try {
    const st = fs.lstatSync(attemptFile, { throwIfNoEntry: false });
    if (st && !st.isSymbolicLink() && st.isFile()) fs.unlinkSync(attemptFile);
  } catch {}
}

function createHudUpdater({ pluginDir = __dirname, fetchImpl = globalThis.fetch,
  installLock = path.join(path.dirname(pluginDir), "hud-install.lock"),
  configPath = path.join(pluginDir, "config.json"),
  getRuntime = (pid) => runtimeController(fetchImpl, pluginDir, pid),
  backgroundCacheMs = DEFAULT_BACKGROUND_CACHE_MS,
  now = () => Date.now() } = {}) {
  const lock = path.join(pluginDir, "run", "hud-update.lock");
  const pending = path.join(pluginDir, "run", "hud-update-pending.json");
  const autoAttemptFile = path.join(pluginDir, "run", "hud-auto-update-attempted.json");
  let cachedCheck = null;
  let inFlightCheck = null;
  let cacheGen = 0;
  const invalidateCheckCache = () => {
    cacheGen += 1;
    cachedCheck = null;
    inFlightCheck = null;
  };
  const version = () => {
    const value = readInstalledVersion(pluginDir);
    if (!isStable(value)) throw unavailable();
    return value;
  };
  const presentError = (error) => error instanceof UpdateError
    ? { ok: false, code: error.code, error: error.message }
    : { ok: false, code: "UPDATE_UNAVAILABLE", error: "HUD update is unavailable. Try checking again." };
  const locked = async (action) => {
    if (!fs.lstatSync(path.dirname(lock), { throwIfNoEntry: false })?.isDirectory()) return presentError(unavailable());
    let release;
    try { release = takeLock(lock); }
    catch (error) { return presentError(error); }
    try {
      if (fs.lstatSync(installLock, { throwIfNoEntry: false })) throw busy();
      return await action();
    }
    catch (error) { return presentError(error); }
    finally { release(); }
  };
  return {
    async check({ background = false } = {}) {
      try {
        if (fs.lstatSync(installLock, { throwIfNoEntry: false }) || lockOwner(lock)?.alive) throw busy();
        const interrupted = loadJournal(pending);
        if (interrupted) {
          invalidateCheckCache();
          return { ok: true, status: "recoverable", currentVersion: interrupted.version, availableVersion: interrupted.version };
        }
        const currentVersion = version();
        const cacheWindow = Number.isFinite(backgroundCacheMs) && backgroundCacheMs > 0 ? backgroundCacheMs : 0;
        const nowMs = now();
        if (background === true && cachedCheck &&
            cachedCheck.gen === cacheGen &&
            cachedCheck.currentVersion === currentVersion &&
            cacheWindow > 0 &&
            nowMs >= cachedCheck.checkedAt &&
            (nowMs - cachedCheck.checkedAt) < cacheWindow) {
          return { ...cachedCheck.result, cached: true };
        }
        const gen = cacheGen;
        if (background === true && inFlightCheck &&
            inFlightCheck.gen === gen &&
            inFlightCheck.currentVersion === currentVersion) {
          const shared = await inFlightCheck.promise;
          return { ...shared };
        }
        const run = { gen, currentVersion, promise: null };
        run.promise = (async () => {
          try {
            const { asset: _asset, ...release } = await lookupRelease(fetchImpl, currentVersion);
            const result = { ok: true, ...release };
            if (gen === cacheGen) {
              cachedCheck = { gen, checkedAt: now(), currentVersion, result };
            }
            return result;
          } finally {
            if (inFlightCheck === run) inFlightCheck = null;
          }
        })();
        if (background === true) inFlightCheck = run;
        const result = await run.promise;
        return { ...result };
      } catch (error) {
        return presentError(error);
      }
    },
    async apply(expectedVersion, { auto = false } = {}) {
      if (!isStable(expectedVersion)) return presentError(invalidPackage());
      return locked(async () => {
        invalidateCheckCache();
        try {
          if (auto === true) {
            const ensureAutoEnabled = () => {
              if (!readAutoHotUpdateEnabled(configPath)) {
                throw new UpdateError("AUTO_UPDATE_DISABLED", "Automatic hot updates are disabled.");
              }
            };
            ensureAutoEnabled();
            const attemptedVersions = readAutoAttempt(autoAttemptFile);
            if (Object.hasOwn(attemptedVersions, expectedVersion)) {
              throw new UpdateError("AUTO_UPDATE_ALREADY_ATTEMPTED", "Automatic hot update was already attempted for this version.");
            }
            const interrupted = loadJournal(pending);
            if (interrupted) {
              throw new UpdateError("UPDATE_BUSY", "An interrupted HUD update requires manual recovery.");
            }
            const current = version();
            if (current === expectedVersion) {
              clearAutoAttempt(autoAttemptFile);
              return { ok: true, status: "current", currentVersion: current };
            }
            if (!isNewer(expectedVersion, current)) throw new UpdateError("UPDATE_CHANGED", "The installed HUD version has changed.");
            const runtime = getRuntime(process.pid);
            const release = await lookupRelease(fetchImpl, current);
            if (release.status !== "available" || release.availableVersion !== expectedVersion) {
              throw new UpdateError("UPDATE_CHANGED", "The available HUD release changed. Check for updates again.");
            }
            ensureAutoEnabled();
            writeAutoAttempt(autoAttemptFile, expectedVersion, now());
            const bytes = await download(fetchImpl, release.asset.url, {
              maxBytes: release.asset.size, accept: "application/octet-stream", redirect: true, timeout: 25000,
            });
            if (bytes.length !== release.asset.size || sha256(bytes) !== release.asset.digest) throw invalidPackage();
            const bundle = validateBundle(parseJson(bytes), expectedVersion);
            const result = await activateBundle(bundle, pluginDir, runtime, pending, current, { beforeWrite: ensureAutoEnabled });
            clearAutoAttempt(autoAttemptFile);
            return result;
          }
          const runtime = getRuntime(process.pid);
          const interrupted = loadJournal(pending);
          if (interrupted) await recoverUpdate(pluginDir, pending, interrupted, runtime);
          const current = version();
          if (current === expectedVersion) {
            clearAutoAttempt(autoAttemptFile);
            return { ok: true, status: "current", currentVersion: current };
          }
          if (!isNewer(expectedVersion, current)) throw new UpdateError("UPDATE_CHANGED", "The installed HUD version has changed.");
          const release = await lookupRelease(fetchImpl, current);
          if (release.status !== "available" || release.availableVersion !== expectedVersion) {
            throw new UpdateError("UPDATE_CHANGED", "The available HUD release changed. Check for updates again.");
          }
          const bytes = await download(fetchImpl, release.asset.url, {
            maxBytes: release.asset.size, accept: "application/octet-stream", redirect: true, timeout: 25000,
          });
          if (bytes.length !== release.asset.size || sha256(bytes) !== release.asset.digest) throw invalidPackage();
          const bundle = validateBundle(parseJson(bytes), expectedVersion);
          const result = await activateBundle(bundle, pluginDir, runtime, pending, current);
          clearAutoAttempt(autoAttemptFile);
          return result;
        } finally {
          invalidateCheckCache();
        }
      });
    },
    // For the local, already-reviewed bootstrap and offline fixture verification.
    async activateLocal(bundle, expectedVersion) {
      return locked(async () => {
        invalidateCheckCache();
        try {
          const runtime = getRuntime(null);
          const interrupted = loadJournal(pending);
          if (interrupted) await recoverUpdate(pluginDir, pending, interrupted, runtime);
          const current = version();
          if (!isStable(expectedVersion) || !isNewer(expectedVersion, current)) throw invalidPackage();
          const result = await activateBundle(validateBundle(bundle, expectedVersion), pluginDir, runtime, pending, current);
          clearAutoAttempt(autoAttemptFile);
          return result;
        } finally {
          invalidateCheckCache();
        }
      });
    },
  };
}

module.exports = { ASSET_NAME, createBundle, createHudUpdater, sha256 };
