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

cat > "$APP_WRAPPER/Contents/MacOS/T3 Code HUD" <<'EOF'
#!/usr/bin/env bash
exec "$HOME/.t3/bin/t3-hud" start
EOF
chmod +x "$APP_WRAPPER/Contents/MacOS/T3 Code HUD"

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

echo ""
echo "✅ T3 Code HUD 安装完成！"
echo "   • 插件目录: $DEST_DIR"
echo "   • 命令行工具: $BIN_DIR/t3-hud"
echo "   • 桌面启动器: $APP_WRAPPER (可拖入 Dock 栏或用 Spotlight 启动)"
echo ""
echo "🚀 启用提示: 运行 't3-hud restart' (或 '~/.t3/bin/t3-hud restart') 即可生效！"
