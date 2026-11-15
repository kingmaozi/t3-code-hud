#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/kingmaozi/t3-code-hud.git"
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

TMP_CLONE=""
cleanup() {
  if [[ -n "$TMP_CLONE" && -d "$TMP_CLONE" ]]; then
    rm -rf "$TMP_CLONE"
  fi
}
trap cleanup EXIT

if [[ -z "$SCRIPT_DIR" || ! -d "$SCRIPT_DIR/src" ]]; then
  echo "[t3-hud] 正在拉取最新 t3-code-hud 仓库..."
  TMP_CLONE="$(mktemp -d)"
  git clone --depth 1 "$REPO_URL" "$TMP_CLONE"
  SCRIPT_DIR="$TMP_CLONE"
fi

DEST_DIR="$HOME/.t3/hud-plugin"
BIN_DIR="$HOME/.t3/bin"
RUN_DIR="$DEST_DIR/run"
CONFIG_FILE="$DEST_DIR/config.json"
mkdir -p "$BIN_DIR"

if [[ -L "$DEST_DIR" ]]; then
  rm -f "$DEST_DIR"
fi
mkdir -p "$DEST_DIR"

cp "$SCRIPT_DIR/src/backend.cjs" \
   "$SCRIPT_DIR/src/main-hook.cjs" \
   "$SCRIPT_DIR/src/preload-bridge.cjs" \
   "$SCRIPT_DIR/src/bootstrap.cjs" \
   "$SCRIPT_DIR/src/renderer-ui.js" \
   "$DEST_DIR/"

cp "$SCRIPT_DIR/bin/t3-hud" "$BIN_DIR/t3-hud"
chmod +x "$BIN_DIR/t3-hud"

if [[ -d "/opt/homebrew/bin" && -w "/opt/homebrew/bin" ]]; then
  ln -sf "$BIN_DIR/t3-hud" "/opt/homebrew/bin/t3-hud"
elif [[ -d "/usr/local/bin" && -w "/usr/local/bin" ]]; then
  ln -sf "$BIN_DIR/t3-hud" "/usr/local/bin/t3-hud"
else
  mkdir -p "$HOME/.local/bin"
  ln -sf "$BIN_DIR/t3-hud" "$HOME/.local/bin/t3-hud"
fi

# Create macOS Spotlight / Dock Launcher App ("~/Applications/T3 Code HUD.app")
APP_WRAPPER="$HOME/Applications/T3 Code HUD.app"
mkdir -p "$APP_WRAPPER/Contents/MacOS" "$APP_WRAPPER/Contents/Resources"

LAUNCHER_BIN="$APP_WRAPPER/Contents/MacOS/T3 Code HUD"
if command -v clang >/dev/null 2>&1; then
  LAUNCHER_SRC="$(mktemp /tmp/t3-hud-launcher.XXXXXX.c)"
  cat > "$LAUNCHER_SRC" <<'EOF'
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  const char *home = getenv("HOME");
  if (!home || !home[0]) home = "/Users";
  char bin[4096];
  snprintf(bin, sizeof(bin), "%s/.t3/bin/t3-hud", home);
  char *args[] = { "t3-hud", "start", (char *)0 };
  execv(bin, args);
  return 1;
}
EOF
  if clang -arch arm64 -arch x86_64 -O2 -o "$LAUNCHER_BIN" "$LAUNCHER_SRC" >/dev/null 2>&1; then
    : # universal Mach-O launcher ready
  elif clang -O2 -o "$LAUNCHER_BIN" "$LAUNCHER_SRC" >/dev/null 2>&1; then
    : # single-arch fallback ready
  else
    cat > "$LAUNCHER_BIN" <<'EOF2'
#!/usr/bin/env bash
exec "$HOME/.t3/bin/t3-hud" start
EOF2
  fi
  rm -f "$LAUNCHER_SRC"
else
  cat > "$LAUNCHER_BIN" <<'EOF'
#!/usr/bin/env bash
exec "$HOME/.t3/bin/t3-hud" start
EOF
fi
chmod +x "$LAUNCHER_BIN"
cat > "$APP_WRAPPER/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>T3 Code HUD</string>
  <key>CFBundleIdentifier</key>
  <string>com.kingmaozi.t3code.hud</string>
  <key>CFBundleName</key>
  <string>T3 Code HUD</string>
  <key>CFBundleDisplayName</key>
  <string>T3 Code HUD</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF

for candidate in "/Applications/T3 Code (Beta).app" "/Applications/T3 Code.app" "$HOME/Applications/T3 Code (Beta).app" "$HOME/Applications/T3 Code.app"; do
  if [[ -f "$candidate/Contents/Resources/icon.icns" ]]; then
    cp "$candidate/Contents/Resources/icon.icns" "$APP_WRAPPER/Contents/Resources/icon.icns" 2>/dev/null || true
    break
  fi
done

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_WRAPPER" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------------------
# Language detection: --lang en|zh | T3_HUD_LANG | auto-detect system locale
# ---------------------------------------------------------------------------
INSTALL_LANG=""
LANG_ARG=""
for arg in "$@"; do
  case "$arg" in
    --lang)
      # next arg is the value (handled below)
      ;;
    --lang=*) LANG_ARG="${arg#--lang=}" ;;
  esac
done
# Capture --lang <val> form
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--lang" ]]; then
    LANG_ARG="$arg"
  fi
  prev="$arg"
done
if [[ -n "${T3_HUD_LANG:-}" && -z "$LANG_ARG" ]]; then
  LANG_ARG="$T3_HUD_LANG"
