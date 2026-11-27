"use strict";

const assert = require("node:assert/strict");
const { execFile, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { promisify } = require("node:util");
const vm = require("node:vm");
const { assembleRenderer, readInstalledVersion } = require("../src/hud-release.cjs");
const { version } = require("../package.json");

const repo = path.join(__dirname, "..");
const macOnly = { skip: process.platform !== "darwin" };
const runShell = promisify(execFile);
const installArgs = [path.join(repo, "install.sh"), "--lang", "en"];

function write(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

function fixture(t, { tmpDir, failLauncher = false, checkInstallLock = false } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3-hud-install-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profile = path.join(directory, "profile");
  const app = path.join(directory, "Fixture T3.app");
  const shellHook = path.join(directory, "bash-env");
  // Redirect the optional terminal symlink into the fixture and forbid launchd calls.
  write(shellHook, `ln() {
  case "$3" in
    /opt/homebrew/bin/t3-hud|/usr/local/bin/t3-hud)
      mkdir -p "$HOME/.local/bin"
      set -- "$1" "$2" "$HOME/.local/bin/t3-hud"
      ;;
  esac
  if [[ "$T3_TEST_CHECK_INSTALL_LOCK" == 1 ]]; then
    local owner
    for owner in "$HOME/.t3/hud-install.lock"/owner-"$$".*; do
      [[ -f "$owner" ]] || return 93
    done
    sleep 0.3
  fi
  command ln "$@"
}
launchctl() { printf '%s\\n' "unexpected launchctl call" >&2; return 1; }
clang() {
  local launcher_src
  for launcher_src; do :; done
  printf '%s\\n' "$launcher_src" >> "$HOME/compiler-sources"
  command clang "$@"
}
chmod() {
  if [[ "$T3_TEST_FAIL_LAUNCHER" == 1 && "$2" == "$HOME/Applications/T3 Code HUD.app/Contents/MacOS/T3 Code HUD" ]]; then return 22; fi
  command chmod "$@"
}
ps() {
  if [[ -n "\${T3_TEST_APP_PID:-}" ]]; then
    printf '%s %s\\n' "$T3_TEST_APP_PID" "$T3_APP_PATH/Contents/MacOS/Fixture T3"
  else
    command ps "$@"
  fi
}
`);
  write(path.join(app, "Contents", "MacOS", "Fixture T3"), '#!/bin/sh\nexec "$T3_TEST_JS" "$@"\n', 0o700);
  const env = {
    HOME: profile, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    BASH_ENV: shellHook, T3_APP_PATH: app, T3_TEST_JS: process.execPath,
    T3_TEST_FAIL_LAUNCHER: String(Number(failLauncher)),
    T3_TEST_CHECK_INSTALL_LOCK: String(Number(checkInstallLock)),
  };
  if (tmpDir) env.TMPDIR = tmpDir;
  const plugin = path.join(profile, ".t3", "hud-plugin");
  const installOptions = { cwd: repo, env, encoding: "utf8", timeout: 35000 };
  function checkInstalled({ stdout, stderr }) {
    assert.doesNotMatch(stderr, /unexpected launchctl call/);
    assert.match(stdout, /T3 Code HUD installed!/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, "config.json"), "utf8")).userLang, "en");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, "hud-release.json"), "utf8")), { version });
    assert.equal(readInstalledVersion(plugin), version);
    assert.ok(fs.existsSync(path.join(profile, "Applications", "T3 Code HUD.app", "Contents", "MacOS", "T3 Code HUD")));
  }
  return {
    profile, plugin, env,
    plist: path.join(profile, "Library", "LaunchAgents", "com.t3tools.powercontext-embed.plist"),
    sharedCli: path.join(profile, ".t3", "bin", "pc-lite.mjs"),
    hubCli: path.join(profile, ".t3", "hub", "bin", "pc-lite.mjs"),
    embedConfig: path.join(profile, ".t3", "hub", "embed-config.json"),
    run() {
      assert.equal(spawnSync("/bin/bash", ["-c", "command -v node"], { env }).status, 1);
      const run = spawnSync("/bin/bash", installArgs, installOptions);
      assert.equal(run.status, 0, run.stderr || run.stdout || String(run.error));
      checkInstalled(run);
    },
    async runAsync() {
      checkInstalled(await runShell("/bin/bash", installArgs, installOptions));
    },
  };
}

