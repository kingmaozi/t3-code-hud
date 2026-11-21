"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

test("artifact dock avoids mid-click DOM resets, collapses on outside click, and supports persisted vertical dragging", () => {
  const src = fs.readFileSync(path.join(repoRoot, "src/hub-drawer-ui.js"), "utf8");
  assert.match(src, /if \(nextSig === artifactDockSig\)/, "renderArtifactDock must short-circuit when signature is unchanged");
  assert.match(src, /state\.artifactDockOpen && artifactDock && !artifactDock\.contains\(event\.target\)/, "outside pointerdown must collapse expanded artifact dock");
  assert.match(src, /t3-hub-artifact-dock-top-v1/, "artifact dock vertical position must persist in storage");
  assert.match(src, /function startArtifactDockDrag\(/);
  assert.match(src, /function moveArtifactDockDrag\(/);
  assert.match(src, /function endArtifactDockDrag\(/);
  assert.match(src, /function applyArtifactDockPosition\(/);
  assert.match(src, /data-dock-drag="1"/, "handle and header must expose drag target");
  assert.match(src, /Date\.now\(\) < dockSuppressClickUntil/, "drag release must suppress accidental toggle click");
});

test("renderer projection and live context match acpRegistry_devin with acpRegistry", () => {
  const src = fs.readFileSync(path.join(repoRoot, "src/renderer-ui.js"), "utf8");
  assert.match(src, /normalizeProjDriver/, "projection payload must normalize acpRegistry provider instance");
  assert.match(src, /driversMatch/, "projection payload must match acpRegistry with acpRegistry_*");
  assert.match(src, /rawLiveCtxDrv === "acpregistry"/, "live context window matcher must not drop acpRegistry_devin");
});

test("install.sh bundles every Hub runtime module", () => {
  const installer = fs.readFileSync(path.join(repoRoot, "install.sh"), "utf8");
  for (const mod of [
    "hub-memory-access.cjs",
    "hub-memory-connections.cjs",
    "hub-provider-resources.cjs",
    "hub-devin-quota.cjs",
    "hub-artifact-access.cjs",
    "update-guardian.cjs",
    "hub-drawer-ui.js",
  ]) {
    assert.ok(installer.includes(mod), `install.sh must copy ${mod}`);
  }
});
