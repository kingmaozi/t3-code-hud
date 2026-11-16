"use strict";
// Isolated lifecycle regressions: no real service, launchctl, HOME or MLX access.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawnSync } = require("node:child_process");
const { randomInt } = require("node:crypto");
const ROOT = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "src/embed-manager.cjs"), "utf8");
const installer = () => fs.readFileSync(path.join(ROOT, "install.sh"), "utf8");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "t3-embed-lifecycle-"));
const MODEL = "test/embedding";
const TRANSACTION_PLIST = '<plist version="1.0"><dict><key>Label</key><string>embed</string><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>old/model</string><key>CUSTOM</key><string>preserve</string></dict></dict></plist>';

function harness(t, options = {}) {
  const home = tmp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let now = 100000, nextId = 0;
  const timers = new Map(), children = [], launchCalls = [], switchRequests = [], bootoutSnapshots = [], bootstrapSnapshots = [], launchConfigs = [];
  const state = { health: null, spawnError: null, syncThrow: null };
  function timer(fn, ms, repeat) {
    const id = { id: ++nextId, unref() { return this; } };
    timers.set(id, { fn, ms, repeat, at: now + ms });
    return id;
  }
  function advance(ms) {
    const end = now + ms;
    let steps = 0;
    while (true) {
      const due = [...timers].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      assert.ok(++steps < 1000, "timer storm");
      const [id, v] = due;
      now = v.at;
      if (v.repeat) v.at += v.ms;
      else timers.delete(id);
      v.fn();
    }
    now = end;
  }
  const cp = {
    spawn(cmd, args, options) {
      if (state.syncThrow) throw state.syncThrow;
      const child = new EventEmitter();
      Object.assign(child, { pid: 900000 + children.length, args, options, exitCode: null, signalCode: null,
        stdout: new PassThrough(), stderr: new PassThrough(), signals: [],
        unref() {}, kill(signal) { this.signals.push(signal); this.killed = true; return true; },
        finish(code = 0, signal = null) { this.exitCode = code; this.signalCode = signal; this.emit("exit", code, signal); this.emit("close", code, signal); },
      });
      children.push(child);
      return child;
    },
    spawnSync(cmd, args) {
      if (cmd === "/usr/bin/plutil") {
        if (state.plutilThrow) throw state.plutilThrow;
        return state.plutilResult ?? { status: 0 };
      }
      if (cmd === "curl") {
        if (args.includes("-d")) {
          const payload = JSON.parse(args[args.indexOf("-d") + 1]);
          switchRequests.push(payload);
          if (state.onSwitch) return state.onSwitch(payload);
        }
        return state.health ? { status: 0, stdout: JSON.stringify(state.health) } : { status: 7 };
      }
      if (cmd === "lsof") return { status: state.listener ? 0 : 1, stdout: state.listener ? "999999" : "" };
      return { status: 1, stdout: "" };
    },
    execFileSync() { return ""; },
  };
  // Resolve fixture-relative paths without changing the test process's cwd.
  const localFs = { ...fs };
  localFs.renameSync = (...args) => {
    if (state.failPlistCommit && args[1] === path.join(home, "embed.plist")) throw new Error("rename failed");
    return fs.renameSync(...args);
  };
  if (options.localPaths) for (const method of ["statSync", "lstatSync", "realpathSync", "readFileSync", "existsSync"]) {
    localFs[method] = (file, ...args) => fs[method](typeof file === "string" && !path.isAbsolute(file) ? path.join(home, file) : file, ...args);
  }
  const localPath = options.localPaths ? { ...path, resolve: (...parts) => path.resolve(home, ...parts) } : path;
  const sandbox = { require: (id) => id === "node:child_process" ? cp : id === "node:fs" ? localFs : id === "node:path" ? localPath : require(id),
    module: { exports: {} }, __dirname: path.join(ROOT, "src"), Buffer,
    process: { ...process, platform: options.platform || process.platform, env: { ...process.env, HOME: home, T3_HUB_DIR: path.join(home, "hub") },
      kill() { throw new Error("real process kill forbidden"); } },
    Date: class extends Date { static now() { return now; } },
    setInterval: (f, ms) => timer(f, ms, true), clearInterval: (id) => timers.delete(id),
    setTimeout: (f, ms) => timer(f, ms, false), clearTimeout: (id) => timers.delete(id),
  };
  vm.runInNewContext(source, sandbox, { filename: "embed-manager.cjs" });
  const api = sandbox.module.exports;
  const cacheDir = path.join(home, "cache");
  const mgr = api.createEmbedManager({ homeDir: home, hubDir: path.join(home, "hub"), cacheDir,
    port: randomInt(20000, 60000), launchAgentPlistPath: options.launchAgent ? path.join(home, "embed.plist") : null, pythonPath: path.join(home, "missing-python"),
    _launchctl: (args) => {
      launchCalls.push(args);
      const config = path.join(home, "hub", "embed-config.json");
      launchConfigs.push({ op: args[0], config: fs.existsSync(config) ? fs.readFileSync(config, "utf8") : null });
      try {
        if (options.launchAgent && args[0] === "bootout") bootoutSnapshots.push(fs.readFileSync(path.join(home, "embed.plist"), "utf8"));
        if (options.launchAgent && args[0] === "bootstrap") bootstrapSnapshots.push(fs.readFileSync(path.join(home, "embed.plist"), "utf8"));
      } catch {}
      if (args[0] === "bootout" && state.bootoutThrow) throw state.bootoutThrow;
      if (args[0] === "bootout" && Object.hasOwn(state, "bootoutResult")) return state.bootoutResult;
      return { status: state.launchStatuses?.[args[0]] ?? state.launchStatus ?? 1 };
    },
    totalRamGb: 16, chipModel: "test" });
  t.after(() => { if (mgr.close) mgr.close(); });
  function cache(id = MODEL, rev = "rev1") {
    const dir = path.join(cacheDir, "models--" + id.replaceAll("/", "--"));
    const snap = path.join(dir, "snapshots", rev);
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "config.json"), "{}");
    fs.writeFileSync(path.join(snap, "model.safetensors"), "weights");
    return { dir, snap };
  }
  return { mgr, api, home, cacheDir, cache, children, state, timers, advance, launchCalls, switchRequests, bootoutSnapshots, bootstrapSnapshots, launchConfigs,
    services: () => children.filter((c) => c.args[0] !== "-c") };
}

test("cache rejects config-only, blobs-only, dangling/incomplete weights, and empty config", (t) => {
  const h = harness(t), { dir, snap } = h.cache();
  assert.equal(h.mgr._isModelCached(MODEL), true);
  fs.unlinkSync(path.join(snap, "model.safetensors"));
  fs.mkdirSync(path.join(dir, "blobs"));
  fs.writeFileSync(path.join(dir, "blobs", "config-blob"), "{}");
  fs.writeFileSync(path.join(dir, "blobs", "weights.incomplete"), "partial");
  assert.equal(h.mgr._isModelCached(MODEL), false);
  fs.symlinkSync("../../blobs/weights.incomplete", path.join(snap, "model.safetensors"));
  assert.equal(h.mgr._isModelCached(MODEL), false);
  fs.unlinkSync(path.join(snap, "model.safetensors"));
  fs.symlinkSync("../../blobs/missing", path.join(snap, "model.safetensors"));
  assert.equal(h.mgr._isModelCached(MODEL), false);
  fs.writeFileSync(path.join(dir, "blobs", "missing"), "complete");
  assert.equal(h.mgr._isModelCached(MODEL), true);
  fs.writeFileSync(path.join(snap, "config.json"), "");
  assert.equal(h.mgr._isModelCached(MODEL), false);
});

test("cache validates every indexed shard and prefers refs/main over stale complete snapshots", (t) => {
  const h = harness(t), { dir, snap } = h.cache();
  const index = path.join(snap, "model.safetensors.index.json");
  fs.writeFileSync(index, JSON.stringify({ weight_map: { a: "model-1.safetensors", b: "model-2.safetensors" } }));
  fs.writeFileSync(path.join(snap, "model-1.safetensors"), "one");
  assert.equal(h.mgr._isModelCached(MODEL), false);
  fs.writeFileSync(path.join(snap, "model-2.safetensors"), "two");
  assert.equal(h.mgr._isModelCached(MODEL), true);
  fs.writeFileSync(index, "broken json");
  assert.equal(h.mgr._isModelCached(MODEL), false);
  fs.unlinkSync(index);
  fs.mkdirSync(path.join(dir, "snapshots", "new"));
  fs.mkdirSync(path.join(dir, "refs"));
  fs.writeFileSync(path.join(dir, "refs", "main"), "new\n");
  assert.equal(h.mgr._isModelCached(MODEL), false, "must not use stale revision while main downloads");
  fs.unlinkSync(path.join(dir, "refs", "main"));
  fs.renameSync(path.join(snap, "model.safetensors"), path.join(snap, "weights.npz"));
  assert.equal(h.mgr._isModelCached(MODEL), true);
});

