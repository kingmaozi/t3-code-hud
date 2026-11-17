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
let vaultModuleLoaded = false;
function getVaultModule() {
  if (vaultModuleLoaded) return vaultMod;
  vaultModuleLoaded = true;
  for (const cand of [
    "../src/memory-vault.cjs",
    "../memory-vault.cjs",
    "../hud-plugin/memory-vault.cjs",
    path.join(process.env.HOME || os.homedir(), ".t3", "hud-plugin", "memory-vault.cjs"),
  ]) {
    try { vaultMod = require(cand); if (vaultMod) break; } catch {}
  }
  if (!vaultMod) throw new Error("Cannot locate memory-vault.cjs (run install.sh first)");
  return vaultMod;
}

function defaultAccessManager() {
  for (const cand of [
    "../src/hub-memory-access.cjs",
    "../hub-memory-access.cjs",
    "../hud-plugin/hub-memory-access.cjs",
    path.join(process.env.HOME || os.homedir(), ".t3", "hud-plugin", "hub-memory-access.cjs"),
  ]) {
    try { return require(cand).createMemoryAccessManager(); }
    catch (error) { if (error?.code !== "MODULE_NOT_FOUND") throw error; }
  }
  return null;
}

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

function agentWriteTags(raw) {
  const tags = toTags(raw);
  if (tags.some((tag) => ["pinned", "core"].includes(String(tag).trim().toLowerCase()))) {
    throw new Error("reserved tags pinned/core are human-only and cannot be assigned by Agent writes");
  }
  return tags;
}

