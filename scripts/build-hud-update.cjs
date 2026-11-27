#!/usr/bin/env node
"use strict";

// Two-step hot-update release sequence for older v1.1.5 updaters:
// 1. Publish a 4-file transition bundle first (`--transition` / `--core-only`)
//    so the baseline v1.1.5 validator can upgrade `hub-update.cjs` safely.
// 2. Publish subsequent higher versions with the default full bundle (which
//    also carries optional hot modules like `hub-drawer-ui.js` and `hud-config.cjs`).
// Users who skip the transition version can upgrade via `bash ./install.sh`.

const fs = require("node:fs");
const path = require("node:path");
const { createBundle, sha256 } = require("../src/hub-update.cjs");

const USAGE = [
  "Usage:",
  "  node scripts/build-hud-update.cjs <output-file>",
  "  node scripts/build-hud-update.cjs --transition <output-file>",
  "  node scripts/build-hud-update.cjs --core-only <output-file>",
  "",
  "Two-step release order: ship a 4-file --transition release first so v1.1.5",
  "updaters accept the expanded validator, then ship full bundles on later",
  "versions. Users skipping the transition release can run: bash ./install.sh",
].join("\n");

const args = process.argv.slice(2);
let transition = false;
const positional = [];
let invalidFlag = null;
for (const arg of args) {
  if (arg === "--transition" || arg === "--core-only") {
    transition = true;
  } else if (arg.startsWith("-")) {
    invalidFlag = arg;
    break;
  } else {
    positional.push(arg);
  }
}

const output = positional.length === 1 ? positional[0] : null;
if (invalidFlag || !output) {
  if (invalidFlag) console.error(`Unknown option: ${invalidFlag}`);
  console.error(USAGE);
  process.exitCode = 1;
} else {
  const bundle = createBundle(path.join(__dirname, ".."), { includeOptional: !transition });
  const bytes = Buffer.from(JSON.stringify(bundle) + "\n");
  fs.writeFileSync(output, bytes, { flag: "wx" });
  const mode = transition ? "transition-4" : `full-${Object.keys(bundle.files).length}`;
  console.log(`v${bundle.version} ${bytes.length} bytes (${mode}) sha256:${sha256(bytes)}`);
}