test("download never starts service until child exits zero AND complete snapshot exists", (t) => {
  const h = harness(t);
  h.mgr.switchModel({ modelId: MODEL });
  h.cache();
  h.advance(3000);
  assert.equal(h.services().length, 0);
  h.children[0].finish(0);
  assert.equal(h.services().length, 1);
  h.advance(3000);
  assert.equal(h.services().length, 1, "exit/close/poll must not double-start");
});

for (const code of [1, null, 0]) test(`download failure (${code}) records error and stops polling`, (t) => {
  const h = harness(t);
  h.mgr.switchModel({ modelId: MODEL });
  if (code !== 0) h.cache();
  h.children[0].finish(code, code === null ? "SIGTERM" : null);
  const st = h.mgr.getStatus();
  assert.equal(st.downloadJob.status, "failed");
  assert.ok(st.lastError);
  assert.equal(st.downloadJob.active, false);
  assert.equal(h.timers.size, 0);
  h.advance(10000);
  assert.equal(h.services().length, 0);
});

for (const target of ["fts5-only", "test/other"]) test(`switch during download cancels child and stale callbacks (${target})`, (t) => {
  const h = harness(t);
  const sw = h.mgr.switchModel({ modelId: MODEL });
  const child = h.children[0];
  h.mgr.switchModel({ modelId: target });
  assert.equal(sw.downloadJob.cancelled, true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  h.cache();
  child.finish(0);
  h.advance(20000);
  assert.equal(h.services().length, 0);
  if (target === "fts5-only") assert.equal(h.mgr.getStatus().running, false);
});

test("cancel sends SIGKILL if SIGTERM did not exit, close clears all timers", (t) => {
  const h = harness(t);
  h.mgr.switchModel({ modelId: MODEL });
  h.mgr.switchModel({ mode: "fts5-only" });
  h.advance(3000);
  assert.deepEqual(h.children[0].signals, ["SIGTERM", "SIGKILL"]);
  h.mgr.close();
  assert.equal(h.timers.size, 0);
});

for (const kind of ["download", "service"]) test(`async spawn ENOENT handled for ${kind}`, (t) => {
  const h = harness(t);
  if (kind === "service") h.cache();
  h.mgr.switchModel({ modelId: MODEL });
  assert.doesNotThrow(() => h.children[0].emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })));
  h.children[0].emit("close", -2, null);
  h.advance(10000);
  assert.match(h.mgr.getStatus().lastError, /ENOENT/);
  if (kind === "download") assert.equal(h.mgr.getStatus().downloadJob.status, "failed");
  assert.equal(h.timers.size, 0);
  assert.equal(h.children.length, 1);
});

test("standalone RSS exit zero self-heals with exponential delay and three-attempt window limit", (t) => {
  const h = harness(t);
  h.cache();
  h.mgr.switchModel({ modelId: MODEL });
  h.services()[0].finish(0);
  h.advance(999);
  assert.equal(h.services().length, 1);
  h.advance(1);
  assert.equal(h.services().length, 2);
  h.services()[1].finish(0);
  h.advance(1999);
  assert.equal(h.services().length, 2);
  h.advance(1);
  assert.equal(h.services().length, 3);
  h.services()[2].finish(1);
  h.advance(4000);
  assert.equal(h.services().length, 4);
  h.services()[3].finish(0);
  h.advance(50000);
  assert.equal(h.services().length, 4);
  assert.match(h.mgr.getStatus().lastError, /restart|重启|自愈/i);
});

test("launchd recovery, intentional stop and model switch suppress pending self-heal/readiness callbacks", (t) => {
  const h = harness(t);
  h.cache();
  let reindexed = 0;
  h.mgr.switchModel({ modelId: MODEL, onReadyReindex: () => reindexed++ });
  h.services()[0].finish(0);
  h.state.health = { ok: true, modelId: MODEL };
  h.advance(1500);
  assert.equal(h.services().length, 1, "port recovered by external supervisor");
  h.state.health = null;
  h.mgr.switchModel({ modelId: MODEL, onReadyReindex: () => reindexed++ });
  const last = h.services().at(-1);
  last.finish(0);
  h.mgr.switchModel({ modelId: "fts5-only" });
  h.state.health = { ok: true, modelId: MODEL };
  const before = reindexed;
  h.advance(10000);
  assert.equal(reindexed, before, "stale readiness must not reindex");
  assert.equal(h.services().length, 2);
  h.mgr.close();
  assert.equal(h.timers.size, 0);
});

test("stopServer marks live service intentional and suppresses its late exit", (t) => {
  const h = harness(t);
  h.cache();
  h.mgr.switchModel({ modelId: MODEL });
  const child = h.services()[0];
  h.mgr.stopServer();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.finish(0);
  h.advance(30000);
  assert.equal(h.services().length, 1);
  assert.equal(h.timers.size, 0);
});

test("installer Python template is byte-for-byte identical to src/embed-server.py", () => {
  const sh = installer();
  const marker = "<<'T3_EMBED_SERVER_PY_EOF'\n";
  const body = sh.split(marker)[1].split("\nT3_EMBED_SERVER_PY_EOF")[0] + "\n";
  assert.deepEqual(Buffer.from(body), fs.readFileSync(path.join(ROOT, "src/embed-server.py")));
});

