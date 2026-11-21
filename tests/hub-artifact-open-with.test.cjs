"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createArtifactAccess } = require("../src/hub-artifact-access.cjs");

test("open-default opens normal documents directly and degrades executable scripts safely", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "t3-art-openwith-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const session = path.join(home, ".gemini", "antigravity", "brain", "thread-9");
  fs.mkdirSync(session, { recursive: true });
  const project = path.join(home, "proj");
  fs.mkdirSync(project, { recursive: true });

  const report = path.join(session, "report.pdf");
  const script = path.join(session, "deploy.sh");
  fs.writeFileSync(report, "%PDF-1.4");
  fs.writeFileSync(script, "#!/bin/sh\necho hi\n", { mode: 0o755 });

  const board = {
    verifyArtifactScope: (q) => ({ ok: q.projectRoot === project && q.threadId === "thread-9" }),
    getBoardSnapshot: () => ({ artifacts: [{ name: "report.pdf", path: report }, { name: "deploy.sh", path: script }] }),
  };

  const calls = [];
  const fakeAppsDir = path.join(home, "Applications", "MyEditor.app");
  fs.mkdirSync(fakeAppsDir, { recursive: true });

  const access = createArtifactAccess({
    homeDir: home,
    board,
    open: async (mode, target, pinned) => { calls.push({ mode, target, appPath: pinned?.appPath || null }); },
    listApps: async () => [{ name: "Preview", path: "/System/Applications/Preview.app", isDefault: true }],
    chooseApp: async () => fakeAppsDir,
  });

  const base = { projectRoot: project, threadId: "thread-9" };

  // 1. Normal PDF opens directly via open-default
  const r1 = await access({ ...base, path: report, operation: "open-default" });
  assert.equal(r1.kind, "opened");
  assert.equal(calls[calls.length - 1].mode, "open-default");

  // 2. Shell script MUST NOT execute via open-default (safe-degraded)
  const r2 = await access({ ...base, path: script, operation: "open-default" });
  assert.equal(r2.kind, "safe-degraded");
  assert.equal(r2.reason, "executable_guard");
  assert.notEqual(calls[calls.length - 1].mode, "open-default");

  // 3. list-apps returns app list + executable flag
  const r3 = await access({ ...base, path: script, operation: "list-apps" });
  assert.equal(r3.kind, "apps");
  assert.equal(r3.isExecutable, true);
  assert.equal(r3.apps.length, 1);

  // 4. open-with validates trusted app directory & supports interactive chooser
  const r4 = await access({ ...base, path: report, operation: "open-with", appPath: fakeAppsDir });
  assert.equal(r4.kind, "opened-with");
  assert.equal(r4.appName, "MyEditor");
  assert.equal(calls[calls.length - 1].mode, "open-with");
  assert.equal(calls[calls.length - 1].appPath, fakeAppsDir);

  const r5 = await access({ ...base, path: report, operation: "open-with", chooseApp: true });
  assert.equal(r5.kind, "opened-with");

  // 5. Rejects untrusted app path outside Applications
  await assert.rejects(
    access({ ...base, path: report, operation: "open-with", appPath: "/tmp/Evil.app" }),
    /不在可信应用目录/
  );
});
