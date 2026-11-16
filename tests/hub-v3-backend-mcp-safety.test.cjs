"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// All backend singletons and native-host operations stay in an isolated HOME.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-backend-mcp-safety-"));
process.env.HOME = root;
process.env.T3CODE_HOME = path.join(root, "userdata");
process.env.T3_HUB_DIR = path.join(root, ".t3", "hub");
process.env.MUSE_DATA_DIR = path.join(root, "muse-data");
process.env.CODEX_HOME = path.join(root, ".codex");
process.env.T3_HUB_TEST = "1";
process.env.NODE_ENV = "test";
const backend = require("../src/backend.cjs");
const { createMcpRouter } = require("../src/mcp-router.cjs");
after(() => fs.rmSync(root, { recursive: true, force: true }));

function put(file, raw, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw, { mode });
  fs.chmodSync(file, mode);
}
function fixture(t, agent = "muse") {
  const homeDir = fs.mkdtempSync(path.join(root, "host-"));
  const hubDir = path.join(homeDir, ".t3", "hub");
  const relative = {
    muse: ".config/muse/settings.json", pi: ".pi/agent/mcp.json",
    claude: ".claude/mcp.json", antigravity: ".t3/userdata/providers/antigravity/safety-instance/config/mcp_config.json",
    codex: ".codex/config.toml", zcode: ".zcode/cli/mcp.json",
  };
  const file = path.join(homeDir, relative[agent]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  put(path.join(hubDir, "mcp-registry.json"), JSON.stringify([{ name: "safety-target", command: "node", args: ["target.cjs"] }]));
  const router = createMcpRouter({ homeDir, hubDir });
  return { homeDir, file, router, toggle: enabled => router.toggleServerForAgent({ name: "safety-target", agent, enabled }) };
}

const usages = [
  { input: 101, cached: 17, write: 3, output: 23, reasoning: 7 },
  { input: 503, cached: 113, write: 13, output: 71, reasoning: 11 },
  { input: 907, cached: 211, write: 19, output: 103, reasoning: 13 },
  { input: 1301, cached: 317, write: 29, output: 151, reasoning: 17 },
];
function usageRecord(kind, u) {
  if (kind === "muse") return { payload: { event: { kind: "model_completed", model: "safety-unknown-model", usage: {
    input_tokens: u.input, cache_read_tokens: u.cached, cache_write_tokens: u.write,
    output_tokens: u.output, reasoning_tokens: u.reasoning,
  } } } };
  return { type: "token_usage_record", payload: { model: "safety-unknown-model", usage: {
    input_tokens: u.input, cached_input_tokens: u.cached, cache_write_input_tokens: u.write,
    output_tokens: u.output, reasoning_output_tokens: u.reasoning,
  } } };
}
function writeLargeSession(file, kind, mb) {
  const fd = fs.openSync(file, "w");
  let bytes = 0;
  const write = text => { bytes += fs.writeSync(fd, text); };
  // Chinese starts at byte 262143, splitting its first UTF-8 character across chunks.
  const prefix = '{"note":"';
  const first = usageRecord(kind, usages[0]);
  write(prefix + "a".repeat(256 * 1024 - 1 - Buffer.byteLength(prefix)) + "中文🙂");
  write('",' + JSON.stringify(first).slice(1) + "\r\n");
  const filler = JSON.stringify({ note: "中文🙂".repeat(800) }) + "\n";
  const padTo = size => { while (bytes < size) write(filler); };
  try {
    padTo(4 * 1024 * 1024);
    write(JSON.stringify(usageRecord(kind, usages[1])) + "\n");
    padTo(7 * 1024 * 1024);
    write(JSON.stringify(usageRecord(kind, usages[2])) + "\n");
    padTo(mb * 1024 * 1024);
    write(JSON.stringify(usageRecord(kind, usages[3]))); // final line without LF
  } finally { fs.closeSync(fd); }
}

for (const kind of ["codex", "muse"]) for (const mb of [30, 200]) {
  test(`${kind}: ${mb}MB full-session accounting, fixed reads, cache hit and invalidation`, () => {
    const file = path.join(root, `${kind}-${mb}.jsonl`);
    writeLargeSession(file, kind, mb);
    const parse = kind === "muse" ? backend.readMuseSessionFile : backend.readCodexSessionFile;
    const open = fs.openSync, read = fs.readSync, readFile = fs.readFileSync;
    let targetFd, reads = 0, bytesRead = 0, maxBuffer = 0;
    fs.openSync = function (p, ...args) { const fd = open.call(this, p, ...args); if (p === file) targetFd = fd; return fd; };
    fs.readSync = function (fd, buffer, ...args) {
      const n = read.call(this, fd, buffer, ...args);
      if (fd === targetFd) { reads++; bytesRead += n; maxBuffer = Math.max(maxBuffer, buffer.byteLength); }
      return n;
    };
    fs.readFileSync = function (p, ...args) { assert.notEqual(p, file, "accounting must never read the entire file"); return readFile.call(this, p, ...args); };
    try {
      const result = parse(file);
      assert.equal(result.stepCount, usages.length, "middle usage records must count");
      for (const [field, get] of Object.entries({
        uncached: u => u.input - u.cached - u.write, cached: u => u.cached,
        cacheWrite: u => u.write, output: u => u.output, reasoning: u => u.reasoning,
      })) assert.equal(result[field], usages.reduce((sum, u) => sum + get(u), 0), field);
      const expectedUsd = usages.reduce((sum, u) => sum + (u.input - u.cached - u.write) * 5.4e-6 + u.cached * 0.54e-6 + u.write * 5.4e-6 + u.output * 27e-6, 0);
      const expectedSaved = usages.reduce((sum, u) => sum + u.cached * (5.4e-6 - 0.54e-6), 0);
      assert.ok(Math.abs(result.usd - expectedUsd) < 1e-12);
      assert.ok(Math.abs(result.savedUsd - expectedSaved) < 1e-12);
      assert.equal(result.lastStepCacheRate, usages[3].cached / usages[3].input);
      assert.equal(bytesRead, fs.statSync(file).size, "scan every byte exactly once");
      assert.ok(maxBuffer <= 256 * 1024, `fixed scan buffer: ${maxBuffer}`);
      const parsedReads = reads;
      assert.strictEqual(parse(file), result);
      assert.equal(reads, parsedReads, "unchanged mtime+size must not re-scan");
      fs.appendFileSync(file, "\n" + JSON.stringify(usageRecord(kind, usages[0])));
      assert.equal(parse(file).stepCount, usages.length + 1);
      assert.ok(reads > parsedReads, "size changes invalidate cache");
      const beforeTouch = reads, stat = fs.statSync(file);
      fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 2000));
      assert.equal(parse(file).stepCount, usages.length + 1);
      assert.ok(reads > beforeTouch, "mtime changes with unchanged size invalidate cache");
    } finally { fs.openSync = open; fs.readSync = read; fs.readFileSync = readFile; fs.rmSync(file); }
  });
}

