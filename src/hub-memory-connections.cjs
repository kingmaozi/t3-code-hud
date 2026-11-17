"use strict";

// Read-only status of the actual T3 memory entry points. A file in place is
// configuration evidence only; it does not prove that a running chat loaded it.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readTomlTable } = require("./hub-host-settings.cjs");

const AGENTS = [
  { id: "t3", label: "T3" },
  { id: "codex", label: "Codex" },
  { id: "muse", label: "Muse" },
  { id: "agy", label: "AGY" },
  { id: "claude", label: "Claude" },
  { id: "pi", label: "Pi" },
];
const ALLOWED = new Set(["configured", "missing", "unsupported", "unknown"]);
const memorySkill = "powercontext-memory";
const memoryHook = "memory-stop-hook";

function status(value, summary, evidence = []) {
  return {
    status: ALLOWED.has(value) ? value : "unknown",
    summary: String(summary || "无法读取状态").slice(0, 160),
    evidence: evidence.filter((item) => typeof item === "string").map((item) => item.slice(0, 96)).slice(0, 4),
  };
}

function createMemoryConnections({ homeDir = process.env.HOME || os.homedir() } = {}) {
  const home = path.resolve(homeDir);
  const safeRoot = (root) => {
    try {
      const canonical = fs.realpathSync(root);
      return fs.statSync(canonical).isDirectory() ? canonical : null;
    } catch { return null; }
  };
  const homeRoot = safeRoot(home);

  function readAt(root, relative, parser) {
    if (!root || typeof relative !== "string" || path.isAbsolute(relative)) return { state: "unknown", evidence: [] };
    const parts = relative.split(/[\\/]+/).filter(Boolean);
    if (!parts.length || parts.some((part) => part === "." || part === "..")) return { state: "unknown", evidence: [] };
    let current = root;
    try {
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink()) return { state: "unknown", evidence: [] };
        if (index < parts.length - 1 && !st.isDirectory()) return { state: "unknown", evidence: [] };
        if (index === parts.length - 1) {
          if (!st.isFile() || !(st.mode & 0o444) || st.size > 2 * 1024 * 1024) return { state: "unknown", evidence: [] };
          const text = fs.readFileSync(current, "utf8");
          return { state: parser(text) ? "configured" : "missing", evidence: [relative] };
        }
      }
    } catch (error) {
      if (error.code === "ENOENT") return { state: "missing", evidence: [] };
      return { state: "unknown", evidence: [] };
    }
    return { state: "unknown", evidence: [] };
  }

  function memoryRouterEntry(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid MCP entry");
    if (entry.enabled === false || entry.disabled === true) return false;
    if (entry.disabled != null && typeof entry.disabled !== "boolean") throw new Error("invalid disabled flag");
    if (entry.enabled != null && typeof entry.enabled !== "boolean") throw new Error("invalid enabled flag");
    const command = typeof entry.command === "string" ? entry.command : "";
    const args = Array.isArray(entry.args) && entry.args.every((item) => typeof item === "string") ? entry.args : [];
    if (entry.args != null && (!Array.isArray(entry.args) || !entry.args.every((item) => typeof item === "string"))) throw new Error("invalid MCP args");
    const executable = command.replace(/\\/g, "/").split("/").at(-1);
    if (executable === "t3-mcp-router") return true;
    if (/^(?:node|nodejs)(?:\.exe)?$/i.test(executable) && args[0]?.replace(/\\/g, "/").split("/").at(-1) === "t3-mcp-router") return true;
    throw new Error("Hub MCP entry is not verifiably the T3 router");
  }
  function jsonMemoryMcp(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid MCP config");
    if (data.mcpServers != null && (!data.mcpServers || typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers))) throw new Error("invalid mcpServers");
    if (data.servers != null && (!data.servers || typeof data.servers !== "object" || Array.isArray(data.servers))) throw new Error("invalid servers");
    const servers = data.mcpServers || data.servers || {};
    const key = Object.keys(servers).find((name) => name === "t3_hub" || name === "t3-hub");
    return key ? memoryRouterEntry(servers[key]) : false;
  }
  function codexMemoryMcp(text) {
    const keys = ["command", "args", "enabled", "disabled"];
    const entry = readTomlTable(text, ["mcp_servers", "t3_hub"], keys)
      || readTomlTable(text, ["mcp_servers", "t3-hub"], keys);
    if (!entry) return false;
    return memoryRouterEntry(entry);
  }

  function hooksHaveMemory(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid Hook config");
    if (data.hooks == null) return false;
    if (!data.hooks || typeof data.hooks !== "object" || Array.isArray(data.hooks)) throw new Error("invalid hooks object");
    for (const groups of Object.values(data.hooks)) {
      if (!Array.isArray(groups)) throw new Error("invalid Hook event");
      for (const group of groups) {
        if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("invalid Hook group");
        if (group.hooks != null && !Array.isArray(group.hooks)) throw new Error("invalid Hook handlers");
        for (const handler of group.hooks || []) {
          if (handler && typeof handler === "object" && typeof handler.command === "string" && handler.command.includes(memoryHook)) return true;
        }
      }
    }
    return false;
  }
  function skillIsMemory(text) {
    if (typeof text !== "string" || !/^---\r?\n/.test(text)) throw new Error("invalid Skill frontmatter");
    const end = text.match(/^---\r?\n[\s\S]*?^---\s*$/m);
    if (!end) throw new Error("invalid Skill frontmatter");
    const head = end[0];
    if (!new RegExp(`^name:\\s*["']?${memorySkill}["']?\\s*$`, "m").test(head)) return false;
    const body = text.slice(end[0].length);
    return /\bmemory_search\b/.test(body) && /\bmemory_write\b/.test(body);
  }

  function combine(results, summaries) {
    if (results.some((item) => item.state === "configured")) {
      return status("configured", summaries.configured, results.find((item) => item.state === "configured").evidence);
    }
    if (results.some((item) => item.state === "unknown")) return status("unknown", summaries.unknown);
    return status("missing", summaries.missing);
  }
  function checkFiles(root, paths, parser, prefix = "") {
    return paths.map((relative) => {
      const result = readAt(root, relative, parser);
      return { ...result, evidence: result.evidence.map((item) => prefix + item) };
    });
  }
  function listSafeDirs(root, relative) {
    if (!root) return { state: "unknown", dirs: [] };
    const parts = relative.split(/[\\/]+/).filter(Boolean);
    if (!parts.length || parts.some((part) => part === "." || part === "..")) return { state: "unknown", dirs: [] };
    let current = root;
    try {
      for (const part of parts) {
        current = path.join(current, part);
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink() || !st.isDirectory()) return { state: "unknown", dirs: [] };
      }
      const entries = fs.readdirSync(current, { withFileTypes: true })
        .filter((entry) => ![".DS_Store", ".localized"].includes(entry.name) && !entry.name.startsWith("skills-archived"));
      const hasSymlink = entries.some((entry) => entry.isSymbolicLink());
      return { state: hasSymlink ? "unknown" : "ok", dirs: entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name) };
    } catch (error) {
      return error.code === "ENOENT" ? { state: "missing", dirs: [] } : { state: "unknown", dirs: [] };
    }
  }
  function agyMcp() {
    const rootRel = ".t3/userdata/providers/antigravity";
    if (!homeRoot) return { state: "unknown", evidence: [] };
    // Enumerate only known provider profiles; names are never returned.
    const listing = listSafeDirs(homeRoot, rootRel);
    if (listing.state === "missing") return { state: "missing", evidence: [] };
    if (listing.state === "unknown") return { state: "unknown", evidence: [] };
    if (!listing.dirs.length) return { state: "missing", evidence: [] };
    const instances = { total: listing.dirs.length, configured: 0, missing: 0, unknown: 0 };
    for (const name of listing.dirs) {
      const result = readAt(homeRoot, path.join(rootRel, name, "config/mcp_config.json"), jsonMemoryMcp);
      instances[result.state === "configured" ? "configured" : result.state === "missing" ? "missing" : "unknown"] += 1;
    }
    return {
      state: instances.configured === instances.total ? "configured" : instances.configured || instances.unknown ? "unknown" : "missing",
      evidence: instances.configured ? [".t3/userdata/providers/antigravity/*/config/mcp_config.json"] : [],
      instances,
    };
  }
  function skillCandidates(agent, root) {
    const shared = ".agents/skills/powercontext-memory/SKILL.md";
    const paths = [{ relative: shared, evidence: shared }];
    if (agent === "claude") paths.unshift({ relative: ".claude/skills/powercontext-memory/SKILL.md", evidence: ".claude/skills/powercontext-memory/SKILL.md" });
    if (agent === "agy" && root === homeRoot) {
      const listing = listSafeDirs(homeRoot, ".t3/userdata/providers/antigravity");
      if (listing.state === "unknown") paths.push({ relative: ".invalid-antigravity-skills", evidence: ".t3/userdata/providers/antigravity/*/config/skills/powercontext-memory/SKILL.md" });
      for (const name of listing.dirs) paths.push({
        relative: path.join(".t3/userdata/providers/antigravity", name, "config/skills/powercontext-memory/SKILL.md"),
        evidence: ".t3/userdata/providers/antigravity/*/config/skills/powercontext-memory/SKILL.md",
      });
    }
    return paths;
  }

  function getConnections({ projectRoot = null } = {}) {
    let project = null, projectInvalid = false;
    if (projectRoot != null) {
      if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) projectInvalid = true;
      else {
        project = safeRoot(projectRoot);
        if (!project) projectInvalid = true;
      }
    }
    const agents = AGENTS.map(({ id, label }) => {
      let mcp;
      if (id === "t3") mcp = status("unknown", "没有可读证据确认当前 T3 会话已加载记忆 MCP");
      else if (id === "agy") mcp = (() => {
        const result = agyMcp();
        const summary = result.instances?.total
          ? `本机实例 ${result.instances.configured} / ${result.instances.total} 已配置记忆 MCP${result.state === "unknown" ? "；部分缺失或无法确认" : ""}`
          : result.state === "missing" ? "未找到 T3 Hub 记忆 MCP 配置" : "AGY MCP 配置无法安全确认";
        return { ...status(result.state, summary, result.evidence), ...(result.instances ? { instances: result.instances } : {}) };
      })();
      else {
        const globals = {
          codex: [".codex/config.toml"],
          muse: [".config/muse/settings.json"],
          claude: [".claude/mcp.json", ".claude.json"],
          pi: [".pi/agent/mcp.json"],
        }[id] || [];
        const projects = project ? ({
          codex: [".codex/config.toml"],
          claude: [".mcp.json"],
          pi: [".pi/agent/mcp.json"],
        }[id] || []) : [];
        const results = [...checkFiles(homeRoot, globals, id === "codex" ? codexMemoryMcp : jsonMemoryMcp), ...checkFiles(project, projects, id === "codex" ? codexMemoryMcp : jsonMemoryMcp, "project:")];
        mcp = combine(results, {
          configured: "找到指向 T3 Hub 的记忆 MCP 配置",
          missing: "未找到 T3 Hub 记忆 MCP 配置",
          unknown: "MCP 配置无法安全确认",
        });
      }

      const skillRoots = [{ root: homeRoot, prefix: "" }, ...(project ? [{ root: project, prefix: "project:" }] : [])];
      let skills = [];
      for (const item of skillRoots) {
        for (const candidate of skillCandidates(id, item.root)) {
          skills.push({ ...readAt(item.root, candidate.relative, skillIsMemory), evidence: [item.prefix + candidate.evidence] });
        }
      }
      const skill = combine(skills, {
        configured: "找到 powercontext-memory 技能入口",
        missing: "未找到 powercontext-memory 技能入口",
        unknown: "记忆技能文件无法安全读取或解析",
      });

      let hook;
      if (!["codex", "claude"].includes(id)) {
        hook = status("unsupported", "当前 Hub 记忆 Hook 不支持此宿主；记忆读写不依赖 Hook");
      } else {
        const globals = id === "codex" ? [".codex/hooks.json"] : [".claude/settings.json"];
        const projects = project ? (id === "codex" ? [".codex/hooks.json"] : [".claude/settings.local.json"]) : [];
        const results = [...checkFiles(homeRoot, globals, hooksHaveMemory), ...checkFiles(project, projects, hooksHaveMemory, "project:")];
        hook = combine(results, {
          configured: "找到 memory-stop-guard 记忆 Hook 配置",
          missing: "未找到记忆 Hook 配置",
          unknown: "Hook 配置无法安全确认",
        });
      }

      return {
        id,
        label,
        mcp,
        skill,
        hook,
        runtime: { status: "unverified", summary: "本地配置不能证明当前会话已加载或运行时可调用", evidence: [] },
      };
    });
    const notes = [
      "configured 仅表示找到与 T3 Memory Vault 对应的配置入口，不代表当前会话已加载；运行时状态需要在新会话中核验。",
      "技能只匹配 powercontext-memory；路由技能不算记忆技能。Hook 只匹配 memory-stop-guard；它不是记忆读写的前置条件。",
    ];
    if (projectInvalid) notes.push("projectRoot 无效或不可读取；本次仅检查全局配置。");
    return { ok: true, checkedAt: new Date().toISOString(), agents, notes };
  }

  return { getConnections };
}

function getMemoryConnections(args = {}, options = {}) {
  return createMemoryConnections(options).getConnections(args || {});
}

module.exports = { createMemoryConnections, getMemoryConnections, AGENTS };