test("real Python switch control flow relaxes small ceiling before big warmup and restores on rollback", () => {
  // Execute the actual functions via AST with fake MLX/loaders, without importing
  // the server, touching real model caches or starting an HTTP listener.
  const py = String.raw`
import ast, asyncio, gc, sys, types, traceback
source = open(sys.argv[1]).read()
tree = ast.parse(source)
names = {'_snapshot_memory_limits', '_set_memory_limit_safe', '_restore_memory_limits',
         '_load_model_sync', '_load_model_unbounded_sync', 'switch_model'}
selected = []
for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
        node.decorator_list = []
        selected.append(node)
MB = 1024**2
calls = []
class Metal:
    def device_info(self): return {'max_recommended_working_set_size': 32 * 1024**3}
class MX:
    limit = 700 * MB
    active = 400 * MB
    metal = Metal()
    def set_memory_limit(self, limit):
        calls.append(('limit', limit))
        old, self.limit = self.limit, limit
        return old
    def clear_cache(self): calls.append(('clear', 0))
    def get_active_memory(self): return self.active
    def array(self, value): return value
    def eval(self, value):
        calls.append(('warmup', self.limit))
        if self.limit < self.active: raise MemoryError('warmup inherited small limit')
        if getattr(self, 'fail_warmup', False) and self.active > 400*MB: raise RuntimeError('simulated warmup failure')
mx = MX()
class Model:
    def __call__(self, **kw): return types.SimpleNamespace(text_embeds=types.SimpleNamespace(shape=(1, 2560)))
class Tokenizer:
    @staticmethod
    def from_pretrained(path): return lambda *a, **kw: {'input_ids': [1]}
fail = set()
def load(path):
    calls.append(('load:' + path, mx.limit))
    mx.active = (2159 if path != 'small' else 400) * MB
    if mx.limit < mx.active: raise MemoryError('old ceiling still active')
    if path in fail: raise RuntimeError('simulated bad weights')
    return Model()
sys.modules['mlx_vlm.embedding_loader'] = types.SimpleNamespace(load_embedding_model=load)
sys.modules['mlx_vlm.utils'] = types.SimpleNamespace(get_model_path=lambda x: x)
sys.modules['transformers'] = types.SimpleNamespace(AutoTokenizer=Tokenizer)
fields = ('BASE_ACTIVE_BYTES', 'BASE_ACTIVE_MB', 'CEILING_MB', 'CACHE_LIMIT_BYTES', 'CACHE_LIMIT_MB', 'RSS_FUSE_MB')
ns = dict(mx=mx, gc=gc, traceback=traceback, asyncio=asyncio, os=types.SimpleNamespace(environ={}),
          _MEMORY_LIMIT_FIELDS=fields, BASE_ACTIVE_BYTES=400*MB, BASE_ACTIVE_MB=400.,
          CEILING_MB=700., CACHE_LIMIT_BYTES=48*MB, CACHE_LIMIT_MB=48., RSS_FUSE_MB=1212.,
          state=dict(model=Model(), tokenizer=Tokenizer(), native_dim=512, model_id='small', served_name='small'),
          lock=asyncio.Lock(), _set_cache_limit_safe=lambda x: calls.append(('cache_limit', x)),
          _load_estha_config_for_model=lambda *a: None, _load_memory_override_mb=lambda: 0,
          _get_rss_mb=lambda: 1000)
exec(compile(ast.Module(body=selected, type_ignores=[]), '<actual-server-functions>', 'exec'), ns)
result = asyncio.run(ns['switch_model']({'modelId':'big'}))
assert result['ok'] and ns['state']['model_id'] == 'big'
assert calls.index(next(x for x in calls if x[0] == 'limit' and x[1] >= 64*1024**3)) < calls.index(next(x for x in calls if x[0] == 'load:big'))
assert any(x[0] == 'warmup' and x[1] >= 64*1024**3 for x in calls)
assert ns['BASE_ACTIVE_MB'] == 2159.
assert mx.limit == int(ns['CEILING_MB'] * MB) and ns['CEILING_MB'] > 2159
# Return to small, then fail the big load; original small limits must survive.
asyncio.run(ns['switch_model']({'modelId':'small'}))
before = ns['_snapshot_memory_limits']()
mx.fail_warmup = True
try: asyncio.run(ns['switch_model']({'modelId':'big'}))
except RuntimeError: pass
else: raise AssertionError('warmup unexpectedly succeeded')
assert ns['state']['model_id'] == 'small' and ns['state']['model'] is not None
assert ns['_snapshot_memory_limits']() == before
assert mx.limit == int(before['CEILING_MB'] * MB)
mx.fail_warmup = False
fail.add('broken')
try: asyncio.run(ns['switch_model']({'modelId':'broken'}))
except RuntimeError: pass
else: raise AssertionError('switch unexpectedly succeeded')
assert ns['state']['model_id'] == 'small' and ns['state']['model'] is not None
assert ns['_snapshot_memory_limits']() == before
assert mx.limit == int(before['CEILING_MB'] * MB)
assert ns['state']['cache_limit_mb'] == before['CACHE_LIMIT_MB']
# Even rollback failure restores the previous dynamic parameters.
fail.add('small')
try: asyncio.run(ns['switch_model']({'modelId':'broken'}))
except RuntimeError: pass
else: raise AssertionError('switch unexpectedly succeeded')
assert ns['_snapshot_memory_limits']() == before
assert ns['state']['model'] is None
print('small -> big relaxed before load+warmup; failed load+rollback restored limits')
`;
  const r = spawnSync("python3", ["-c", py, path.join(ROOT, "src/embed-server.py")], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

for (const [label, cfg, keepAlive, expected] of [
  ["existing disabled", {}, false, false],
  ["fts5-only mode", { mode: "fts5-only" }, true, false],
  ["fts5-only model", { modelId: "fts5-only" }, true, false],
  ["legacy zero-RAM", { mode: "fts5", modelId: "fts5-zero-ram" }, true, false],
  ["active vector", { mode: "mlx", modelId: MODEL }, true, true],
  ["explicit KeepAlive false wins on upgrade", { mode: "mlx", modelId: MODEL }, false, false],
  ["first install", {}, null, true],
]) test(`installer upgrade preserves ${label} and custom/legacy interpreter`, (t) => {
  const home = tmp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sh = installer();
  const start = sh.indexOf("# T3_EMBED_LAUNCHD_UPGRADE_START");
  const end = sh.indexOf("# T3_EMBED_LAUNCHD_UPGRADE_END");
  assert.ok(start > 0 && end > start);
  const snippet = sh.slice(start, end);
  assert.ok(!/\blaunchctl\s+(kickstart|bootstrap)/.test(snippet));
  const setup = String.raw`
import json, pathlib, plistlib, sys
home = pathlib.Path(sys.argv[1]); cfg = json.loads(sys.argv[2]); keep = json.loads(sys.argv[3])
python = home / ('powercontext-embed/.venv/bin/python' if keep is None else 'custom venv/bin/python')
python.parent.mkdir(parents=True); python.write_text('#!/bin/sh\nexit 0\n'); python.chmod(0o755)
config = home / '.t3/hub/embed-config.json'; config.parent.mkdir(parents=True); config.write_text(json.dumps(cfg))
if keep is not None:
    plist = home / 'Library/LaunchAgents/com.t3tools.powercontext-embed.plist'; plist.parent.mkdir(parents=True)
    plist.write_bytes(plistlib.dumps({'KeepAlive':keep,'RunAtLoad':True,'ProgramArguments':[str(python),'-u','custom-server.py'], 'EnvironmentVariables':{'CUSTOM':'preserve'}}))
`;
  let r = spawnSync("python3", ["-c", setup, home, JSON.stringify(cfg), JSON.stringify(keepAlive)], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const env = { ...process.env, HOME: home, DEST_DIR: path.join(home, "dest") };
  r = spawnSync("bash", ["-eu", "-c", snippet], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const plist = path.join(home, "Library/LaunchAgents/com.t3tools.powercontext-embed.plist");
  const bytes = fs.readFileSync(plist);
  r = spawnSync("bash", ["-eu", "-c", snippet], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(plist), bytes, "upgrade is byte-idempotent");
  r = spawnSync("python3", ["-c", "import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", plist], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.KeepAlive, expected);
  if (!expected) assert.equal(result.RunAtLoad, false);
  assert.equal(result.EnvironmentVariables.HF_HUB_DISABLE_XET, "1");
  const interpreter = keepAlive === null ? "powercontext-embed/.venv/bin/python" : "custom venv/bin/python";
  assert.equal(result.ProgramArguments[0], path.join(home, interpreter));
  if (keepAlive !== null) {
    assert.deepEqual(result.ProgramArguments.slice(1), ["-u", "custom-server.py"]);
    assert.equal(result.EnvironmentVariables.CUSTOM, "preserve");
  }
});

for (const kind of ["download", "service"]) test(`synchronous spawn EACCES handled for ${kind}`, (t) => {
  const h = harness(t);
  if (kind === "service") h.cache();
  h.state.syncThrow = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  const sw = h.mgr.switchModel({ modelId: MODEL });
  assert.match(h.mgr.getStatus().lastError, /EACCES/);
  if (kind === "download") assert.equal(sw.downloadJob.status, "failed");
  else assert.equal(sw.ok, false);
  assert.equal(h.timers.size, 0);
});

test("stale download error/close cannot overwrite next model's job or error state", (t) => {
  const h = harness(t);
  h.mgr.switchModel({ modelId: MODEL });
  const old = h.children[0];
  h.mgr.switchModel({ modelId: "test/next" });
  const nextJob = h.mgr.getStatus().downloadJob;
  old.emit("error", new Error("stale ENOENT"));
  old.finish(1);
  h.advance(1500);
  assert.equal(h.mgr.getStatus().downloadJob, nextJob);
  assert.equal(nextJob.status, "downloading");
  assert.equal(h.mgr.getStatus().lastError, null);
  assert.equal(h.services().length, 0);
});

test("successful hot switch transfers standalone supervision to new model/generation", (t) => {
  const h = harness(t);
  h.cache();
  h.cache("test/big");
  h.mgr.switchModel({ modelId: MODEL });
  const child = h.services()[0];
  h.state.health = { ok: true, modelId: "test/big" };
  const switched = h.mgr.switchModel({ modelId: "test/big" });
  assert.equal(switched.switched, true);
  h.state.health = null;
  child.finish(0);
  h.advance(1000);
  assert.equal(h.services().length, 2);
  assert.equal(h.services()[1].options.env.EMBED_MODEL, "test/big");
});

test("listener already restored by launchd suppresses duplicate spawn even before health is ready", (t) => {
  const h = harness(t);
  h.cache();
  h.mgr.switchModel({ modelId: MODEL });
  h.services()[0].finish(0);
  h.state.listener = true;
  h.advance(5000);
  assert.equal(h.services().length, 1);
  assert.equal(h.timers.size, 0);
});

test("close only disposes owned processes, is idempotent and rejects future switches", (t) => {
  const h = harness(t);
  h.cache();
  h.mgr.switchModel({ modelId: MODEL });
  const child = h.services()[0];
  h.mgr.close();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  child.finish(0);
  h.mgr.close();
  h.advance(60000);
  assert.equal(h.timers.size, 0);
  assert.equal(h.services().length, 1);
  assert.equal(h.mgr.switchModel({ modelId: MODEL }).ok, false);
});

test("launchd remains stopped during download and bootstraps only after verified completion", (t) => {
  const h = harness(t, { launchAgent: true });
  fs.writeFileSync(h.mgr.launchAgentPlistPath, '<plist><dict><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>old/model</string></dict></dict></plist>');
  h.state.launchStatus = 0;
  h.mgr.switchModel({ modelId: MODEL });
  h.cache();
  h.advance(3000);
  assert.deepEqual(h.launchCalls.map((a) => a[0]), ["bootout"]);
  assert.match(fs.readFileSync(h.mgr.launchAgentPlistPath, "utf8"), /<key>KeepAlive<\/key>\s*<false\/>/);
  h.children[0].finish(0);
  assert.deepEqual(h.launchCalls.map((a) => a[0]), ["bootout", "bootstrap"]);
  assert.match(fs.readFileSync(h.mgr.launchAgentPlistPath, "utf8"), /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.equal(h.services().length, 0, "launchd owns the process");
});

for (const bad of ["", " ", "bad id", "bad@@id", "org/repo with space", "invalid..id", "/nonexistent/absolute/model"]) {
  test(`illegal modelId '${bad}' has zero side effect on in-flight download`, (t) => {
    const h = harness(t);
    h.mgr.switchModel({ modelId: MODEL });
    const jobBefore = h.mgr.getStatus().downloadJob;
    assert.equal(jobBefore.status, "downloading");
    assert.equal(jobBefore.active, true);
    const child = h.children[0];
    const timerCountBefore = h.timers.size;
    let result;
    if (bad === "/nonexistent/absolute/model") result = h.mgr.switchModel({ modelId: bad });
    else if (bad === "") result = h.mgr.switchModel({ modelId: bad });
    else result = h.mgr.switchModel({ modelId: bad });
    assert.equal(result.ok, false, `illegal id should be rejected: ${JSON.stringify(bad)}`);
    assert.ok(result.error, "should carry error");
    // No side effect: download not cancelled, no kill, no new child, no config overwrite
    const after = h.mgr.getStatus();
    assert.equal(after.downloadJob, jobBefore, "downloadJob identity must be preserved");
    assert.equal(jobBefore.cancelled, false);
    assert.equal(jobBefore.active, true);
    assert.equal(jobBefore.status, "downloading");
    assert.deepEqual(child.signals, [], "must not terminate download child");
    assert.equal(h.children.length, 1, "must not spawn new child for illegal request");
    assert.equal(h.timers.size, timerCountBefore, "timers must not be cleared by illegal request");
    // Download still completes normally after illegal attempt
    h.cache();
    child.finish(0);
    assert.equal(h.services().length, 1, "in-flight download must still start service after illegal attempt");
    h.advance(2000);
    assert.equal(h.services().length, 1);
  });
}

test("illegal modelId preserves running service self-heal generation", (t) => {
  const h = harness(t);
  h.cache();
  h.mgr.switchModel({ modelId: MODEL });
  assert.equal(h.services().length, 1);
  const child = h.services()[0];
  // Illegal attempt while service is running
  const badResults = [
    h.mgr.switchModel({ modelId: "" }),
    h.mgr.switchModel({ modelId: "bad id" }),
    h.mgr.switchModel({ modelId: "org/repo with space" }),
  ];
  for (const r of badResults) {
    assert.equal(r.ok, false);
    assert.ok(r.error);
  }
  assert.equal(h.services().length, 1, "illegal request must not spawn or stop service");
  assert.deepEqual(child.signals, [], "illegal request must not kill running service");
  // Now the running service exits; self-heal must still trigger
  child.finish(0);
  h.advance(999);
  assert.equal(h.services().length, 1);
  h.advance(1);
  assert.equal(h.services().length, 2, "self-heal restart must still happen after illegal attempt (generation not clobbered)");
  assert.equal(h.services()[1].options.env.EMBED_MODEL, MODEL);
});

test("launchd-managed slow start does not double-spawn independent process", (t) => {
  const h = harness(t, { launchAgent: true });
  fs.writeFileSync(h.mgr.launchAgentPlistPath, '<plist><dict><key>KeepAlive</key><false/><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>old/model</string></dict></dict></plist>');
  h.state.launchStatus = 0;
  h.cache();
  h.state.health = null;
  let reindexed = 0;
  const res = h.mgr.switchModel({ modelId: MODEL, onReadyReindex: () => reindexed++ });
  assert.equal(res.ok, true);
  assert.equal(res.launchdManaged, true, "slow-start switch must be launchd-managed");
  // Must not have spawned any independent child
  assert.equal(h.children.length, 0, "must not spawn while launchd KeepAlive owns the port");
  assert.equal(h.services().length, 0);
  // Should have bootstrapped and attempted kickstart for slow start
  const ops = h.launchCalls.map((a) => a[0]);
  assert.ok(ops.includes("bootout"), "must bootout before managed switch");
  assert.ok(ops.includes("bootstrap"), "must bootstrap launchd for cached model");
  assert.ok(ops.includes("kickstart"), "slow start must kickstart (not spawn)");
  // Even after health becomes ready, still no spawn
  h.state.health = { ok: true, modelId: MODEL };
  h.advance(5000);
  assert.equal(h.children.length, 0, "no double spawn after health ready");
  assert.equal(reindexed, 1, "waitReady must fire once health matches");
  // Verify plist KeepAlive true and model persisted
  assert.match(fs.readFileSync(h.mgr.launchAgentPlistPath, "utf8"), /<key>KeepAlive<\/key>\s*<true\/>/);
  // Config persisted
  const cfg = JSON.parse(fs.readFileSync(h.mgr.configPath, "utf8"));
  assert.equal(cfg.modelId, MODEL);
});

test("launchd-managed hot switch success also avoids independent spawn", (t) => {
  const h = harness(t, { launchAgent: true });
  fs.writeFileSync(h.mgr.launchAgentPlistPath, '<plist><dict><key>KeepAlive</key><false/><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>test/embedding</string></dict><key>EMBED_NAME</key><string>embedding</string></dict></plist>');
  h.state.launchStatus = 0;
  h.cache();
  h.state.health = { ok: true, modelId: "test/other" };
  const res = h.mgr.switchModel({ modelId: MODEL });
  // Hot switch mocked as success via spawnSync curl returning health? In harness, spawnSync curl returns health json; hot switch expects {ok:true} - harness health is {ok:true, modelId} so hot switch will succeed
  assert.equal(res.ok, true);
  assert.equal(res.launchdManaged, true);
  // For hot-switch path, we used curl to /admin/switch-model which in harness returns health payload with ok:true, so switched should be true
  // No independent spawn expected
  if (res.switched) {
    assert.equal(h.children.length, 0, "hot switch managed path must not spawn");
  } else {
    // if harness health not matching switch endpoint, it would go to kickstart path; still no spawn
    assert.equal(h.children.length, 0);
    assert.ok(h.launchCalls.map((a) => a[0]).includes("kickstart"));
  }
});

for (const download of [false, true]) for (const recovery of ["kickstart", "failed", "timeout"]) {
  test(`launchd bootstrap already-loaded failure never spawns (${download ? "download completion" : "cached switch"}, ${recovery})`, (t) => {
    const h = harness(t, { launchAgent: true });
    fs.writeFileSync(h.mgr.launchAgentPlistPath, '<plist><dict><key>KeepAlive</key><false/><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>old/model</string></dict></dict></plist>');
    h.state.launchStatuses = { bootout: 0, bootstrap: 5, print: 0, kickstart: recovery === "failed" ? 1 : 0 };
    if (!download) h.cache();
    let reindexed = 0;
    const result = h.mgr.switchModel({ modelId: MODEL, onReadyReindex: () => reindexed++ });
    if (download) {
      assert.equal(result.downloading, true);
      h.cache();
      h.children[0].finish(0);
    }
    assert.equal(h.services().length, 0, "existing plist is authoritative despite bootstrap failure");
    assert.equal(h.children.length, download ? 1 : 0, "only the download child may spawn");
    const kick = h.launchCalls.find((a) => a[0] === "kickstart");
    assert.ok(kick, "must attempt launchd recovery");
    assert.equal(kick[1], "-k");
    assert.match(kick[2], /^gui\/\d+\/embed$/);
    if (recovery === "failed") {
      if (download) assert.equal(result.downloadJob.status, "failed");
      else { assert.equal(result.ok, false); assert.match(result.error, /launchd.*启动失败/); }
      assert.match(h.mgr.getStatus().lastError, /launchd.*启动失败/);
    } else {
      assert.equal(result.ok, true);
      if (!download) assert.equal(result.launchdManaged, true);
      if (recovery === "kickstart") {
        h.state.health = { ok: true, modelId: MODEL };
        h.advance(500);
        assert.equal(reindexed, 1, "waitReady must run after kickstart");
        assert.equal(h.mgr.getStatus().lastError, null);
      } else {
        h.state.health = { ok: true, modelId: "old/model" };
        h.advance(30000);
        assert.match(h.mgr.getStatus().lastError, /launchd.*启动失败/);
        if (download) assert.equal(result.downloadJob.status, "failed");
      }
    }
    h.advance(60000);
    assert.equal(h.services().length, 0, "no delayed independent restart");
    assert.equal(h.timers.size, 0);
  });
}

for (const complete of [true, false]) {
  test(`existing models/foo uses local integrity even when shaped like HF repo (${complete ? "complete" : "incomplete with complete HF cache"})`, (t) => {
    const h = harness(t, { localPaths: true });
    const local = path.join(h.home, "models", "foo");
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, "config.json"), "{}");
    if (complete) fs.writeFileSync(path.join(local, "model.safetensors"), "weights");
    else h.cache("models/foo");
    const validated = h.api.validateModelId("models/foo", h.home);
    assert.equal(validated.ok, true);
    assert.equal(validated.kind, "local");
    assert.equal(validated.value, local, "local model id must be absolute even if it resembles a repo id");
    assert.equal(h.mgr._isModelCached(validated.value), complete);
    assert.equal(h.api.isModelCached("models/foo", h.cacheDir, h.home), complete);
  });
}

for (const modelId of ["models/foo", "./models/foo", "~/models/foo"]) {
  for (const mode of ["launchd", "standalone hot", "standalone cold"]) {
    test(`local switch pins ${modelId} to an absolute path (${mode})`, (t) => {
      const h = harness(t, { localPaths: true, launchAgent: mode === "launchd" });
      const local = path.join(h.home, "models", "foo");
      fs.mkdirSync(local, { recursive: true });
      fs.writeFileSync(path.join(local, "config.json"), "{}");
      fs.writeFileSync(path.join(local, "model.safetensors"), "weights");
      if (mode === "launchd") {
        fs.writeFileSync(h.mgr.launchAgentPlistPath, '<plist><dict><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>old/model</string><key>EMBED_NAME</key><string>model</string></dict></dict></plist>');
        h.state.launchStatus = 0;
      }
      const serviceCwd = path.join(h.home, "other-working-directory");
      fs.mkdirSync(serviceCwd);
      let loadedPath = null, reindexed = 0;
      if (mode !== "standalone cold") h.state.onSwitch = (payload) => {
        // Emulate a service resolving the request from its own unrelated cwd.
        loadedPath = path.resolve(serviceCwd, payload.modelId);
        assert.equal(fs.readFileSync(path.join(loadedPath, "config.json"), "utf8"), "{}");
        assert.equal(fs.readFileSync(path.join(loadedPath, "model.safetensors"), "utf8"), "weights");
        h.state.health = { ok: true, modelId: loadedPath };
        return { status: 0, stdout: JSON.stringify({ ok: true }) };
      };
      const result = h.mgr.switchModel({ modelId, onReadyReindex: () => reindexed++ });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.activeModelId, local);
      const config = JSON.parse(fs.readFileSync(h.mgr.configPath, "utf8"));
      assert.equal(config.modelId, local);
      assert.equal(config.customModelId, local);
      assert.equal(h.switchRequests.length, 1);
      assert.equal(h.switchRequests[0].modelId, local);
      assert.equal(h.children.filter((c) => c.args[0] === "-c").length, 0, "local models never download");
      if (mode === "launchd") {
        assert.ok(fs.readFileSync(h.mgr.launchAgentPlistPath, "utf8").includes(`<key>EMBED_MODEL</key><string>${local}</string>`));
        assert.deepEqual(h.launchCalls.map((a) => a[0]), ["bootout", "bootstrap"]);
      }
      if (mode === "standalone cold") {
        assert.equal(h.services().length, 1);
        assert.equal(h.services()[0].options.env.EMBED_MODEL, local);
        loadedPath = path.resolve(serviceCwd, h.services()[0].options.env.EMBED_MODEL);
        assert.equal(fs.readFileSync(path.join(loadedPath, "model.safetensors"), "utf8"), "weights");
        h.state.health = { ok: true, modelId: loadedPath };
      } else assert.equal(h.children.length, 0, "hot switch/launchd must not independently spawn");
      assert.equal(loadedPath, local);
      h.advance(500);
      assert.equal(reindexed, 1, "health identity must match the absolute model id");
      assert.equal(h.mgr.getStatus().switching, false);
      assert.equal(h.mgr.switchModel({ modelId }).alreadyReady, true);
      assert.equal(h.switchRequests.length, 1, "the same relative id must hit the already-ready path");
    });
  }
}

for (const form of ["absolute", "./bad", "~/bad", "models/bad"]) {
  for (const missing of ["config", "weights"]) {
    for (const phase of ["running", "restart pending", "download"]) {
      test(`incomplete local ${form} (missing ${missing}) preserves ${phase} work`, (t) => {
        const h = harness(t, { localPaths: true });
        const local = path.join(h.home, form === "models/bad" ? "models/bad" : "bad");
        fs.mkdirSync(local, { recursive: true });
        fs.writeFileSync(path.join(local, missing === "config" ? "model.safetensors" : "config.json"), missing === "config" ? "weights" : "{}");
        // A valid HF cache must not mask an incomplete org/repo-shaped local path.
        if (form === "models/bad") h.cache(form);
        if (phase !== "download") h.cache();
        let reindexed = 0;
        const initial = h.mgr.switchModel({ modelId: MODEL, onReadyReindex: () => reindexed++ });
        assert.equal(initial.ok, true);
        const child = h.children[0];
        if (phase === "restart pending") child.finish(0);
        const configBefore = fs.readFileSync(h.mgr.configPath, "utf8");
        const timersBefore = [...h.timers.keys()];
        const requestsBefore = h.switchRequests.length;
        const statusBefore = h.mgr.getStatus();
        const result = h.mgr.switchModel({ modelId: form === "absolute" ? local : form });
        assert.equal(result.ok, false, "incomplete local directory must fail before invalidation");
        assert.match(result.error, /local.*incomplete/i);
        assert.ok(result.error.includes(local), "error must identify the absolute local path");
        assert.equal(fs.readFileSync(h.mgr.configPath, "utf8"), configBefore);
        assert.deepEqual([...h.timers.keys()], timersBefore, "ready/restart/download timers must survive");
        assert.equal(h.children.length, 1, "must not spawn a remote download or replacement service");
        assert.deepEqual(child.signals, [], "must not stop the current service/download");
        assert.equal(h.switchRequests.length, requestsBefore, "must not send a switch request");
        assert.equal(h.mgr.getStatus().lastError, statusBefore.lastError);
        if (phase === "download") {
          const job = initial.downloadJob;
          assert.equal(h.mgr.getStatus().downloadJob, job);
          assert.equal(job.active, true);
          assert.equal(job.cancelled, false);
          assert.equal(job.status, "downloading");
          h.cache();
          child.finish(0);
          assert.equal(job.status, "completed", "original download generation must remain valid");
        } else {
          if (phase === "running") child.finish(0);
          h.advance(999);
          assert.equal(h.children.length, 1);
          h.advance(1);
        }
        assert.equal(h.services().length, phase === "download" ? 1 : 2, "original service must start/restart after rejected switch");
        assert.equal(h.services().at(-1).options.env.EMBED_MODEL, MODEL);
        if (phase === "download") {
          h.state.health = { ok: true, modelId: MODEL };
          h.advance(500);
          assert.equal(reindexed, 1);
        }
      });
    }
  }
}

test("local model directories require full snapshot integrity", (t) => {
  const h = harness(t);
  const emptyDir = path.join(h.home, "empty-model");
  fs.mkdirSync(emptyDir, { recursive: true });
  assert.equal(h.mgr._isModelCached(emptyDir), false, "empty local dir must not be cached");
  assert.equal(h.api.isModelCached(emptyDir, h.cacheDir, h.home), false);

  const configOnly = path.join(h.home, "config-only-model");
  fs.mkdirSync(configOnly, { recursive: true });
  fs.writeFileSync(path.join(configOnly, "config.json"), JSON.stringify({ name: "x" }));
  assert.equal(h.mgr._isModelCached(configOnly), false, "config-only local dir must not be cached");

  const emptyConfig = path.join(h.home, "empty-config-model");
  fs.mkdirSync(emptyConfig, { recursive: true });
  fs.writeFileSync(path.join(emptyConfig, "config.json"), "");
  fs.writeFileSync(path.join(emptyConfig, "model.safetensors"), "weights");
  assert.equal(h.mgr._isModelCached(emptyConfig), false, "empty config.json must not be cached");

  const incomplete = path.join(h.home, "incomplete-model");
  fs.mkdirSync(incomplete, { recursive: true });
  fs.writeFileSync(path.join(incomplete, "config.json"), JSON.stringify({ name: "x" }));
  fs.writeFileSync(path.join(incomplete, "weights.npz.incomplete"), "partial");
  const snapLink = path.join(incomplete, "weights.npz");
  fs.symlinkSync("weights.npz.incomplete", snapLink);
  assert.equal(h.mgr._isModelCached(incomplete), false, ".incomplete weights must not be cached");
  fs.unlinkSync(snapLink);

  const brokenIndex = path.join(h.home, "broken-index-model");
  fs.mkdirSync(brokenIndex, { recursive: true });
  fs.writeFileSync(path.join(brokenIndex, "config.json"), JSON.stringify({ name: "x" }));
  fs.writeFileSync(path.join(brokenIndex, "model.safetensors.index.json"), "broken");
  fs.writeFileSync(path.join(brokenIndex, "model.safetensors"), "weights");
  assert.equal(h.mgr._isModelCached(brokenIndex), false, "broken index must not fallback to single weight");

  const shardedMissing = path.join(h.home, "sharded-missing-model");
  fs.mkdirSync(shardedMissing, { recursive: true });
  fs.writeFileSync(path.join(shardedMissing, "config.json"), JSON.stringify({ name: "x" }));
  fs.writeFileSync(path.join(shardedMissing, "model.safetensors.index.json"), JSON.stringify({ weight_map: { a: "model-1.safetensors", b: "model-2.safetensors" } }));
  fs.writeFileSync(path.join(shardedMissing, "model-1.safetensors"), "one");
  assert.equal(h.mgr._isModelCached(shardedMissing), false, "missing shard must not be cached");

  const complete = path.join(h.home, "complete-model");
  fs.mkdirSync(complete, { recursive: true });
  fs.writeFileSync(path.join(complete, "config.json"), JSON.stringify({ name: "x" }));
  fs.writeFileSync(path.join(complete, "model.safetensors"), "weights");
  assert.equal(h.mgr._isModelCached(complete), true, "complete local dir must be cached");
  assert.equal(h.api.isModelCached(complete, h.cacheDir, h.home), true);

  const completeSharded = path.join(h.home, "complete-sharded-model");
  fs.mkdirSync(completeSharded, { recursive: true });
  fs.writeFileSync(path.join(completeSharded, "config.json"), JSON.stringify({ name: "x" }));
  fs.writeFileSync(path.join(completeSharded, "model.safetensors.index.json"), JSON.stringify({ weight_map: { a: "model-1.safetensors", b: "model-2.safetensors" } }));
  fs.writeFileSync(path.join(completeSharded, "model-1.safetensors"), "one");
  fs.writeFileSync(path.join(completeSharded, "model-2.safetensors"), "two");
  assert.equal(h.mgr._isModelCached(completeSharded), true, "complete sharded local dir must be cached");

  // ~-expanded path
  const tildeDir = path.join(h.home, "tilde-model");
  fs.mkdirSync(tildeDir, { recursive: true });
  assert.equal(h.mgr._isModelCached("~/tilde-model"), false, "tilde empty must not be cached");
  fs.writeFileSync(path.join(tildeDir, "config.json"), JSON.stringify({ name: "x" }));
  fs.writeFileSync(path.join(tildeDir, "weights.npz"), "weights");
  assert.equal(h.mgr._isModelCached("~/tilde-model"), true, "tilde complete must be cached");
});

test("escapePlistXml roundtrip preserves & < > \" ' $ and rejects XML-illegal control chars", (t) => {
  const h = harness(t);
  const api = h.api;
  assert.equal(typeof api.escapePlistXml, "function");
  assert.equal(typeof api.unescapePlistXml, "function");
  const cases = [
    "R&D$1<model>",
    'R&D$1<model>"\'',
    "a&b<c>d\"e'f$g$1$&$$",
    "/tmp/models/R&D<v1>$test",
    "already &amp; escaped & should double escape",
  ];
  for (const s of cases) {
    const esc = api.escapePlistXml(s);
    assert.equal(api.unescapePlistXml(esc), s, `unescape(escape(x)) must be identity for ${JSON.stringify(s)}`);
    assert.ok(!esc.includes("<") || esc.includes("&lt;"), "raw < must not remain");
    assert.ok(!esc.includes(">") || esc.includes("&gt;"), "raw > must not remain");
    // No bare & remains: every & must start a known entity
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(esc), `bare & remains for ${JSON.stringify(s)} -> ${esc}`);
    // $ must stay literal (no $&/$1 expansion because callback form)
    if (s.includes("$")) assert.ok(esc.includes("$"), "dollar must stay literal after escape");
  }
  // Exact expectations
  assert.equal(api.escapePlistXml('R&D$1<model>"\''), "R&amp;D$1&lt;model&gt;&quot;&apos;");
  assert.equal(api.escapePlistXml("/tmp/models/R&D<v1>$test"), "/tmp/models/R&amp;D&lt;v1&gt;$test");
  // Control chars rejected
  for (const bad of ["\x00", "a\x01b", "x\x0by", "p\x0cq", "z\x1f"]) {
    assert.throws(() => api.escapePlistXml(bad), /control|XML/i, `must reject ${JSON.stringify(bad)}`);
  }
  // updateLaunchAgentPlistFile must refuse a control-char model without touching the file
  const plist = path.join(h.home, "embed.plist");
  const good = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>old/model</string></dict></dict></plist>';
  fs.writeFileSync(plist, good);
  assert.equal(api.updateLaunchAgentPlistFile(plist, { modelId: "bad\x01model" }), false);
  assert.equal(fs.readFileSync(plist, "utf8"), good, "failed update must leave original plist untouched");
});

test("local model path R&D$1<model> with quotes escapes plist, plutil validates, decoded path exact", (t) => {
  const h = harness(t, { localPaths: true, launchAgent: true });
  // Directory name contains every trigger: & < > " ' $ (with $1 regression + $&/$$ pollution vectors)
  const specialName = 'R&D$1<model>"\'';
  const local = path.join(h.home, "models", specialName);
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "config.json"), "{}");
  fs.writeFileSync(path.join(local, "model.safetensors"), "weights");
  const plistPath = h.mgr.launchAgentPlistPath;
  const initialPlist = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n<key>Label</key><string>com.t3tools.powercontext-embed</string>\n<key>KeepAlive</key><true/>\n<key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>old/model</string><key>EMBED_NAME</key><string>model</string></dict></dict>\n</plist>';
  fs.writeFileSync(plistPath, initialPlist);
  h.state.launchStatus = 0;
  let loadedPath = null;
  h.state.onSwitch = (payload) => {
    loadedPath = payload.modelId;
    assert.equal(loadedPath, local, "hot switch payload must carry the exact absolute special path");
    h.state.health = { ok: true, modelId: loadedPath };
    return { status: 0, stdout: JSON.stringify({ ok: true }) };
  };
  const result = h.mgr.switchModel({ modelId: local });
  assert.equal(result.ok, true, result.error || "");
  assert.equal(result.activeModelId, local);
  assert.equal(loadedPath, local);
  const xml = fs.readFileSync(plistPath, "utf8");
  // Escaped form must be present, raw special name must not leak as markup
  const expectedEscapedModel = h.api.escapePlistXml(local);
  assert.ok(xml.includes("<key>EMBED_MODEL</key><string>" + expectedEscapedModel + "</string>"), "EMBED_MODEL must be escaped");
  assert.ok(xml.includes("&amp;") && xml.includes("&lt;") && xml.includes("&gt;") && xml.includes("&quot;") && xml.includes("&apos;"), "all five entities must appear");
  assert.ok(!xml.includes("<key>EMBED_MODEL</key><string>" + local + "</string>"), "raw unescaped path must not appear in plist");
  // $1/$&/$$ must not trigger String.replace $ semantics: the EMBED_MODEL value must appear exactly once,
  // and the file must not contain a duplicated <key>EMBED_MODEL tag injected via $1 expansion.
  assert.equal((xml.match(/<key>EMBED_MODEL<\/key>/g) || []).length, 1, "$1 in path must not duplicate the prefix via replace pollution");
  assert.equal((xml.match(/<key>EMBED_NAME<\/key>/g) || []).length, 1);
  const expectedEscapedName = h.api.escapePlistXml(specialName);
  assert.ok(xml.includes("<key>EMBED_NAME</key><string>" + expectedEscapedName + "</string>"));
  // plist must still be well-formed XML and plutil must accept it on macOS
  const lint = spawnSync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf8" });
  assert.ok(fs.existsSync("/usr/bin/plutil"), "plutil must exist on macOS runner");
  assert.equal(lint.status, 0, "plutil -lint must pass: " + (lint.stderr || lint.stdout));
  // Decode via Python plistlib: decoded path must match character-for-character
  const py = "import plistlib, json, sys\nd = plistlib.load(open(sys.argv[1], 'rb'))\nprint(json.dumps({'m': d['EnvironmentVariables']['EMBED_MODEL'], 'n': d['EnvironmentVariables']['EMBED_NAME']}))";
  const decoded = spawnSync("python3", ["-c", py, plistPath], { encoding: "utf8" });
  assert.equal(decoded.status, 0, decoded.stderr || decoded.stdout);
  const parsed = JSON.parse(decoded.stdout);
  assert.equal(parsed.m, local, "decoded EMBED_MODEL must equal original path exactly");
  assert.equal(parsed.n, specialName, "decoded EMBED_NAME must equal special dir name exactly");
  // Two-phase ordering: Phase 1 stages + validates to tmp without overwriting the
  // official plist, so bootout still sees the stale service definition; Phase 2
  // atomically commits the validated tmp after bootout and before bootstrap.
  assert.deepEqual(h.launchCalls.map((a) => a[0]), ["bootout", "bootstrap"]);
  assert.equal(h.bootoutSnapshots.length, 1);
  assert.equal(h.bootoutSnapshots[0], initialPlist, "bootout must still see the stale plist (prepare must not overwrite the official plist)");
  assert.ok(!h.bootoutSnapshots[0].includes(expectedEscapedModel), "bootout must not see the new model yet");
  assert.equal(h.bootstrapSnapshots.length, 1);
  assert.ok(h.bootstrapSnapshots[0].includes(expectedEscapedModel), "bootstrap must see the atomically committed new plist");
  assert.equal(fs.readdirSync(h.home).filter((f) => f.includes(".tmp-")).length, 0, "no staged tmp must remain after commit");
  assert.equal(h.services().length, 0, "launchd owns the process, no independent spawn");
  assert.equal(h.children.length, 0);
});