test("line scanner preserves UTF-8/CRLF/empty lines and always closes its descriptor", () => {
  const file = path.join(root, "unicode.jsonl");
  const content = '中文🙂\r\n\n{"尾":"末尾"}';
  put(file, content);
  for (const chunkBytes of [1, 2, 3, 7, 256 * 1024]) {
    const lines = [];
    backend.forEachJsonlLineSync(file, line => lines.push(line), { chunkBytes });
    assert.deepEqual(lines, ["中文🙂\r", "", '{"尾":"末尾"}']);
  }
  const open = fs.openSync;
  let descriptor;
  fs.openSync = function (...args) { return descriptor = open.apply(this, args); };
  try {
    assert.throws(() => backend.forEachJsonlLineSync(file, () => { throw new Error("callback failure"); }), /callback failure/);
    assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  } finally { fs.openSync = open; }
});

test("line scanner bounds oversized lines and recovers exact records after the next newline", () => {
  const file = path.join(root, "oversized.jsonl");
  const exact = "中".repeat(4096);
  const content = "x".repeat(4097) + "\n" + exact + "\n" + "z".repeat(9000) + '\n{"usage":123}\n' + "z".repeat(4097);
  put(file, content);
  for (const chunkBytes of [1, 7, 4096, 256 * 1024]) {
    const lines = [];
    const stats = backend.forEachJsonlLineSync(file, line => lines.push(line), { chunkBytes, maxLineChars: 4096 });
    assert.deepEqual(lines, [exact, '{"usage":123}']);
    assert.equal(stats.skippedOversizedLines, 3);
    assert.ok(stats.maxBufferedLineChars <= 4096);
  }
  for (const maxLineChars of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => backend.forEachJsonlLineSync(file, () => {}, { maxLineChars }), /maxLineChars/);
  }
});

