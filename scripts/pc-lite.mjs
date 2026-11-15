#!/usr/bin/env node
// T3 Hub local memory CLI (zero-dependency, <30ms, no :17429 / omlx needed).
// Drop-in replacement for ~/.agents/skills/powercontext-memory/scripts/pc.mjs
// backed by src/memory-vault.cjs. Categories:
//   ensure
//   recall --query "..."
//   search --query "..." [--module ...] [--limit N]
//   rule --kind constraint --text "..." [--description "..."]
//   experience --cue ... --symptom ... --situation ... --action ... --outcome ... --condition ... --lesson ...
//   write --module ... --kind ... --title ... --content ... (aliases: --text for content)
//   write / rule / experience ... --supersedes <id>
//   consolidate [--dry-run]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let vaultMod = null;
for (const cand of [
  "../src/memory-vault.cjs",
  "../memory-vault.cjs",
  "../hud-plugin/memory-vault.cjs",
  path.join(process.env.HOME || os.homedir(), ".t3", "hud-plugin", "memory-vault.cjs"),
]) {
  try { vaultMod = require(cand); if (vaultMod) break; } catch {}
}
if (!vaultMod) throw new Error("Cannot locate memory-vault.cjs (run install.sh first)");
const { createMemoryVault } = vaultMod;

function parseCliArgs(argv) {
  const [subcommand, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) throw new Error(`未识别的参数：${token}`);
    const key = token.slice(2);
    if (!key) throw new Error(`未识别的参数：${token}`);
    // Boolean-style flags like --force without a value.
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      if (key === "force" || key === "dry-run") {
        flags[key] = "true";
        continue;
      }
      throw new Error(`参数 --${key} 缺少对应值`);
    }
    flags[key] = next;
    i += 1;
  }
  return { subcommand, flags };
}

function toTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function truncate(s, n) {
  const x = String(s || "").trim();
  return x.length > n ? x.slice(0, n) : x;
}

function buildVault(flags) {
  const homeDir = flags["home-dir"] || process.env.HOME || os.homedir();
  const opts = { homeDir };
  if (flags["vault-dir"]) opts.vaultDir = String(flags["vault-dir"]);
  if (flags["hub-dir"]) opts.hubDir = String(flags["hub-dir"]);
  if (flags["embed-url"]) opts.embeddingUrl = String(flags["embed-url"]);
  else if (process.env.T3_EMBED_URL) opts.embeddingUrl = process.env.T3_EMBED_URL;
  return createMemoryVault(opts);
}