test("plist update validates before bootout: control-char path never calls bootout", (t) => {
  const h = harness(t, { localPaths: true, launchAgent: true });
  const plistPath = h.mgr.launchAgentPlistPath;
  const initialPlist = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.t3tools.powercontext-embed</string><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>old/model</string><key>EMBED_NAME</key><string>model</string></dict></dict></plist>';
  fs.writeFileSync(plistPath, initialPlist);
  const before = fs.readFileSync(plistPath, "utf8");
  // Direct veto: control char must fail validation and leave file + launchd untouched
  assert.equal(h.api.updateLaunchAgentPlistFile(plistPath, { modelId: "bad\x01model", servedName: "bad\x01model" }), false);
  assert.equal(fs.readFileSync(plistPath, "utf8"), before);
  assert.deepEqual(h.launchCalls, [], "no bootout/bootstrap must fire when plist validation fails");
  // Even through switchModel, an illegal local path fails pre-validation with zero launchctl side effects
  const h2 = harness(t, { localPaths: true, launchAgent: true });
  fs.writeFileSync(h2.mgr.launchAgentPlistPath, initialPlist);
  const illegal = "/bad\x01path";
  const res = h2.mgr.switchModel({ modelId: illegal });
  assert.equal(res.ok, false);
  assert.deepEqual(h2.launchCalls, [], "illegal switchModel must never call bootout/bootstrap");
  assert.equal(fs.readFileSync(h2.mgr.launchAgentPlistPath, "utf8"), initialPlist);
  assert.equal(fs.readdirSync(h2.home).filter((f) => f.includes(".tmp-")).length, 0, "failed prepare must leave no tmp behind");
});