test("line scanner handles a 192MB no-newline file under a 64MB V8 heap", () => {
  const file = path.join(root, "no-newline.jsonl"), fd = fs.openSync(file, "w");
  try {
    const block = Buffer.alloc(1024 * 1024, 0x78);
    for (let i = 0; i < 192; i++) fs.writeSync(fd, block);
  } finally { fs.closeSync(fd); }
  try {
    const child = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", `
      const assert = require('node:assert/strict'), fs = require('node:fs');
      const backend = require(process.argv[1]), file = process.argv[2];
      let count = 0;
      const stats = backend.forEachJsonlLineSync(file, () => count++);
      assert.equal(count, 0); assert.equal(stats.skippedOversizedLines, 1);
      assert.ok(stats.maxBufferedLineChars <= 8 * 1024 * 1024);
      fs.appendFileSync(file, '\\n{"usage":123}');
      const lines = [];
      assert.equal(backend.forEachJsonlLineSync(file, line => lines.push(line)).skippedOversizedLines, 1);
      assert.deepEqual(lines, ['{"usage":123}']);
    `, require.resolve("../src/backend.cjs"), file], { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
  } finally { fs.rmSync(file); }
});

const invalidTomlValues = [
  'x = [', 'x = {', 'x = "unclosed', "x = 'unclosed", '[broken',
  'broken = not_a_toml_value', 'x = 123 [', 'x = "ok" garbage', "x = 'ok' garbage",
  'x = """ok\nend""" garbage', "x = '''ok\nend''' garbage",
  'x = [1 2]', 'x = [1,,2]', 'x = [true, nope]', 'x = [1] garbage',
  'x = { a = 1 b = 2 }', 'x = { a = nope }', 'x = { a = 1, a = 2 }', 'x = { a = 1, }',
  'a = 1\na = 2', 'a.b = 1\na.b = 2', 'a = 1\na.b = 2', 'a.b = 1\na = 2',
  'a = 1\n"\\u0061" = 2', '[a]\nb = 1\nb = 2', '[a]\nb = 1\n[a]\nc = 2',
  'a.b = 1\n[a]\nc = 2', 'a = {}\n[a]\nb = 1', '[a]\nb = 1\n[[a]]\nc = 2',
  'a = []\n[[a]]\nb = 1', 'x = { a.b = 1, a = 2 }', 'x = { a = {}, a.b = 2 }',
  '[a.b.c]\nz = 9\n[a]\nb.c.t = "conflict"', '[a.b.c.d]\nz = 9\n[a]\nb.c.d.k.t = "conflict"',
  'x = 01', 'x = 1__2', 'x = 0x_G', 'x = +0x12', 'x = 1.', 'x = .5', 'x = 1e', 'x = TRUE',
  'x = 2025-02-29', 'x = 2000-13-01', 'x = 25:00:00', 'x = 1979-05-27T12:34:56+25:00',
  'x = "bad\\q"', 'x = "\\uD800"', '["\\uD800"]\nx = 1',
];
for (const raw of invalidTomlValues) test(`Codex strict TOML refuses writes: ${JSON.stringify(raw)}`, t => {
  const f = fixture(t, "codex");
  // Headers are absolute: nesting their preceding keys would change whether a
  // conflict exists, rather than merely testing a section that gets removed.
  for (const prefix of /^\[/m.test(raw) ? [""] : ["", "[mcp_servers.safety-target]\n"]) {
    const original = prefix + raw + "\n";
    put(f.file, original, 0o640);
    for (const enabled of [true, false]) {
      assert.throws(() => f.toggle(enabled), /native MCP config|TOML/i);
      assert.equal(fs.readFileSync(f.file, "utf8"), original);
    }
    assert.ok(!fs.existsSync(f.file + ".t3hub.bak"));
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  }
});

test("Codex strict TOML rejects scalar and duplicate-key corruption during sync preflight", t => {
  const f = fixture(t, "codex"), other = path.join(f.homeDir, ".claude", "mcp.json");
  put(other, '{"keep":true}');
  for (const raw of ['broken = not_a_toml_value\n', 'x = 1\nx = 2\n', 'x = "ok" garbage\n']) {
    put(f.file, raw);
    assert.throws(() => f.router.syncRouterToClis(), /native MCP config|TOML/i);
    assert.equal(fs.readFileSync(f.file, "utf8"), raw);
    assert.equal(fs.readFileSync(other, "utf8"), '{"keep":true}');
    assert.ok(!fs.existsSync(other + ".t3hub.bak"));
    assert.ok(!fs.existsSync(f.file + ".t3hub.bak"));
  }
});

test("sync preflight rejects unclosed TOML before layout skips without touching any host", t => {
  const f = fixture(t, "codex");
  const others = [
    ".pi/agent/mcp.json", ".config/muse/settings.json", ".claude/mcp.json",
    ".zcode/cli/mcp.json", ".t3/userdata/providers/antigravity/safety-instance/config/mcp_config.json",
  ].map(relative => path.join(f.homeDir, relative));
  const originalJson = '{"keep":"unchanged","mcpServers":{"user":{"command":"keep"}}}';
  for (const file of others) put(file, originalJson, 0o640);
  // Even an unsupported but legal MCP layout must not hide later corruption.
  for (const prefix of ["", 'mcp_servers = { t3_hub = {} }\n', '[mcp_servers.t3_hub]\n']) {
    for (const broken of ['x = [', 'x = {', 'x = "unclosed', "x = 'unclosed", '[broken', 'x = nope', 'x = 1\nx = 2']) {
      const raw = prefix + broken + "\n";
      put(f.file, raw, 0o640);
      const files = [f.file, ...others];
      const stamps = files.map(file => fs.statSync(file).mtimeMs);
      assert.throws(() => f.router.syncRouterToClis(), /native MCP config|TOML/i, raw);
      for (const [index, file] of files.entries()) {
        assert.equal(fs.readFileSync(file, "utf8"), index === 0 ? raw : originalJson);
        assert.equal(fs.statSync(file).mode & 0o777, 0o640);
        assert.equal(fs.statSync(file).mtimeMs, stamps[index]);
        for (const suffix of [".t3hub.bak", ".bak-t3hub"]) assert.ok(!fs.existsSync(file + suffix));
      }
    }
  }
});

for (const operation of ["toggle-all", "set-agents"]) test(`${operation}: preflight rejects later corrupt TOML/JSON before any host write`, t => {
  const f = fixture(t, "codex");
  const files = [
    ".t3/userdata/providers/antigravity/safety-instance/config/mcp_config.json",
    ".config/muse/settings.json", ".codex/config.toml", ".pi/agent/mcp.json", ".claude/mcp.json",
  ].map(relative => path.join(f.homeDir, relative));
  const originalJson = '{"keep":true,"mcpServers":{"safety-target":{"command":"keep"}}}';
  for (const enabled of [true, false]) for (const badIndex of [2, 4]) {
    const originals = files.map((file, index) => index === badIndex ? (index === 2 ? 'x = [\n' : '{"broken":') :
      index === 2 ? 'model = "keep"\n' : originalJson);
    files.forEach((file, index) => put(file, originals[index], 0o640));
    const invoke = () => operation === "toggle-all" ?
      f.router.toggleServerForAgent({ name: "safety-target", agent: "all", enabled }) :
      f.router.setServerAgents({ name: "safety-target", agents: enabled ? ["antigravity", "muse", "codex", "pi", "claude"] : [] });
    assert.throws(invoke, /native MCP config|TOML/i);
    files.forEach((file, index) => {
      assert.equal(fs.readFileSync(file, "utf8"), originals[index]);
      assert.equal(fs.statSync(file).mode & 0o777, 0o640);
      for (const suffix of [".t3hub.bak", ".bak-t3hub"]) assert.ok(!fs.existsSync(file + suffix));
    });
  }
});

test("Codex strict TOML preserves legal scalars, nested values, quoted paths and table arrays", t => {
  const f = fixture(t, "codex");
  const raw = [
    'bool = [true, false]', 'ints = [0, +12, -1_234, 0xDEAD_beef, 0o755, 0b1010_0010]',
    'floats = [0.1, -0.0, +1_234.5_6e-1_0, 1e6, inf, +inf, -inf, nan, +nan, -nan]',
    'dates = [2000-02-29, 07:32:00.123, 1979-05-27T07:32:00Z, 1979-05-27t07:32:00z, 1979-05-27 07:32:00-07:00]',
    'nested = { "a.b" = [1, { x = true }], a.b = 1, a.c = 2 }',
    'text = """line\\\n  continued with \\U0001F600""" # comment',
    '[parent.child]', 'value = "ok"', '[parent]', 'other = 1',
    '[[products]]', 'name = "first"', '[products.details]', 'x = 1',
    '[[products]]', 'name = "second"', '[products.details]', 'x = 2',
    '[[products.parts]]', 'x = 1', '[[products.parts]]', 'x = 2',
    '["quoted.table".\'literal.key\']', '"" = "empty key"', '',
  ].join("\n");
  put(f.file, raw);
  f.toggle(true); f.toggle(false);
  assert.equal(fs.readFileSync(f.file, "utf8").trim(), raw.trim());
});

for (const agent of ["muse", "pi", "claude", "antigravity"]) {
  for (const raw of ['{ "mcpServers": { "user-keep": ', "[]", "null", "false", "0", '"text"', '{"mcpServers":null}', '{"mcpServers":[]}']) {
    test(`${agent}: rejects malformed/non-object native JSON ${raw}`, t => {
      const f = fixture(t, agent);
      put(f.file, raw);
      for (const enabled of [true, false]) {
        assert.throws(() => f.toggle(enabled), /native MCP config|mcpServers/i);
        assert.equal(fs.readFileSync(f.file, "utf8"), raw);
        assert.ok(!fs.existsSync(f.file + ".t3hub.bak"));
      }
    });
  }
  test(`${agent}: ENOENT initializes securely; valid config preserves unrelated keys and mode`, t => {
    const f = fixture(t, agent);
    f.toggle(true);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).mcpServers["safety-target"].command, "node");
    const original = { theme: "中文", mcpServers: { "user-keep": { command: "keep" } } };
    put(f.file, JSON.stringify(original), 0o640);
    f.toggle(true); f.toggle(false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), original);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  });
}

for (const agent of ["muse", "codex"]) {
  test(`${agent}: unreadable native config rejects toggle and sync without changing bytes`, t => {
    const f = fixture(t, agent), raw = agent === "codex" ? 'model = "keep"\n' : '{"keep":true}';
    put(f.file, raw);
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (file === f.file) throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
      return read.call(this, file, ...args);
    };
    try {
      for (const enabled of [true, false]) assert.throws(() => f.toggle(enabled), /native MCP config.*EACCES/i);
      assert.throws(() => f.router.syncRouterToClis(), /native MCP config.*EACCES/i);
    } finally { fs.readFileSync = read; }
    assert.equal(fs.readFileSync(f.file, "utf8"), raw);
  });
  test(`${agent}: backup failure aborts toggle and sync; existing permissions survive successful writes`, t => {
    const f = fixture(t, agent), raw = agent === "codex" ? 'model = "keep"\n' : '{"keep":true}';
    put(f.file, raw, 0o640);
    const copy = fs.copyFileSync;
    fs.copyFileSync = function (file, ...args) {
      if (file === f.file) throw Object.assign(new Error("injected backup failure"), { code: "EACCES" });
      return copy.call(this, file, ...args);
    };
    try {
      for (const enabled of [true, false]) {
        // Removing an absent Codex block is a no-op and needs no backup.
        if (agent === "codex" && !enabled) continue;
        assert.throws(() => f.toggle(enabled), /backup failure/);
        assert.equal(fs.readFileSync(f.file, "utf8"), raw);
      }
      assert.throws(() => f.router.syncRouterToClis(), /backup failure/);
      assert.equal(fs.readFileSync(f.file, "utf8"), raw);
    } finally { fs.copyFileSync = copy; }
    f.toggle(true); f.toggle(false); f.router.syncRouterToClis();
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  });
}

for (const agent of ["muse", "pi", "claude", "zcode"]) test(`${agent}: sync refuses corrupted JSON instead of skipping silently`, t => {
  const f = fixture(t, agent), raw = '{ "mcpServers": { "user-keep": ';
  put(f.file, raw);
  assert.throws(() => f.router.syncRouterToClis(), /native MCP config/i);
  assert.equal(fs.readFileSync(f.file, "utf8"), raw);
});

test("Codex toggle preserves multiline text resembling MCP headers, and rejects broken TOML", t => {
  const f = fixture(t, "codex");
  const raw = 'note = """\n[mcp_servers.safety-target]\ntext must survive\n"""\n[other]\nvalue = "中文"\n';
  put(f.file, raw, 0o640);
  f.toggle(true); f.toggle(false);
  assert.ok(fs.readFileSync(f.file, "utf8").includes(raw.trim()));
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  put(f.file, 'note = """unclosed\n[mcp_servers.safety-target]\n');
  const bad = fs.readFileSync(f.file);
  for (const enabled of [true, false]) {
    assert.throws(() => f.toggle(enabled), /native MCP config/i);
    assert.deepEqual(fs.readFileSync(f.file), bad);
  }
});

test("Codex ENOENT initializes with 0600 and preserves unrelated TOML on disable", t => {
  const f = fixture(t, "codex");
  f.toggle(true);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(f.file, "utf8"), /\[mcp_servers\.safety-target\]/);
  f.toggle(false);
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /safety-target/);
});

test("sync preflight aborts all host writes on later malformed JSON", t => {
  const f = fixture(t, "claude"), codex = path.join(f.homeDir, ".codex", "config.toml");
  const original = 'model = "keep"\n';
  put(codex, original, 0o640);
  for (const bad of ["[]", "null", "{} trailing", '{"mcpServers":false}']) {
    put(f.file, bad);
    assert.throws(() => f.router.syncRouterToClis(), /native MCP config/i);
    assert.equal(fs.readFileSync(codex, "utf8"), original);
    assert.equal(fs.readFileSync(f.file, "utf8"), bad);
    assert.ok(!fs.existsSync(codex + ".t3hub.bak"));
  }
});

test("both backup variants must succeed, and unsafe backup destinations abort", t => {
  const f = fixture(t), original = '{"mcpServers":{"user-keep":{"command":"keep"}}}';
  put(f.file, original);
  put(f.file + ".t3hub.bak", original);
  fs.mkdirSync(f.file + ".bak-t3hub");
  assert.throws(() => f.toggle(true), /unsafe native MCP backup/);
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
});

test("I/O and stat errors cannot turn an existing native JSON into an empty config", t => {
  const f = fixture(t), original = '{"keep":"原配置"}';
  put(f.file, original, 0o640);
  for (const method of ["readFileSync", "statSync"]) {
    const orig = fs[method];
    fs[method] = function (file, ...args) {
      if (file === f.file) throw Object.assign(new Error("injected IO failure"), { code: "EIO" });
      return orig.call(this, file, ...args);
    };
    try {
      for (const enabled of [true, false]) assert.throws(() => f.toggle(enabled), /native MCP config.*EIO/);
      assert.throws(() => f.router.syncRouterToClis(), /native MCP config.*EIO/);
    } finally { fs[method] = orig; }
    assert.equal(fs.readFileSync(f.file, "utf8"), original);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  }
});

test("native temporary write failures preserve original bytes/mode and clean up temp files", t => {
  const f = fixture(t), original = '{"keep":true}';
  put(f.file, original, 0o640);
  const chmod = fs.fchmodSync;
  fs.fchmodSync = () => { throw new Error("injected chmod failure"); };
  try { assert.throws(() => f.toggle(true), /chmod failure/); }
  finally { fs.fchmodSync = chmod; }
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
  assert.ok(!fs.readdirSync(path.dirname(f.file)).some(name => name.includes(".tmp-")));
});

test("failed backup permission setup aborts overwrite and removes the incomplete backup", t => {
  const f = fixture(t), original = '{"keep":true}';
  put(f.file, original);
  const chmod = fs.chmodSync;
  fs.chmodSync = function (file, ...args) {
    if (file === f.file + ".t3hub.bak") throw new Error("injected backup chmod failure");
    return chmod.call(this, file, ...args);
  };
  try { assert.throws(() => f.toggle(true), /backup chmod failure/); }
  finally { fs.chmodSync = chmod; }
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  assert.ok(!fs.existsSync(f.file + ".t3hub.bak"));
  f.toggle(true);
  assert.equal(fs.readFileSync(f.file + ".t3hub.bak", "utf8"), original);
  assert.equal(fs.statSync(f.file + ".t3hub.bak").mode & 0o777, 0o600);
});

// Batch atomicity: toggle(all) and setServerAgents must use strict three-phase batch commit.
// If the 2nd host's backup fails, the 1st host must stay 100% untouched (no partial write).
for (const operation of ["toggle-all", "set-agents"]) test(`${operation}: backup failure on 2nd host leaves 1st host untouched`, t => {
  const f = fixture(t, "codex");
  const files = [
    ".t3/userdata/providers/antigravity/safety-instance/config/mcp_config.json",
    ".config/muse/settings.json",
    ".codex/config.toml",
    ".pi/agent/mcp.json",
    ".claude/mcp.json",
  ].map(relative => path.join(f.homeDir, relative));
  const originals = files.map((_, i) => i === 2 ? 'model = "keep"\n' : '{"keep":true}');
  files.forEach((file, i) => put(file, originals[i], 0o640));
  const firstFile = files[0];
  const secondFile = files[1];
  const origCopy = fs.copyFileSync;
  fs.copyFileSync = function (src, ...args) {
    if (src === secondFile) throw Object.assign(new Error("injected backup failure"), { code: "EACCES" });
    return origCopy.call(this, src, ...args);
  };
  try {
    const invoke = () => operation === "toggle-all" ?
      f.router.toggleServerForAgent({ name: "safety-target", agent: "all", enabled: true }) :
      f.router.setServerAgents({ name: "safety-target", agents: ["antigravity", "muse", "codex", "pi", "claude"] });
    assert.throws(invoke, /backup failure/);
  } finally { fs.copyFileSync = origCopy; }
  assert.equal(fs.readFileSync(firstFile, "utf8"), originals[0], "first host must be 100% untouched on 2nd host backup failure");
  assert.equal(fs.statSync(firstFile).mode & 0o777, 0o640, "first host mode must be preserved");
  files.forEach((file, i) => {
    assert.equal(fs.readFileSync(file, "utf8"), originals[i]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  });
});

function transactionFixture(t, { missingHosts = false, missingRegistry = false } = {}) {
  const f = fixture(t, "codex");
  const files = [
    ".t3/userdata/providers/antigravity/safety-instance/config/mcp_config.json",
    ".config/muse/settings.json", ".codex/config.toml", ".pi/agent/mcp.json", ".claude/mcp.json",
  ].map(relative => path.join(f.homeDir, relative));
  const originals = files.map((_, i) => i === 2 ? 'model = "keep"\n' : '{"keep":"原配置"}\n');
  fs.mkdirSync(path.dirname(files[0]), { recursive: true });
  if (!missingHosts) files.forEach((file, i) => put(file, originals[i], 0o640));
  // Discover a native-only definition from a source outside the writable hosts.
  put(path.join(f.homeDir, ".zcode/cli/mcp.json"), '{"mcpServers":{"safety-target":{"command":"node","args":["target.cjs"]}}}');
  const registryRaw = '[ { "name": "keep", "command": "keep" } ]\n';
  if (missingRegistry) fs.unlinkSync(f.router.registryPath);
  else put(f.router.registryPath, registryRaw, 0o640);
  const invoke = operation => operation === "set-agents" ?
    f.router.setServerAgents({ name: "safety-target", agents: ["antigravity", "muse", "codex", "pi", "claude"] }) :
    f.router.toggleServerForAgent({ name: "safety-target", agent: operation.replace("toggle-", ""), enabled: true });
  return { ...f, files, originals, registryRaw, invoke };
}

test("batch transaction reports every rollback failure and preserves the original write error", t => {
  const f = transactionFixture(t), rename = fs.renameSync;
  const originalError = Object.assign(new Error("injected later host write failure"), { code: "EIO" });
  const writes = new Map(), rollbackOrder = [];
  fs.renameSync = function (tmp, dest, ...args) {
    const attempt = (writes.get(dest) || 0) + 1;
    writes.set(dest, attempt);
    if (dest === f.files[3]) throw originalError;
    if (attempt === 2 && f.files.includes(dest)) {
      rollbackOrder.push(dest);
      if (dest !== f.files[1]) throw Object.assign(new Error("injected rollback denied: " + dest), { code: "EACCES" });
    }
    return rename.call(this, tmp, dest, ...args);
  };
  try {
    assert.throws(() => f.invoke("toggle-all"), err => {
      assert.match(err.message, /injected later host write failure/);
      assert.match(err.message, /rollback/i);
      assert.equal(err.rollbackFailures.length, 2);
      assert.deepEqual(err.unrolledTargets, [f.files[2], f.files[0]]);
      for (const failure of err.rollbackFailures) {
        assert.ok(err.message.includes(failure.file), "error message must identify the unrecovered path");
        assert.match(failure.error, /injected rollback denied/);
        assert.equal(failure.code, "EACCES");
      }
      assert.equal(err.cause, originalError);
      return true;
    });
  } finally { fs.renameSync = rename; }
  assert.deepEqual(rollbackOrder, [f.files[2], f.files[1], f.files[0]], "rollback continues after failures, in reverse order");
  assert.equal(fs.readFileSync(f.files[1], "utf8"), f.originals[1]);
  assert.equal(fs.readFileSync(f.router.registryPath, "utf8"), f.registryRaw);
});

for (const operation of ["toggle-muse", "toggle-codex", "toggle-all", "set-agents"]) {
  for (const missingHosts of [false, true]) for (const missingRegistry of [false, true]) {
    test(`${operation}: registry commit failure restores ${missingHosts ? "absent" : "existing"} hosts and ${missingRegistry ? "absent" : "existing"} registry`, t => {
      const f = transactionFixture(t, { missingHosts, missingRegistry }), rename = fs.renameSync;
      const committed = [], registryError = new Error("injected registry write failure");
      fs.renameSync = function (tmp, dest, ...args) {
        if (dest === f.router.registryPath) throw registryError;
        const result = rename.call(this, tmp, dest, ...args);
        if (f.files.includes(dest)) committed.push(dest);
        return result;
      };
      try { assert.throws(() => f.invoke(operation), /injected registry write failure/); }
      finally { fs.renameSync = rename; }
      const targets = operation === "toggle-muse" ? [f.files[1]] : operation === "toggle-codex" ? [f.files[2]] : f.files;
      for (const file of targets) assert.ok(committed.includes(file), "host commit must precede the registry failure");
      f.files.forEach((file, i) => {
        if (missingHosts) assert.ok(!fs.existsSync(file), "newly created host must be removed: " + file);
        else {
          assert.equal(fs.readFileSync(file, "utf8"), f.originals[i]);
          assert.equal(fs.statSync(file).mode & 0o777, 0o640);
        }
        if (fs.existsSync(path.dirname(file))) assert.ok(!fs.readdirSync(path.dirname(file)).some(name => name.includes(".tmp-")));
      });
      if (missingRegistry) assert.ok(!fs.existsSync(f.router.registryPath));
      else {
        assert.equal(fs.readFileSync(f.router.registryPath, "utf8"), f.registryRaw);
        assert.equal(fs.statSync(f.router.registryPath).mode & 0o777, 0o640);
      }
      assert.ok(!fs.readdirSync(path.dirname(f.router.registryPath)).some(name => name.includes(".tmp-")));
    });
  }

  test(`${operation}: unreadable or malformed registry aborts before host backups or writes`, t => {
    const f = transactionFixture(t);
    for (const raw of ['{"broken":', "null", "false", '[{"command":"missing-name"}]']) {
      put(f.router.registryPath, raw, 0o640);
      assert.throws(() => f.invoke(operation), /registry|MCP config/i);
      f.files.forEach((file, i) => {
        assert.equal(fs.readFileSync(file, "utf8"), f.originals[i]);
        assert.ok(!fs.existsSync(file + ".t3hub.bak"));
      });
      assert.equal(fs.readFileSync(f.router.registryPath, "utf8"), raw);
    }
    put(f.router.registryPath, f.registryRaw);
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (file === f.router.registryPath) throw Object.assign(new Error("injected registry EACCES"), { code: "EACCES" });
      return read.call(this, file, ...args);
    };
    try { assert.throws(() => f.invoke(operation), /registry|MCP config/i); }
    finally { fs.readFileSync = read; }
    f.files.forEach((file, i) => assert.equal(fs.readFileSync(file, "utf8"), f.originals[i]));
  });
}

test("registry failure uses the same rollback failure reporting as host write failures", t => {
  const f = transactionFixture(t), rename = fs.renameSync;
  let registryFailed = false;
  fs.renameSync = function (tmp, dest, ...args) {
    if (dest === f.router.registryPath) { registryFailed = true; throw new Error("injected registry write failure"); }
    if (registryFailed && dest === f.files[1]) throw new Error("injected host rollback failure");
    return rename.call(this, tmp, dest, ...args);
  };
  try {
    assert.throws(() => f.invoke("toggle-all"), err => {
      assert.match(err.message, /injected registry write failure/);
      assert.match(err.message, /injected host rollback failure/);
      assert.deepEqual(err.unrolledTargets, [f.files[1]]);
      assert.equal(err.rollbackFailures[0].file, f.files[1]);
      return true;
    });
  } finally { fs.renameSync = rename; }
  f.files.forEach((file, i) => { if (i !== 1) assert.equal(fs.readFileSync(file, "utf8"), f.originals[i]); });
});

// Batch atomicity: if the 2nd host's atomic write fails, the 1st host must be rolled back.
for (const operation of ["toggle-all", "set-agents"]) test(`${operation}: write failure on 2nd host rolls back 1st host`, t => {
  const f = fixture(t, "codex");
  const files = [
    ".t3/userdata/providers/antigravity/safety-instance/config/mcp_config.json",
    ".config/muse/settings.json",
    ".codex/config.toml",
    ".pi/agent/mcp.json",
    ".claude/mcp.json",
  ].map(relative => path.join(f.homeDir, relative));
  const originals = files.map((_, i) => i === 2 ? 'model = "keep"\n' : '{"keep":true}');
  files.forEach((file, i) => put(file, originals[i], 0o640));
  const firstFile = files[0];
  const secondFile = files[1];
  const origRename = fs.renameSync;
  fs.renameSync = function (tmp, dest, ...args) {
    if (dest === secondFile) throw Object.assign(new Error("injected write failure"), { code: "EACCES" });
    return origRename.call(this, tmp, dest, ...args);
  };
  try {
    const invoke = () => operation === "toggle-all" ?
      f.router.toggleServerForAgent({ name: "safety-target", agent: "all", enabled: true }) :
      f.router.setServerAgents({ name: "safety-target", agents: ["antigravity", "muse", "codex", "pi", "claude"] });
    assert.throws(invoke, /write failure/);
  } finally { fs.renameSync = origRename; }
  assert.equal(fs.readFileSync(firstFile, "utf8"), originals[0], "first host must be rolled back when 2nd host write fails");
  assert.equal(fs.statSync(firstFile).mode & 0o777, 0o640, "first host mode must be restored on rollback");
  files.forEach((file, i) => {
    assert.equal(fs.readFileSync(file, "utf8"), originals[i]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  });
});

test("a damaged registry cannot unlock exact conflict-disable writes", t => {
  const f = fixture(t, "codex");
  const museFile = path.join(f.homeDir, ".config/muse/settings.json");
  const codexFile = path.join(f.homeDir, ".codex/config.toml");
  const museRaw = JSON.stringify({ mcpServers: { echo_server: { command: "node", args: ["underscore.cjs"] } } }, null, 2) + "\n";
  const codexRaw = '[mcp_servers."echo-server"]\ncommand = "node"\nargs = ["hyphen.cjs"]\n';
  put(museFile, museRaw);
  put(codexFile, codexRaw);
  put(f.router.registryPath, '{"mcpServers":{"broken":null}}\n');

  assert.throws(
    () => f.router.toggleServerForAgent({ name: "echo_server", agent: "codex", enabled: false }),
    /registry|MCP config/i,
  );
  assert.equal(fs.readFileSync(museFile, "utf8"), museRaw);
  assert.equal(fs.readFileSync(codexFile, "utf8"), codexRaw);
  assert.ok(!fs.existsSync(museFile + ".t3hub.bak"));
  assert.ok(!fs.existsSync(codexFile + ".t3hub.bak"));
});

test("disable operations reject damaged or unreadable registry before touching host configs", t => {
  const f = fixture(t, "codex");
  const museFile = path.join(f.homeDir, ".config/muse/settings.json");
  const codexFile = path.join(f.homeDir, ".codex/config.toml");
  const museRaw = JSON.stringify({ mcpServers: { "safety-target": { command: "node", args: ["target.cjs"] } } }, null, 2) + "\n";
  const codexRaw = "model = \"keep\"\n[mcp_servers.safety-target]\ncommand = \"node\"\nenabled = true\n";
  put(museFile, museRaw, 0o640);
  put(codexFile, codexRaw, 0o640);
  const disableOps = [
    () => f.router.toggleServerForAgent({ name: "safety-target", agent: "muse", enabled: false }),
    () => f.router.toggleServerForAgent({ name: "safety-target", agent: "codex", enabled: false }),
    () => f.router.toggleServerForAgent({ name: "safety-target", agent: "all", enabled: false }),
    () => f.router.setServerAgents({ name: "safety-target", agents: [] }),
    () => f.router.setServerAgents({ name: "safety-target", agents: { muse: false, codex: false } }),
  ];
  for (const broken of ["{\"broken\":", "null", "[{\"command\":\"no-name\"}]", "{\"mcpServers\":{\"broken\":null}}", "{\"mcpServers\":{\"broken\":123}}", "{\"servers\":[null]}", "{\"unexpectedTop\":1}"]) {
    put(f.router.registryPath, broken, 0o640);
    for (const op of disableOps) {
      assert.throws(op, /registry|MCP config/i);
      assert.equal(fs.readFileSync(museFile, "utf8"), museRaw);
      assert.equal(fs.readFileSync(codexFile, "utf8"), codexRaw);
      assert.ok(!fs.existsSync(museFile + ".t3hub.bak"));
      assert.ok(!fs.existsSync(codexFile + ".t3hub.bak"));
    }
  }
  put(f.router.registryPath, "[{\"name\":\"keep\",\"command\":\"keep\"}]\n", 0o640);
  const origRead = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (file === f.router.registryPath) throw Object.assign(new Error("EACCES registry"), { code: "EACCES" });
    return origRead.call(this, file, ...args);
  };
  try {
    for (const op of disableOps) assert.throws(op, /registry|MCP config/i);
  } finally {
    fs.readFileSync = origRead;
  }
  assert.equal(fs.readFileSync(museFile, "utf8"), museRaw);
  assert.equal(fs.readFileSync(codexFile, "utf8"), codexRaw);
});

test("commit failure rollback removes newly created backups while keeping pre-existing and unrolled backups", t => {
  const f = transactionFixture(t);
  const preExistingHubBak = f.files[0] + ".t3hub.bak";
  put(preExistingHubBak, "{\"preExisting\":true}\n", 0o600);
  const origRename = fs.renameSync;
  fs.renameSync = function (tmp, dest, ...args) {
    if (dest === f.router.registryPath) throw new Error("injected registry commit failure");
    return origRename.call(this, tmp, dest, ...args);
  };
  try {
    assert.throws(() => f.invoke("toggle-all"), /injected registry commit failure/);
  } finally {
    fs.renameSync = origRename;
  }
  assert.equal(fs.readFileSync(preExistingHubBak, "utf8"), "{\"preExisting\":true}\n", "pre-existing backup kept");
  assert.ok(!fs.existsSync(f.files[0] + ".bak-t3hub"), "newly created .bak-t3hub cleaned");
  for (const file of [...f.files.slice(1), f.router.registryPath]) {
    assert.ok(!fs.existsSync(file + ".t3hub.bak"), "newly created .t3hub.bak cleaned: " + file);
    assert.ok(!fs.existsSync(file + ".bak-t3hub"), "newly created .bak-t3hub cleaned: " + file);
  }
});

test("commit failure reports backup cleanup errors when unlinking newly created backups fails", t => {
  const f = transactionFixture(t);
  const origRename = fs.renameSync;
  const origUnlink = fs.unlinkSync;
  const targetBak = f.files[0] + ".t3hub.bak";
  fs.renameSync = function (tmp, dest, ...args) {
    if (dest === f.router.registryPath) throw new Error("injected registry commit failure");
    return origRename.call(this, tmp, dest, ...args);
  };
  fs.unlinkSync = function (target, ...args) {
    if (target === targetBak) throw Object.assign(new Error("injected backup unlink EACCES"), { code: "EACCES" });
    return origUnlink.call(this, target, ...args);
  };
  try {
    assert.throws(() => f.invoke("toggle-all"), err => {
      assert.match(err.message, /injected registry commit failure/);
      assert.match(err.message, /backup cleanup failed/i);
      assert.ok(Array.isArray(err.backupCleanupFailures) && err.backupCleanupFailures.some(x => x.file === targetBak));
      return true;
    });
  } finally {
    fs.renameSync = origRename;
    fs.unlinkSync = origUnlink;
    try { fs.unlinkSync(targetBak); } catch {}
  }
});
