#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const homeDir = process.env.HOME || os.homedir();
const sourceDir = path.dirname(fileURLToPath(import.meta.url));

function locateAccessModule() {
  const candidates = [
    path.join(sourceDir, "..", "src", "hub-memory-access.cjs"),
    path.join(sourceDir, "hub-memory-access.cjs"),
    path.join(sourceDir, "..", "hud-plugin", "hub-memory-access.cjs"),
    path.join(homeDir, ".t3", "hud-plugin", "hub-memory-access.cjs"),
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) { if (error?.code !== "MODULE_NOT_FOUND") throw error; }
  }
  throw new Error("Hub Memory access module is not installed");
}

function printJson(stdout, value) {
  stdout(JSON.stringify(value) + "\n");
}

export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? ((text) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    stdout("用法：t3-memory-setup <status | setup | enable | disable>\n");
    return 0;
  }
  if (argv.length !== 1 || !["status", "setup", "enable", "disable"].includes(argv[0])) {
    stderr("用法：t3-memory-setup <status | setup | enable | disable>\n");
    return 2;
  }
  try {
    const manager = options.manager || locateAccessModule().createMemoryAccessManager();
    const command = argv[0];
    const result = command === "status" ? manager.getAgentAccess()
      : command === "setup" ? manager.setup()
        : manager.setAgentAccess({ enabled: command === "enable" });
    printJson(stdout, result);
    return result?.ok === false ? 1 : 0;
  } catch {
    printJson(stdout, { ok: false, state: "unknown", error: "memory_access_unavailable" });
    return 1;
  }
}

if (process.argv[1]) {
  try {
    if (fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
      main().then((code) => process.exit(code));
    }
  } catch {}
}