fi

detect_locale_lang() {
  local lc=""
  for v in "${LC_ALL:-}" "${LC_MESSAGES:-}" "${LANG:-}"; do
    if [[ -n "$v" ]]; then lc="$v"; break; fi
  done
  # macOS primary language: AppleLanguages prints multiline plist, e.g.
  #   (
  #       "zh-Hans-CN",
  #       "en-CN"
  #   )
  # Strip punctuation to extract the first language token.
  local apple_lang=""
  if command -v defaults >/dev/null 2>&1; then
    apple_lang="$(defaults read -g AppleLanguages 2>/dev/null | tr -d '()", \t' | grep -v '^$' | head -n 1 || true)"
  fi
  # Explicit locale wins, but a Chinese Mac reports LANG=en_US.UTF-8 in
  # Terminal, so AppleLanguages is checked before generic en LANG.
  if [[ "$lc" == zh* ]]; then
    echo "zh"
    return 0
  fi
  if [[ "$lc" == en* && "$apple_lang" != zh* ]]; then
    echo "en"
    return 0
  fi
  if [[ "$apple_lang" == zh* ]]; then
    echo "zh"
    return 0
  fi
  if [[ "$apple_lang" == en* ]]; then
    echo "en"
    return 0
  fi
  # If nothing conclusive, default zh
  echo "zh"
}

if [[ -n "$LANG_ARG" ]]; then
  if [[ "$LANG_ARG" == "zh" || "$LANG_ARG" == "en" ]]; then
    INSTALL_LANG="$LANG_ARG"
  else
    INSTALL_LANG="zh"
  fi
else
  INSTALL_LANG="$(detect_locale_lang)"
fi

mkdir -p "$DEST_DIR"
JS_RUNNER=""
for cand in "${T3_APP_PATH:-}" "/Applications/T3 Code (Beta).app" "/Applications/T3 Code.app" "/Applications/T3 Code (Nightly).app" "$HOME/Applications/T3 Code (Beta).app" "$HOME/Applications/T3 Code.app" "$HOME/Applications/T3 Code (Nightly).app"; do
  if [[ -n "$cand" && -d "$cand/Contents/MacOS" ]]; then
    T3_CAND_BIN="$(find "$cand/Contents/MacOS" -maxdepth 1 -type f -perm +111 | head -n 1)"
    if [[ -n "$T3_CAND_BIN" && -x "$T3_CAND_BIN" ]]; then
      JS_RUNNER="$T3_CAND_BIN"
      break
    fi
  fi
done
if [[ -z "$JS_RUNNER" ]] && command -v node >/dev/null 2>&1; then
  JS_RUNNER="$(command -v node)"
fi

if [[ -n "$JS_RUNNER" && -x "$JS_RUNNER" ]]; then
  ELECTRON_RUN_AS_NODE=1 "$JS_RUNNER" -e '
    const fs = require("node:fs");
    const [cfgFile, defLang, explicitLang] = process.argv.slice(1);
    let d = {};
    try { d = JSON.parse(fs.readFileSync(cfgFile, "utf8")) || {}; } catch {}
    d.defaultLang = defLang;
    if (explicitLang === "zh" || explicitLang === "en") {
      d.userLang = explicitLang;
      d.langUpdatedAt = Date.now();
    }
    fs.writeFileSync(cfgFile, JSON.stringify(d, null, 2) + "\n", { mode: 0o600 });
  ' "$CONFIG_FILE" "$INSTALL_LANG" "$LANG_ARG"
elif [[ ! -f "$CONFIG_FILE" ]]; then
  if [[ "$LANG_ARG" == "zh" || "$LANG_ARG" == "en" ]]; then
    printf '{"defaultLang":"%s","userLang":"%s","langUpdatedAt":%s000}\n' "$INSTALL_LANG" "$LANG_ARG" "$(date +%s)" > "$CONFIG_FILE"
  else
    printf '{"defaultLang":"%s"}\n' "$INSTALL_LANG" > "$CONFIG_FILE"
  fi
  chmod 0600 "$CONFIG_FILE" 2>/dev/null || true
fi

# Private runtime directory
if [[ -L "$RUN_DIR" ]]; then
  rm -f "$RUN_DIR"
fi
mkdir -p "$RUN_DIR"
chmod 0700 "$RUN_DIR" 2>/dev/null || true

echo ""
if [[ "$INSTALL_LANG" == "zh" ]]; then
  echo "✅ T3 Code HUD 安装完成！(简体中文)"
  echo "   • 插件目录: $DEST_DIR"
  echo "   • 命令行工具: $BIN_DIR/t3-hud"
  echo "   • 桌面启动器: $APP_WRAPPER (可拖入 Dock 栏或用 Spotlight 启动)"
  echo "   • 语言配置: $CONFIG_FILE ({\"defaultLang\":\"zh\"})"
  echo ""
  echo "🚀 启用提示: 运行 't3-hud restart' (或 '~/.t3/bin/t3-hud restart') 即可生效！"
else
  echo "✅ T3 Code HUD installed! (English)"
  echo "   • Plugin dir: $DEST_DIR"
  echo "   • CLI tool: $BIN_DIR/t3-hud"
  echo "   • Launcher: $APP_WRAPPER (drag to Dock or launch via Spotlight)"
  echo "   • Language config: $CONFIG_FILE ({\"defaultLang\":\"en\"})"
  echo ""
  echo "🚀 Next step: run 't3-hud restart' (or '~/.t3/bin/t3-hud restart') to enable!"
fi