function canonicalRoot(root) {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}
function insidePath(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function forbiddenProjectRoot(root) {
  const home = canonicalRoot(process.env.HOME || os.homedir());
  if (root === home) return true;
  const denied = [
    path.join(home, ".t3"), path.join(home, ".codex"), path.join(home, ".agents"),
    path.join(home, ".config"), path.join(home, "Applications"),
    "/Applications", "/System/Applications", "/System/Library", process.env.T3CODE_HOME,
  ].filter(Boolean).map(canonicalRoot);
  return denied.some((base) => insidePath(base, root));
}
function gitRepositoryContext(root) {
  let current = canonicalRoot(root);
  while (true) {
    const dotGit = path.join(current, ".git");
    try {
      const stat = fs.lstatSync(dotGit);
      let common = dotGit;
      if (stat.isFile()) {
        const match = fs.readFileSync(dotGit, "utf8").trim().match(/^gitdir:\s*(.+)$/i);
        if (!match) return null;
        const gitDir = path.resolve(current, match[1]);
        if (!fs.statSync(gitDir).isDirectory()) return null;
        try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim()); }
        catch { common = gitDir; }
      } else if (!stat.isDirectory()) return null;
      return { repositoryId: canonicalRoot(common), repositoryRoot: current, relativePath: path.relative(current, canonicalRoot(root)) };
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function hasProjectMarker(root) {
  for (const name of [".git", "AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "Gemfile", "composer.json", "requirements.txt", ".project"]) {
    try {
      const stat = fs.lstatSync(path.join(root, name));
      if (name === ".git" || stat.isFile() || stat.isDirectory()) return true;
    } catch {}
  }
  return false;
}
function projectContext(root, { requireMarker = false } = {}) {
  const canonical = canonicalRoot(root);
  try { if (!fs.statSync(canonical).isDirectory()) return null; } catch { return null; }
  if (forbiddenProjectRoot(canonical)) return null;
  if (requireMarker && !hasProjectMarker(canonical)) return null;
  // A linked checkout root is ambiguous without T3's thread/project mapping:
  // its path may be a worktree for a different subproject in the same repo.
  if (requireMarker) {
    try { if (fs.lstatSync(path.join(canonical, ".git")).isFile()) return null; } catch {}
  }
  const git = gitRepositoryContext(canonical);
  return { root: canonical, ...(git || {}) };
}
function resolveCliProjectRoot(requestedRoot, cwd) {
  const current = projectContext(cwd, { requireMarker: true });
  if (!current) throw new Error("project context required: run this command from the selected project");
  if (requestedRoot == null || requestedRoot === "") return current.root;
  const requested = path.isAbsolute(requestedRoot) ? requestedRoot : path.resolve(cwd, requestedRoot);
  const selected = projectContext(requested);
  if (!selected) throw new Error("--root is not a valid project directory");
  const samePath = current.root === selected.root;
  const sameLinkedProject = Boolean(current.repositoryId && selected.repositoryId && current.repositoryId === selected.repositoryId && current.relativePath === selected.relativePath);
  if (!samePath && !sameLinkedProject) throw new Error("--root does not match the selected project context");
  return current.root;
}
function scopedAgentWrite(kind, tags, requestedScope) {
  const scope = requestedScope == null || requestedScope === "" ? "" : String(requestedScope).toLowerCase();
  if (scope && !["shared", "worktree"].includes(scope)) throw new Error("global or invalid memory scope is unavailable");
  if (scope) return scope;
  const k = String(kind || "").trim().toLowerCase();
  const tagSet = Array.isArray(tags) ? tags.map((tag) => String(tag).trim().toLowerCase()) : [];
  return ["progress", "wip", "scratch"].includes(k) || tagSet.includes("wip") || tagSet.includes("worktree") ? "worktree" : "shared";
}
function boundedLimit(value, fallback = 6) {
  const parsed = Number(value);
  return Math.min(20, Math.max(1, Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback));
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
  return getVaultModule().createMemoryVault(opts);
}

export async function main(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = path.resolve(options.cwd || process.cwd());
  const stdout = options.stdout ?? ((s) => process.stdout.write(s));
  const stderr = options.stderr ?? ((s) => process.stderr.write(s));
  try {
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
      stdout("用法：node pc-lite.mjs <ensure | recall --query \"...\" | search --query \"...\" | experience ... | rule ... | write ... | consolidate [--dry-run]>\n");
      stdout("flags: --root <projectRoot> --scope shared|worktree --scope-filter auto|shared|worktree|all --vault-dir <dir> --home-dir <dir> --query ... --kind ... --text ... --module ... --title ... --content ... --supersedes <id>\n");
      return 0;
    }
    const { subcommand, flags } = parseCliArgs(argv);
    const access = options.accessManager || defaultAccessManager();
    if (!access || !access.isAccessEnabled()) throw new Error("T3 Hub Memory agent access is disabled or unavailable");
    const projectRoot = resolveCliProjectRoot(flags.root || flags.project ? String(flags.root || flags.project) : undefined, cwd);
    const vault = options.vault || buildVault(flags);
    const scopeFilter = flags["scope-filter"] == null ? undefined : String(flags["scope-filter"]).toLowerCase();
    if (scopeFilter && !["auto", "shared", "worktree", "all"].includes(scopeFilter)) throw new Error("global or invalid memory scopeFilter is unavailable");
    const queryScope = flags.scope == null ? undefined : String(flags.scope).toLowerCase();
    if (queryScope && !["shared", "worktree"].includes(queryScope)) throw new Error("global or invalid memory scope is unavailable");
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
      const limit = boundedLimit(flags.limit);
      const module = flags.module ? String(flags.module) : "all";
      const query = flags.query != null ? String(flags.query) : "";
      const res = vault.listMemories({ projectRoot, query, module, includeGlobal: false, limit, scope: queryScope, scopeFilter });
      if (!res.ok) throw new Error(res.error || "recall failed");
      const slug = res.projectSlug || vault.slugFromProjectRoot?.(projectRoot) || "";
      stdout(`Vault slug=${res.projectSlug || slug} root=${projectRoot} hits=${res.items.length}\n`);
      for (const it of res.items) {
        const fullContent = String(it.content || "");
        const wasTruncated = fullContent.length > 1000;
        const content = fullContent.slice(0, 1000);
        stdout(`## ${it.title} [${it.module}/${it.kind}] [id=${it.id || "unknown"}${wasTruncated ? ", truncated" : ""}]\n${content}${wasTruncated ? "…" : ""}\n\n`);
      }
      return 0;
    }
    if (subcommand === "rule") {
      const kind = String(flags.kind || "constraint");
      const text = flags.text != null ? String(flags.text) : "";
      if (!text.trim()) throw new Error("缺少必填字段 text");
      const description = flags.description ? String(flags.description) : "";
      const title = description.trim() ? description.trim() : truncate(text, 80);
      const tags = agentWriteTags(flags.tags);
      const res = vault.saveMemory({
        projectRoot,
        kind,
        scope: scopedAgentWrite(kind, tags, flags.scope),
        title,
        content: text,
        agent: flags.agent ? String(flags.agent) : "user",
        tags,
        supersedesId: flags.supersedes ? String(flags.supersedes) : undefined,
        rejectProtectedSupersedes: true,
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
      const tags = agentWriteTags(flags.tags);
      const parts = [];
      if (situation) parts.push("情境：" + situation);
      if (action) parts.push("动作：" + action);
      if (outcome) parts.push("结果：" + outcome);
      if (lesson) parts.push("经验：" + lesson);
      const res = vault.saveMemory({
        projectRoot,
        module: "pitfalls",
        kind: "experience",
        scope: scopedAgentWrite("experience", tags, flags.scope),
        title,
        content: parts.join("\n\n"),
        agent: flags.agent ? String(flags.agent) : "user",
        tags,
        supersedesId: flags.supersedes ? String(flags.supersedes) : undefined,
        rejectProtectedSupersedes: true,
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
      const tags = agentWriteTags(flags.tags);
      const res = vault.saveMemory({
        projectRoot,
        module,
        kind,
        scope: scopedAgentWrite(kind, tags, flags.scope),
        title: title.trim(),
        content,
        agent: flags.agent ? String(flags.agent) : "user",
        tags,
        supersedesId: flags.supersedes ? String(flags.supersedes) : undefined,
        rejectProtectedSupersedes: true,
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
