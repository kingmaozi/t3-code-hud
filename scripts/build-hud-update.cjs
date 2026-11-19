#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createBundle, sha256 } = require("../src/hub-update.cjs");

const output = process.argv[2];
if (!output) {
  console.error("Usage: node scripts/build-hud-update.cjs <output-file>");
  process.exitCode = 1;
} else {
  const bundle = createBundle(path.join(__dirname, ".."));
  const bytes = Buffer.from(JSON.stringify(bundle) + "\n");
  fs.writeFileSync(output, bytes, { flag: "wx" });
  console.log(`v${bundle.version} ${bytes.length} bytes sha256:${sha256(bytes)}`);
}
