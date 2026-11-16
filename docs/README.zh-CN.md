# T3 Code HUD (`t3-code-hud`)

![License](https://img.shields.io/badge/license-MIT-green.svg) ![Platform](https://img.shields.io/badge/platform-macOS-informational.svg) ![Electron](https://img.shields.io/badge/electron-injected-blue.svg) ![Non-invasive](https://img.shields.io/badge/non--invasive-✅-brightgreen.svg)

[English](../README.md) | **简体中文** | [日本語](README.ja.md) | [한국어](README.ko.md)

日常操作见 [Hub 使用指南](HUB-GUIDE.zh-CN.md)：任务进度、产物、技能/MCP 卡片、项目与全局开关、编排和宿主设置。

工程接手请先看 [AGENTS.md](../AGENTS.md) 与 [工程交接](HANDOFF.md)；开发环境、需求/试探台账、可直接交给 T3 的接手修复提示词和开关自测提示词见 [开发说明](DEVELOPMENT.zh-CN.md)、[需求台账](REQUIREMENTS-AND-EXPERIMENTS.zh-CN.md)、[接手修复提示词](T3-HUB-TAKEOVER-PROMPT.zh-CN.md)、[自测提示词](T3-HUB-SELFTEST-PROMPT.zh-CN.md)。

为 **T3 Code / T3 Code (Beta)** 打造的**零侵入式**实时遥测悬浮胶囊、十亿级子代理与费用追踪器、真实上下文圆环、额度监控器和可交互 Git 图谱悬浮窗。

> **不修改 `app.asar`、不破坏签名、跟随官方自动更新不失效。** 精准修复原版 T3 在 **Antigravity / Muse / Codex / Claude** 多引擎下的遥测误报：速度虚标、缓存重复计数、上下文容量虚高及子代理 Token 漏算。

---

## 为什么做这个（根因修复）

原版 T3 在四类遥测上误报，HUD 从源头修正：

| 缺陷 | 原版 T3 | HUD 修复 |
|-----|---------|---------|
| **缓存命中率上限 50%** | Antigravity SQLite 回退路径中 `geminiPromptUsage` 把 `cachedInputTokens` 同时加到分子与分母两遍。 | 直接读原生 Protobuf / JSONL（`conversations/*.db`、`session.jsonl`、`sessions/*.jsonl`），去重为 `uncached + cacheRead + cacheWrite`。 |
| **`/new` 页面圆环显示 100% 红** | 非线程路由复用上一会话的 `live.contextWindow.usedTokens`。 | `!stats.ok` 时强制 `ctxUsed = 0`、`ctxPct = 0`，永不读 stale 状态。 |
| **人为 `30万` 下限** | Antigravity `contextMax` 被 `Math.max(300000, …)` 钳制，掩盖真实的 `100万 / 1048576` 窗口。 | 删除所有 `300000` 钳制。`readAntigravityConvDb` 置 `contextMax: null`，由 `statev2 contextUsage.maxTokens` 继承（Gemini `1048576` / Claude `1000000`），并经 `lookupCatalogContextMax` 目录兜底。 |
| **子代理十亿级漏算** | 递归 `delegate_task` 子孙会话计数不足；缓存仅以 `updated_at` 为 key，WAL 迟到更新被吞。 | BFS 遍历 `orchestration_v2_projection_subagents`，以回合数 + `MAX(updated_at)` 兜底失效；混合引擎线程合并未覆盖 driver，零回合丢失。 |

其他遥测正确性：

- **真实上下文窗口** — `contextUsed` 取末次单次调用 prompt（`promptTotal + output`，已去重）。Muse 继承 `statev2` 的 `1007997`；Codex 读 `token_count` 事件的 `model_context_window`；Antigravity 回退 `1048576`（Gemini）/ `1000000`（Claude）。
- **本轮速度** — 有数据时使用最近完成轮的解码样本；没有原生解码样本时，使用该轮有效输出耗时计算。生成期间根据界面可见文本增量估算实时速度，并用 `≈` 标明，不代表 tokenizer 的精确计数。
- **官方费率** — 复用 T3 官方 `usage-model-rates.json`（5900+ 模型 + 阶梯价）。

---

## 核心特性

- **输入框上方极简胶囊**（自动留白，不遮挡消息流，亮/暗适配）：
  - ⚡ 顶栏显示本轮速度：流式输出时显示带 `≈` 的可见文本增量估算，首个 token 到来前显示「生成中...」，完成后显示本轮样本。新数据未就绪时显示 `-- tok/s`，不会沿用上轮速度或会话均速。悬停详情保留「会话均速」与「末轮速度」；会话均速只在这里显示。
  - ♻️ 真实累计缓存命中率。
  - 🧮 全树 Token 总量（含递归子代理，支持 `2.34B` 十亿级，热查询 `< 8ms`）。
  - 💰 官方费率等效费用与子代理分摊（`$XX.XX (+N子)`）。
  - 🔋 周额度剩余（`周余 67%`）—— 切换 Gemini ↔ Claude/GPT 无需发消息即刻同步；悬停一览全引擎 `5-hour / Session / Weekly` 条。
  - ◔ 上下文圆环 —— 真实占比 + 悬停卡（`上下文容量`、进度条、`平均缓存命中率`）。
- **零遮挡布局** —— `isChatComposerVisibleAndUncovered()` 在设置页、`/usage`、`/pair`、弹窗/对话框、被遮挡输入框时隐藏 HUD；顶栏 `z-index: 30` 低于原生弹窗 `50`。
- **可拖拽 Git 图谱悬浮窗**（`Option+G` / `Esc`）—— 默认居中，最大 920 × 600，单色矢量图标，顶栏集成搜索和仓库状态。固定五列表头「图 / 描述 / 日期 / 作者 / 提交」，橙色 HEAD 双圆环、独立 HEAD/分支标签、`MM/DD HH:mm` 时间。点击提交展开底部分屏，查看文件 `+新增 / -删除` 与高亮统一 Diff。窄于 680px 时隐藏作者并压缩日期/SHA 列；窄屏胶囊的 Token/额度明细可在悬停卡查看。设置页关闭浮窗，原生弹窗显示期间临时隐藏；过滤 `refs/t3/*` 噪音。
- **双语自动识别**（`中文` / `English`）一键切换。
- **远程服务器（T3 Connect）支持 + 官方 `T3 Code v0.1.9` 内存路由** —— 运行在远程服务器（`environmentId`）的会话在本地 `statev2.sqlite` 无行，因此遥测从 T3 内存中的 React Fiber `projection` 投影，由后端 `priceRemoteProjection` 计价，主进程未更新时由浏览器端 `buildLocalProjectionFallback` 兜底。草稿/未发送会话显示 `新会话` 而非 `-- tok/s`。远端 Git 图谱复用已鉴权的 T3 Connect 连接，直接读取未发布提交与原生变更详情，也支持没有 GitHub remote 的仓库。`t3-hud reload` 会同步升级已有窗口的 WebSocket 桥，无需重启 T3。原生历史沿第一父提交读取，合并分支的连线可能不完整，抽屉内会明确提示。TanStack Router 内存路由（`window.__TSR_ROUTER__.state.location.pathname`）在 `location.hash` 为空时也会在 `/settings` / `/usage` / `/pair` 隐藏 HUD。
- **加固本地 RPC** —— 私有目录 `~/.t3/hud-plugin/run/rpc.json`（`0700` 目录、`0600` 文件、`wx` + 防 symlink），分离 `rpcToken`（只读）与 `adminToken`（CLI），已删除 `/admin/eval`，严格的 `t3code://` origin 白名单。

---

## 一键安装

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/install.sh | bash
```

或克隆安装：

```bash
git clone https://github.com/kingmaozi/t3-code-hud.git
cd t3-code-hud
./install.sh
```

等正在执行的任务结束后，重启启用：

```bash
t3-hud restart
```

> 安装脚本不改 `/Applications/T3 Code.app` 内部；卸载即删 `~/.t3/hud-plugin` 并重启。

---

## 常用命令

```bash
t3-hud start     # 启动挂载 HUD 的 T3（已有原版运行时保留任务，不自动重启）
t3-hud restart   # 优雅重启并重新挂载
t3-hud reload    # 零重启热更新 UI 与后端逻辑
t3-hud status    # PID + 挂载状态 + 语言配置
t3-hud lang zh   # 中文
t3-hud lang en   # English
t3-hud lang auto # 清除显式选择，按 T3 UI 语言自动识别
```

快捷键：`Option + G` 切换图谱，`Esc` 关闭。

---

## i18n 指南

解析顺序：

1. **显式切换** — `localStorage["t3-hud-lang"]` 或 `config.userLang`（来自统计卡头或图谱悬浮窗的 `EN` / `中文` 按钮，或 `t3-hud lang`）。
2. **DOM 自动识别** — `document.documentElement.lang` 与 UI 文案（`想问什么` / `本地工作副本` / `新会话` / `设置` → `zh`；`Ask anything` / `Local working copy` / `New thread` / `Settings` → `en`）。
3. **安装时默认值** — `install.sh` 按 `--lang` / `T3_HUD_LANG` / 系统 locale（`LC_ALL` / `LC_MESSAGES` / `LANG` / AppleLanguages）写入 `config.defaultLang`，回退 `zh`。

即时生效且跨重启持久化：

```bash
./install.sh --lang en
T3_HUD_LANG=zh ./install.sh
t3-hud lang en
t3-hud lang zh
t3-hud lang auto
```

配置文件：`~/.t3/hud-plugin/config.json`（`{ "defaultLang": "zh"|"en", "userLang": "zh"|"en"|"auto" }`）。

---

## 架构

```
T3 Code.app (Electron main "browser")
  └─ bootstrap.cjs → spawn --inspect=127.0.0.1:0 → CDP Runtime.evaluate → require(main-hook.cjs) → 校验 "OK"
       └─ main-hook.cjs
            ├─ 本地 HTTP Server (127.0.0.1:0) — rpcToken (仅 /rpc) + adminToken (CLI only)
            ├─ IPC: t3hud:get-thread-stats / get-git-graph / get-commit-detail / get-config / set-config (senderFrame 白名单)
            └─ injectHudIntoWindow() → window.__t3HudHttpConfig + renderer-ui.js
                 └─ preload-bridge.cjs → window.__t3HudBridge
                      └─ renderer-ui.js（顶栏 + 悬停卡 + 图谱悬浮窗，双语零遮挡）
                           └─ backend.cjs → statev2.sqlite + 原生文件 + usage-model-rates.json
```

---

## 卸载

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/uninstall.sh | bash
```

---

## 安全

见 `src/main-hook.cjs`、`src/bootstrap.cjs` 与 `src/backend.cjs` 的 `getConfig` / `setConfig`。运行态位于 `~/.t3/hud-plugin/run/`（`0o700` / `0o600` + `wx`）。

---

## 许可证

[MIT](../LICENSE)

### 启动验收与可选的 AGY wrapper 修复

`start` 会保留已经运行但未挂载的 T3，只有明确执行 `restart` 才重启。`status` 同时核对进程与带鉴权的本机 RPC；安装文件不等于当前窗口已生效。以后从 **T3 Code HUD.app** 启动；直接打开原版应用不会加载 HUD。

macOS ARM64 上的 Antigravity wrapper 退出崩溃可使用独立的 `scripts/agy-acp-wrapper-install.py` 修复，先用 `--check` 检查。安装器要求 `/opt/homebrew/bin/python3` 可执行，替换前备份，不修改提供商绑定，也不重启进程。新启动的 wrapper 才使用修复代码；旧进程仍使用旧代码。回退时恢复对应 wrapper 备份。

运行连接记录按进程保存在 `run/rpc-<pid>.json`。旧 `rpc.json` 只兼容显式热重载；旧版状态接口无法核实窗口挂载，所以状态保持“就绪未确认”，重启加载新版 hook 后才能完整验收。