// Transaction regressions: every fixture, subprocess and timer stays isolated.
for (const target of ["cached", "download", "fts5"]) {
  for (const failure of ["prepare", "bootout-eacces", "bootout-unknown", "bootout-throw", "commit"]) {
    test(`launchd ${failure} preserves config and in-flight work (${target})`, (t) => {
      const h = harness(t, { launchAgent: true });
      let reindexed = 0;
      const original = h.mgr.switchModel({ modelId: MODEL, onReadyReindex: () => reindexed++ });
      assert.equal(original.downloading, true);
      const job = original.downloadJob, child = h.children[0];
      const oldConfig = fs.readFileSync(h.mgr.configPath, "utf8");
      const oldTimers = [...h.timers.keys()];
      const plist = failure === "prepare" ? '<plist><dict><key>broken</key></dict></plist>' : TRANSACTION_PLIST;
      fs.writeFileSync(h.mgr.launchAgentPlistPath, plist);
      h.state.launchStatus = 0;
      if (failure === "bootout-eacces") h.state.bootoutResult = { status: 1, stderr: "Operation not permitted (EPERM)" };
      if (failure === "bootout-unknown") h.state.bootoutResult = { status: 5, stdout: "", stderr: "" };
      if (failure === "bootout-throw") h.state.bootoutThrow = new Error("EACCES");
      if (failure === "commit") h.state.failPlistCommit = true;
      if (target === "cached") h.cache("test/next");
      const result = h.mgr.switchModel(target === "fts5" ? { mode: "fts5" } : { modelId: "test/next" });
      assert.equal(result.ok, false, JSON.stringify(result));
      if (failure.startsWith("bootout")) assert.match(result.error, /bootout/i);
      assert.equal(fs.readFileSync(h.mgr.configPath, "utf8"), oldConfig, "config bytes unchanged");
      assert.equal(fs.readFileSync(h.mgr.launchAgentPlistPath, "utf8"), plist, "official plist unchanged");
      assert.deepEqual(h.launchCalls.map((a) => a[0]), failure === "prepare" ? [] : failure === "commit" ? ["bootout", "bootstrap"] : ["bootout"]);
      assert.equal(h.mgr.getStatus().downloadJob, job);
      assert.equal(job.cancelled, false);
      assert.equal(job.active, true);
      assert.deepEqual(child.signals, []);
      assert.deepEqual([...h.timers.keys()], oldTimers, "no work generation/timer invalidation");
      assert.equal(h.children.length, 1);
      assert.equal(fs.readdirSync(h.home).filter((f) => f.includes(".tmp-")).length, 0);
      // The preserved generation must really finish and reindex normally.
      fs.writeFileSync(h.mgr.launchAgentPlistPath, TRANSACTION_PLIST);
      h.state.failPlistCommit = false;
      h.cache();
      child.finish(0);
      h.state.health = { ok: true, modelId: MODEL };
      h.advance(500);
      assert.equal(job.status, "completed");
      assert.equal(reindexed, 1);
      assert.equal(h.services().length, 0);
    });
  }
}

