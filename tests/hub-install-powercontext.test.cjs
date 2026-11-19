"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const repo = path.join(__dirname, "..");
const macOnly = { skip: process.platform !== "darwin" };

function write(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

function fixture(t) {
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
  command ln "$@"
}
launchctl() { printf '%s\\n' "unexpected launchctl call" >&2; return 1; }
`);
  write(path.join(app, "Contents", "MacOS", "Fixture T3"), '#!/bin/sh\nexec "$T3_TEST_JS" "$@"\n', 0o700);
  const env = {
    HOME: profile, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    BASH_ENV: shellHook, T3_APP_PATH: app, T3_TEST_JS: process.execPath,
  };
  const plugin = path.join(profile, ".t3", "hud-plugin");
  return {
    profile, plugin,
    plist: path.join(profile, "Library", "LaunchAgents", "com.t3tools.powercontext-embed.plist"),
    sharedCli: path.join(profile, ".t3", "bin", "pc-lite.mjs"),
    hubCli: path.join(profile, ".t3", "hub", "bin", "pc-lite.mjs"),
    embedConfig: path.join(profile, ".t3", "hub", "embed-config.json"),
    run() {
      assert.equal(spawnSync("/bin/bash", ["-c", "command -v node"], { env }).status, 1);
      const run = spawnSync("/bin/bash", [path.join(repo, "install.sh"), "--lang", "en"], {
        cwd: repo, env, encoding: "utf8", timeout: 35000,
      });
      assert.equal(run.status, 0, run.stderr || run.stdout || String(run.error));
      assert.doesNotMatch(run.stderr, /unexpected launchctl call/);
      assert.match(run.stdout, /T3 Code HUD installed!/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(plugin, "config.json"), "utf8")).userLang, "en");
      assert.ok(fs.existsSync(path.join(profile, "Applications", "T3 Code HUD.app", "Contents", "MacOS", "T3 Code HUD")));
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