function job(server) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.t3tools.powercontext-embed</string>
<key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>${server}</string></array>
<key>KeepAlive</key><true/><key>RunAtLoad</key><true/>
<key>EnvironmentVariables</key><dict><key>EMBED_MODEL</key><string>independent/model</string></dict>
</dict></plist>
`;
}

test("HUD install keeps an independent PowerContext job, CLI link, skill and MCP unchanged", macOnly, (t) => {
  const f = fixture(t);
  const standalone = path.join(f.profile, "powercontext");
  const cli = path.join(standalone, "pc-lite.mjs");
  const privateDb = path.join(standalone, "memory.db");
  const skill = path.join(f.profile, ".agents", "skills", "powercontext-memory", "SKILL.md");
  const mcpConfig = path.join(f.profile, ".config", "muse", "settings.json");
  const existing = [
    [f.plist, job(path.join(standalone, "server.py"))],
    [cli, "independent CLI"],
    [privateDb, "independent memory"],
    [skill, "independent skill"],
    [mcpConfig, JSON.stringify({ mcpServers: { powercontext: { command: cli, args: ["mcp"] } } })],
  ];
  for (const [file, text] of existing) write(file, text);
  write(f.embedConfig, '{"mode":"mlx","modelId":"hud/embedding"}');
  fs.mkdirSync(path.dirname(f.sharedCli), { recursive: true });
  fs.symlinkSync(cli, f.sharedCli);

  f.run();
  for (const [file, text] of existing) assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.equal(fs.readlinkSync(f.sharedCli), cli);
  assert.deepEqual(fs.readFileSync(f.hubCli), fs.readFileSync(path.join(repo, "scripts", "pc-lite.mjs")));

  fs.unlinkSync(f.sharedCli);
  write(f.sharedCli, "independent command without a symlink");
  f.run();
  assert.equal(fs.readFileSync(f.sharedCli, "utf8"), "independent command without a symlink");
});

test("fresh HUD install creates its own CLI and skill without adopting a PowerContext venv", macOnly, (t) => {
  const f = fixture(t);
  write(path.join(f.profile, "powercontext-embed-eg2", ".venv", "bin", "python"), "#!/bin/sh\nexit 1\n", 0o700);
  f.run();
  assert.equal(fs.existsSync(f.plist), false);
  assert.equal(fs.existsSync(path.join(f.profile, ".t3", "hub", "memory-access.json")), false);
  assert.deepEqual(fs.readFileSync(f.sharedCli), fs.readFileSync(f.hubCli));
  const installedSkill = path.join(f.profile, ".agents", "skills", "powercontext-memory", "SKILL.md");
  assert.match(fs.readFileSync(installedSkill, "utf8"), /~\/\.t3\/hub\/bin\/pc-lite\.mjs/);
});

test("HUD upgrades its own job and known CLI while respecting zero-memory mode", macOnly, (t) => {
  const f = fixture(t);
  write(f.plist, job(path.join(f.plugin, "embed-server.py")));
  write(f.embedConfig, '{"mode":"fts5-zero-ram"}');
  write(f.sharedCli, "previous Hub script");
  write(path.join(f.plugin, "scripts", "pc-lite.mjs"), "previous Hub script");
  f.run();
  const plist = fs.readFileSync(f.plist, "utf8");
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.deepEqual(fs.readFileSync(f.sharedCli), fs.readFileSync(f.hubCli));
});

test("parallel macOS installs use separate launcher sources and clean up on success and failure", macOnly, async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3 hud shared temp "));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const first = fixture(t, { tmpDir });
  const second = fixture(t, { tmpDir });
  await Promise.all([first.runAsync(), second.runAsync()]);

  const failed = fixture(t, { tmpDir, failLauncher: true });
  await assert.rejects(failed.runAsync(), (error) => error.code === 22);
  const sources = [first, second, failed].map(({ profile }) => {
    const lines = fs.readFileSync(path.join(profile, "compiler-sources"), "utf8").trim().split("\n");
    assert.equal(new Set(lines).size, 1);
    assert.equal(path.dirname(path.dirname(lines[0])), tmpDir);
    assert.equal(path.basename(lines[0]), "launcher.c");
    return lines[0];
  });
  assert.equal(new Set(sources).size, sources.length);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  for (const { plugin } of [first, second, failed]) {
    assert.equal(fs.readdirSync(plugin).some((name) => name.startsWith(".t3-hud-renderer.")), false);
    assert.equal(fs.existsSync(path.join(path.dirname(plugin), "hud-install.lock")), false);
  }
});

test("parallel installs wait for the same user directory and replace a crashed installer lock", macOnly, async (t) => {
  const f = fixture(t, { checkInstallLock: true });
  const lock = path.join(f.profile, ".t3", "hud-install.lock");
  write(path.join(lock, "owner-999999999.ABC123"), "");
  await Promise.all([f.runAsync(), f.runAsync()]);
  assert.equal(fs.existsSync(lock), false);
  const lines = fs.readFileSync(path.join(f.profile, "compiler-sources"), "utf8").trim().split("\n");
  assert.equal(new Set(lines).size, 2);
  assert.ok(lines.every((source) => !fs.existsSync(path.dirname(source))));
});

test("installer preserves all HUD files when its updater is active or needs recovery", macOnly, async (t) => {
  const f = fixture(t);
  const run = path.join(f.plugin, "run");
  const installerLock = path.join(f.profile, ".t3", "hud-install.lock");
  const owner = path.join(run, "hud-update.lock", `owner-${process.pid}-4af73cfa-7841-465b-9b6f-39b02a2667a0`);
  const pinnedRenderer = path.join(f.plugin, "renderer-ui.js");
  write(owner, "");
  write(pinnedRenderer, "previous renderer");
  await assert.rejects(f.runAsync(), (error) => error.code === 1 && /A HUD update is running/.test(error.stderr));
  assert.equal(fs.existsSync(owner), true);
  assert.equal(fs.existsSync(installerLock), false);
  assert.equal(fs.readFileSync(pinnedRenderer, "utf8"), "previous renderer");

  fs.unlinkSync(owner);
  const pending = path.join(run, "hud-update-pending.json");
  write(pending, "previous recovery data");
  await assert.rejects(f.runAsync(), (error) => error.code === 1 && /interrupted HUD update needs recovery/.test(error.stderr));
  assert.equal(fs.readFileSync(pending, "utf8"), "previous recovery data");
  assert.equal(fs.existsSync(installerLock), false);
  assert.equal(fs.readFileSync(pinnedRenderer, "utf8"), "previous renderer");
  assert.equal(fs.existsSync(path.join(f.profile, ".t3", "bin")), false);
});

test("reload preserves release metadata after copying the raw renderer base", macOnly, async (t) => {
  const f = fixture(t);
  f.run();
  const bundle = path.join(f.plugin, "renderer-ui.js");
  const installed = fs.readFileSync(bundle, "utf8");
  assert.equal((installed.match(/^window\.__t3HudReleaseVersion = /gm) ?? []).length, 1);
  assert.ok(installed.includes(`window.__t3HudReleaseVersion = ${JSON.stringify(version)};`));
  assert.ok(installed.includes("__T3_HUB_DRAWER_EMBED_START__"));
  const rawBase = path.join(repo, "src", "renderer-ui.js");
  fs.copyFileSync(rawBase, path.join(f.plugin, "renderer-base.js"));
  // The installed metadata must be enough even with an unstamped prior bundle.
  fs.copyFileSync(rawBase, bundle);

  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push([request.method, request.url, request.headers["x-t3-hud-token"]]);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true,"results":[{"injected":true}]}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const run = path.join(f.plugin, "run");
  write(path.join(run, `rpc-${process.pid}.json`), JSON.stringify({ pid: process.pid, url, adminToken: "admin-fixture" }));
  write(path.join(run, "hub-bridge.json"), JSON.stringify({ pid: process.pid, watchPid: process.pid, url, token: "bridge-fixture" }));
  const { stdout } = await runShell("/bin/bash", [path.join(f.profile, ".t3", "bin", "t3-hud"), "reload"], {
    env: { ...f.env, T3_TEST_APP_PID: String(process.pid) }, timeout: 10000,
  });
  assert.match(stdout, /"injected":true/);
  assert.deepEqual(requests, [
    ["POST", "/reload", "bridge-fixture"],
    ["POST", "/admin/reload-ui", "admin-fixture"],
  ]);
  assert.equal(fs.readFileSync(bundle, "utf8"), assembleRenderer(
    fs.readFileSync(rawBase, "utf8"), fs.readFileSync(path.join(f.plugin, "hub-drawer-ui.js"), "utf8"),
    { version, bridge: { url, token: "bridge-fixture" } },
  ));
  assert.equal(fs.statSync(bundle).mode & 0o777, 0o600);
});

test("release detection recognizes legacy stamps only without installed metadata", (t) => {
  const { plugin } = fixture(t);
  const base = path.join(plugin, "renderer-base.js");
  const bundle = path.join(plugin, "renderer-ui.js");
  const metadata = path.join(plugin, "hud-release.json");
  write(base, 'window.__t3HudReleaseVersion = "1.0.8";\n');
  assert.equal(readInstalledVersion(plugin), "1.0.8");
  write(base, "window.baseRan = true;\n");
  assert.equal(readInstalledVersion(plugin), null);
  write(bundle, 'window.__t3HubDrawerEmbedded = true;\nwindow.__t3HudReleaseVersion = "1.0.8";\n');
  assert.equal(readInstalledVersion(plugin), "1.0.8");
  write(metadata, JSON.stringify({ version }));
  assert.equal(readInstalledVersion(plugin), version);
  write(metadata, '{"version":"bogus"}');
  assert.equal(readInstalledVersion(plugin), null);
  fs.unlinkSync(metadata);
  fs.symlinkSync("missing.json", metadata);
  assert.equal(readInstalledVersion(plugin), null);
});

test("renderer assembly replaces old headers and drawer while omitting an invalid bridge or unknown version", () => {
  const old = assembleRenderer("window.baseRan = true;", "window.oldDrawer = true;", {
    version: "1.0.8", bridge: { url: "http://127.0.0.1:5151", token: "old" },
  });
  const code = assembleRenderer(old, "window.drawers = (window.drawers || 0) + 1;", {
    version: "1.0.9-rc.1", bridge: { url: "http://remote.invalid", token: "invalid" },
  });
  const window = {};
  vm.runInNewContext(code, { window });
  assert.deepEqual(window, {
    __t3HudReleaseVersion: "1.0.9-rc.1", __t3HubDrawerEmbedded: true, baseRan: true, drawers: 1,
  });
  assert.equal((code.match(/^window\.__t3HudReleaseVersion = /gm) ?? []).length, 1);
  assert.equal((code.match(/__T3_HUB_DRAWER_EMBED_START__/g) ?? []).length, 1);
  assert.doesNotMatch(assembleRenderer(old, "", { version: null }), /^window\.__t3HudReleaseVersion = /m);
});