for (const [name, result, allowed] of [
  ["status success", { status: 0 }, true],
  ["ok success", { ok: true }, true],
  ["code success", { code: 0 }, true],
  ["ESRCH", { status: 3 }, true],
  ["service missing", { status: 113 }, true],
  ["no process", { status: 1, stderr: "Boot-out failed: No such process" }, true],
  ["not found", { status: 1, stderr: "Could not find specified service" }, true],
  ["disabled", { status: 1, stderr: "service is disabled" }, true],
  ["permission", { status: 1, stderr: "EACCES: Permission denied" }, false],
  ["ambiguous missing", { status: 1 }, false],
  ["null result", null, false],
  ["spawn error", { status: null, error: { code: "EPERM" } }, false],
  ["timeout despite missing text", { status: null, error: { code: "ETIMEDOUT" }, stderr: "No such process" }, false],
  ["signal despite ESRCH", { status: 3, signal: "SIGTERM" }, false],
]) for (const target of ["cached", "download", "fts5"]) {
  test(`bootout ${name} is ${allowed ? "accepted" : "rejected"} (${target})`, (t) => {
    const h = harness(t, { launchAgent: true });
    fs.writeFileSync(h.mgr.launchAgentPlistPath, TRANSACTION_PLIST);
    h.state.bootoutResult = result;
    h.state.launchStatus = 0;
    if (target === "cached") h.cache();
    const switched = h.mgr.switchModel(target === "fts5" ? { mode: "fts5" } : { modelId: MODEL });
    assert.equal(switched.ok, allowed, JSON.stringify(switched));
    assert.equal(fs.readdirSync(h.home).filter((f) => f.includes(".tmp-")).length, 0);
    if (!allowed) {
      assert.match(switched.error, /bootout/i);
      assert.equal(fs.readFileSync(h.mgr.launchAgentPlistPath, "utf8"), TRANSACTION_PLIST);
      assert.equal(fs.existsSync(h.mgr.configPath), false, "failed switch must not create config");
      assert.deepEqual(h.launchCalls.map((a) => a[0]), ["bootout"]);
      assert.equal(h.children.length, 0);
    } else {
      assert.equal(h.launchConfigs[0].config, null, "bootout sees original config (absent)");
      const xml = fs.readFileSync(h.mgr.launchAgentPlistPath, "utf8");
      assert.match(xml, new RegExp('<key>KeepAlive</key>\\s*<' + (target === "cached" ? "true" : "false") + '\\s*/>'));
      const bootstrap = h.launchConfigs.find((entry) => entry.op === "bootstrap");
      if (target === "cached") assert.equal(JSON.parse(bootstrap.config).modelId, MODEL);
    }
  });
}