export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? ((s) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s) => process.stderr.write(s));
  try {
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
      stdout("用法：node pc-lite.mjs <ensure | recall --query \"...\" | search --query \"...\" | experience ... | rule ... | write ... | consolidate [--dry-run]>\n");
      stdout("flags: --root <projectRoot> --vault-dir <dir> --home-dir <dir> --query ... --kind ... --text ... --module ... --title ... --content ... --supersedes <id>\n");
      return 0;
    }
    const { subcommand, flags } = parseCliArgs(argv);
    const projectRoot = (flags.root || flags.project) ? path.resolve(String(flags.root || flags.project)) : process.cwd();
    const vault = options.vault || buildVault(flags);
    if (subcommand === "consolidate") {
      const res = vault.consolidateMemories({ projectRoot, dryRun: flags["dry-run"] === "true" });
      if (!res.ok) throw new Error(res.error || "consolidate failed");
      stdout(JSON.stringify(res, null, 2) + "\n");
      return 0;
    }
    if (subcommand === "ensure") {
      const res = vault.ensureProject({ projectRoot });
      if (!res.ok) throw new Error(res.error || "ensure failed");
      stdout(`Vault slug=${res.slug} root=${projectRoot} created=${res.created}\n`);
      return 0;
    }
    if (subcommand === "recall" || subcommand === "search") {
      const limit = flags.limit ? Number(flags.limit) || 50 : 50;
      const module = flags.module ? String(flags.module) : "all";
      const query = flags.query != null ? String(flags.query) : "";
      const res = vault.listMemories({ projectRoot, query, module, includeGlobal: true, limit });
      if (!res.ok) throw new Error(res.error || "recall failed");
      const slug = res.projectSlug || vault.slugFromProjectRoot?.(projectRoot) || "";
      stdout(`Vault slug=${res.projectSlug || slug} root=${projectRoot} hits=${res.items.length}\n`);
      for (const it of res.items) {
        stdout(`## ${it.title} [${it.module}/${it.kind}]\n${it.content}\n\n`);
      }
      return 0;
    }
    if (subcommand === "rule") {
      const kind = String(flags.kind || "constraint");
      const text = flags.text != null ? String(flags.text) : "";
      if (!text.trim()) throw new Error("缺少必填字段 text");
      const description = flags.description ? String(flags.description) : "";
      const title = description.trim() ? description.trim() : truncate(text, 80);
      const res = vault.saveMemory({
        projectRoot,
        kind,
        title,
        content: text,
        agent: flags.agent ? String(flags.agent) : "user",
        tags: toTags(flags.tags),
        supersedesId: flags.supersedes ? String(flags.supersedes) : undefined,
      });
      if (!res.ok) throw new Error(res.error || "rule failed");
      stdout(`Vault rule slug=${res.item.projectSlug} id=${res.item.id} created=${!res.deduplicated}\n`);
      return 0;
    }
    if (subcommand === "experience") {
      const situation0 = String(flags.situation || "").trim();
      const action = String(flags.action || "").trim();
      const outcome0 = String(flags.outcome || "").trim();
      const lesson = String(flags.lesson || "").trim();
      if (!situation0) throw new Error("缺少必填字段 situation");
      if (!action) throw new Error("缺少必填字段 action");
      if (!outcome0) throw new Error("缺少必填字段 outcome");
      if (!lesson) throw new Error("缺少必填字段 lesson");
      let situation = situation0;
      if (flags.cue) {
        const cue = String(flags.cue).trim();
        const symptom = flags.symptom ? String(flags.symptom).trim() : "";
        const prefix = symptom ? `【触发线索：${cue}｜症状：${symptom}】` : `【触发线索：${cue}】`;
        situation = prefix + situation0;
      }
      let outcome = outcome0;
      if (flags.condition) {
        outcome = outcome0 + `（验收核对：${String(flags.condition).trim()}）`;
      }
      const title = truncate(lesson, 80) || truncate(situation, 80);
      const parts = [];
      if (situation) parts.push("情境：" + situation);
      if (action) parts.push("动作：" + action);
      if (outcome) parts.push("结果：" + outcome);
      if (lesson) parts.push("经验：" + lesson);
      const res = vault.saveMemory({
        projectRoot,
        module: "pitfalls",
        kind: "experience",
        title,
        content: parts.join("\n\n"),
        agent: flags.agent ? String(flags.agent) : "user",
        tags: toTags(flags.tags),
        supersedesId: flags.supersedes ? String(flags.supersedes) : undefined,
      });
      if (!res.ok) throw new Error(res.error || "experience failed");
      stdout(`Vault experience slug=${res.item.projectSlug} id=${res.item.id} created=${!res.deduplicated}\n`);
      return 0;
    }
    if (subcommand === "write") {
      const content = flags.content != null ? String(flags.content) : flags.text != null ? String(flags.text) : "";
      let title = flags.title ? String(flags.title) : "";
      if (!content.trim()) throw new Error("缺少必填字段 content");
      if (!title.trim()) title = truncate(content.split("\n")[0], 80);
      const module = flags.module ? String(flags.module) : undefined;
      const kind = flags.kind ? String(flags.kind) : undefined;
      const res = vault.saveMemory({
        projectRoot,
        module,
        kind,
        title: title.trim(),
        content,
        agent: flags.agent ? String(flags.agent) : "user",
        tags: toTags(flags.tags),
        supersedesId: flags.supersedes ? String(flags.supersedes) : undefined,
      });
      if (!res.ok) throw new Error(res.error || "write failed");
      stdout(`Vault write slug=${res.item.projectSlug} id=${res.item.id} created=${!res.deduplicated}\n`);
      return 0;
    }
    throw new Error('用法：node pc-lite.mjs <ensure | recall --query "..." | search --query "..." | experience ... | rule ... | write ... | consolidate [--dry-run]>');
  } catch (err) {
    stderr(`${(err && err.message) || String(err)}\n`);
    return 1;
  }
}

if (typeof process !== "undefined" && process.argv && process.argv[1]) {
  try {
    const entry = fs.realpathSync(process.argv[1]);
    const self = fs.realpathSync(new URL(import.meta.url).pathname ?? "");
    if (entry === self || path.basename(entry) === "pc-lite.mjs" || path.basename(entry) === "pc.mjs") {
      main().then((code) => process.exit(code));
    }
  } catch {
    main().then((code) => process.exit(code)).catch(() => process.exit(1));
  }
}
