#!/usr/bin/env bash
set -euo pipefail

rm -rf "$HOME/.t3/hud-plugin"
rm -f "$HOME/.t3/bin/t3-hud" "$HOME/.t3/bin/t3-mcp-router" "$HOME/.t3/bin/pc-lite.mjs" "/opt/homebrew/bin/t3-hud" "/usr/local/bin/t3-hud" "$HOME/.local/bin/t3-hud"
rm -rf "$HOME/Applications/T3 Code HUD.app"
# Legacy /tmp locations (pre-hardening) — clean defensively; runtime now uses ~/.t3/hud-plugin/run/
rm -f "/tmp/t3-hud-active.pid" "/tmp/t3-hud-rpc.json" "/tmp/t3-hud-override-rpc.json"

echo "✅ T3 Code HUD 已完全卸载（原版 T3 Code.app 未做任何修改，重启即恢复原状）。"