for (const [name, body] of [
  ["empty top dict", '<dict/>'],
  ["missing keys", '<dict><key>Other</key><dict><key>KeepAlive</key><false/></dict></dict>'],
  ["empty environment", '<dict><key>EnvironmentVariables</key><dict/></dict>'],
  ["formatted XML attributes", '<dict><key>KeepAlive</key><!-- gap --><true /></dict>'],
  ["comments and whitespace", '<dict ><key >KeepAlive</key><!-- keep --><false /> <key>EnvironmentVariables</key><!-- env --><dict ><key >EMBED_MODEL</key><!-- value --><string >old/model</string><key>EMBED_NAME</key><string/><key>HF_HUB_DISABLE_XET</key><!-- Xet --><string>0</string><key>CUSTOM</key><string>preserve</string></dict></dict>'],
  ["comment decoys", '<dict><!-- <key>KeepAlive</key><false/> --><key>Other</key><dict><key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>decoy</string></dict></dict></dict>'],
]) {
  test(`plist patch fills scoped required fields: ${name}`, (t) => {
    const h = harness(t);
    const plistPath = path.join(h.home, "patch.plist");
    const xml = (name === "formatted XML attributes" ? '\uFEFF<?xml version = "1.0" encoding = "UTF-8" ?>\n<plist\n version = "1.0" >' : '<?xml version="1.0"?><plist version="1.0">') + body + '</plist>';
    fs.writeFileSync(plistPath, xml);
    const modelId = '/local/R&D$1<model>"\'', servedName = 'R&D$&<name>"\'';
    const prepared = h.api.prepareLaunchAgentPlistFile(plistPath, { modelId, servedName, keepAlive: true });
    assert.equal(prepared.ok, true);
    assert.equal(fs.readFileSync(plistPath, "utf8"), xml, "prepare never overwrites original");
    const staged = fs.readFileSync(prepared.tmpPath, "utf8");
    assert.ok(staged.includes(h.api.escapePlistXml(modelId)));
    assert.ok(staged.includes(h.api.escapePlistXml(servedName)));
    const decoded = spawnSync("python3", ["-c", "import plistlib,json,sys; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))", prepared.tmpPath], { encoding: "utf8" });
    assert.equal(decoded.status, 0, decoded.stderr);
    const dict = JSON.parse(decoded.stdout);
    assert.equal(dict.KeepAlive, true);
    assert.equal(dict.EnvironmentVariables.EMBED_MODEL, modelId);
    assert.equal(dict.EnvironmentVariables.EMBED_NAME, servedName);
    assert.equal(dict.EnvironmentVariables.HF_HUB_DISABLE_XET, "1");
    if (name === "comments and whitespace") assert.equal(dict.EnvironmentVariables.CUSTOM, "preserve");
    if (name === "missing keys") assert.equal(dict.Other.KeepAlive, false, "nested decoys unchanged");
    if (name === "comment decoys") assert.equal(dict.Other.EnvironmentVariables.EMBED_MODEL, "decoy");
    h.api.discardLaunchAgentPlistFile(prepared);
  });
}

