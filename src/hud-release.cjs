"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GENERATED_HEADERS = /^(?:\s*window\.(?:__t3HudReleaseVersion|__t3HubSidecarBridge|__t3HubDrawerEmbedded)\s*=[^\r\n]*(?:\r?\n|$))+/;
const VERSION_HEADER = /^\s*window\.__t3HudReleaseVersion\s*=\s*["']([^"'\r\n]+)["']\s*;?\s*$/m;
const DRAWER_START = ";/* __T3_HUB_DRAWER_EMBED_START__ */";
const DRAWER_END = "/* __T3_HUB_DRAWER_EMBED_END__ */";

function normalizeVersion(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.+-]+)?$/.test(version)
    ? version : null;
}

function stampedVersion(code) {
  const headers = code.match(GENERATED_HEADERS)?.[0];
  return normalizeVersion(headers?.match(VERSION_HEADER)?.[1]);
}

function readInstalledVersion(pluginDir) {
  const metadata = path.join(pluginDir, "hud-release.json");
  try {
    return normalizeVersion(JSON.parse(fs.readFileSync(metadata, "utf8"))?.version);
  } catch (error) {
    if (error.code !== "ENOENT") return null;
    try {
      // A dangling metadata symlink is an invalid existing entry.
      if (fs.lstatSync(metadata, { throwIfNoEntry: false })) return null;
    } catch { return null; }
  }

  // Compatibility with the stamped base (or surviving bundle) from v1.0.8.
  for (const name of ["renderer-base.js", "renderer-ui.js"]) {
    try {
      const version = stampedVersion(fs.readFileSync(path.join(pluginDir, name), "utf8"));
      if (version) return version;
    } catch {}
  }
  return null;
}

function bridgeHeader(bridge) {
  if (typeof bridge?.url !== "string" || typeof bridge.token !== "string" || !bridge.token.trim()) return "";
  try {
    const url = new URL(bridge.url);
    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) {
      return `window.__t3HubSidecarBridge = ${JSON.stringify({ url: url.origin, token: bridge.token })};\n`;
    }
  } catch {}
  return "";
}

function assembleRenderer(base, drawer, { version, bridge } = {}) {
  const releaseVersion = version === undefined ? stampedVersion(base) : normalizeVersion(version);
  let code = base.replace(GENERATED_HEADERS, "");
  // Older installations may only have the assembled bundle available as a base.
  const previousDrawer = code.lastIndexOf(`\n${DRAWER_START}\n`);
  if (previousDrawer !== -1 && code.trimEnd().endsWith(DRAWER_END)) code = code.slice(0, previousDrawer + 1);
  const release = releaseVersion ? `window.__t3HudReleaseVersion = ${JSON.stringify(releaseVersion)};\n` : "";
  return bridgeHeader(bridge) + "window.__t3HubDrawerEmbedded = true;\n" + release +
    code + (code.endsWith("\n") ? "" : "\n") + `${DRAWER_START}\n${drawer}\n${DRAWER_END}\n`;
}

module.exports = { assembleRenderer, readInstalledVersion };