for (const [name, result] of [
  ["empty nonzero output", { status: 1, stdout: "", stderr: "" }],
  ["timeout", { error: { code: "ETIMEDOUT" }, status: null }],
  ["permission", { error: { code: "EACCES" }, status: null }],
  ["error with zero status", { error: { code: "EIO" }, status: 0 }],
  ["signal", { status: null, signal: "SIGTERM" }],
  ["unknown status", {}],
  ["missing macOS plutil", { error: { code: "ENOENT" }, status: null }],
]) {
  test(`plutil rejects ${name} before any launchd/config/work side effect`, (t) => {
    const h = harness(t, { launchAgent: true, platform: "darwin" });
    fs.writeFileSync(h.mgr.launchAgentPlistPath, TRANSACTION_PLIST);
    h.state.launchStatus = 0;
    h.state.plutilResult = result;
    h.cache();
    assert.equal(h.mgr.switchModel({ modelId: MODEL }).ok, false);
    assert.deepEqual(h.launchCalls, []);
    assert.equal(fs.existsSync(h.mgr.configPath), false);
    assert.equal(fs.readFileSync(h.mgr.launchAgentPlistPath, "utf8"), TRANSACTION_PLIST);
    assert.equal(fs.readdirSync(h.home).filter((f) => f.includes(".tmp-")).length, 0);
  });
}

test("plutil thrown exception rejects preparation", (t) => {
  const h = harness(t);
  const plist = path.join(h.home, "embed.plist");
  fs.writeFileSync(plist, TRANSACTION_PLIST);
  h.state.plutilThrow = new Error("spawn exception");
  assert.equal(h.api.updateLaunchAgentPlistFile(plist, { keepAlive: false }), false);
  assert.equal(fs.readFileSync(plist, "utf8"), TRANSACTION_PLIST);
});

for (const [name, xml, valid] of [
  ["valid fallback", TRANSACTION_PLIST, true],
  ["crossed tags", '<plist><dict><key>Other</key><array><string>x</string></dict></array></plist>', false],
  ["dangling key", '<plist><dict><key>Other</key></dict></plist>', false],
  ["duplicate key", '<plist><dict><key>KeepAlive</key><true/><key>KeepAlive</key><false/></dict></plist>', false],
  ["multiple roots", TRANSACTION_PLIST + TRANSACTION_PLIST, false],
  ["invalid entity", '<plist><dict><key>Other</key><string>&#0;</string></dict></plist>', false],
  ["missing top dict", '<plist><array/></plist>', false],
]) {
  test(`non-macOS missing-plutil fallback is strict: ${name}`, (t) => {
    const h = harness(t, { platform: "linux" });
    h.state.plutilResult = { error: { code: "ENOENT" }, status: null };
    const plist = path.join(h.home, "embed.plist");
    fs.writeFileSync(plist, xml);
    assert.equal(h.api.updateLaunchAgentPlistFile(plist, { modelId: MODEL, servedName: "embedding", keepAlive: true }), valid);
    if (!valid) assert.equal(fs.readFileSync(plist, "utf8"), xml);
    assert.equal(fs.readdirSync(h.home).filter((f) => f.includes(".tmp-")).length, 0);
  });
}

test("plist commit failure restores previously loaded launchd service and reports recovery outcome", (t) => {
  // 1) Loaded service unloaded by bootout -> bootstrap restores intact original plist & config
  const h1 = harness(t, { launchAgent: true });
  fs.writeFileSync(h1.mgr.launchAgentPlistPath, TRANSACTION_PLIST);
  h1.state.launchStatus = 0;
  h1.state.failPlistCommit = true;
  h1.cache(MODEL);
  const r1 = h1.mgr.switchModel({ modelId: MODEL });
  assert.equal(r1.ok, false);
  assert.deepEqual(h1.launchCalls.map((a) => a[0]), ["bootout", "bootstrap"]);
  assert.equal(h1.bootstrapSnapshots[0], TRANSACTION_PLIST, "recovery bootstrap must load intact original plist");
  assert.match(r1.error, /已恢复原 launchd 服务/);

  // 2) Previously absent service (bootout ESRCH) -> commit failure does NOT start absent service
  const h2 = harness(t, { launchAgent: true });
  fs.writeFileSync(h2.mgr.launchAgentPlistPath, TRANSACTION_PLIST);
  h2.state.bootoutResult = { status: 3, stderr: "ESRCH" };
  h2.state.launchStatus = 0;
  h2.state.failPlistCommit = true;
  h2.cache(MODEL);
  const r2 = h2.mgr.switchModel({ modelId: MODEL });
  assert.equal(r2.ok, false);
  assert.deepEqual(h2.launchCalls.map((a) => a[0]), ["bootout"], "must not bootstrap a service that was absent before bootout");

  // 3) Loaded service unloaded by bootout, and BOTH bootstrap and kickstart fail during recovery -> error surfaces recovery failure
  const h3 = harness(t, { launchAgent: true });
  fs.writeFileSync(h3.mgr.launchAgentPlistPath, TRANSACTION_PLIST);
  h3.state.launchStatuses = { bootout: 0, bootstrap: 1, kickstart: 1 };
  h3.state.failPlistCommit = true;
  h3.cache(MODEL);
  const r3 = h3.mgr.switchModel({ modelId: MODEL });
  assert.equal(r3.ok, false);
  assert.deepEqual(h3.launchCalls.map((a) => a[0]), ["bootout", "bootstrap", "kickstart"]);
  assert.match(r3.error, /恢复原服务失败/);
});
