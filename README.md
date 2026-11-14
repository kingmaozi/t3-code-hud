# T3 Code HUD (`t3-code-hud`)

为 **T3 Code / T3 Code (Beta)** 打造的**零侵入式（不改 `app.asar`、不破坏签名、跟随官方自动更新不失效）**增强悬浮胶囊与可拖拽 Git 拓扑图插件。

精准修复并补齐了原版 T3 Code 在多引擎（**Antigravity / Muse / Codex / Claude**）下的速度、缓存命中率、上下文容量虚标及子代理十亿级 Token 漏算问题。

---

## ✨ 核心特性

- **聊天输入框正上方极简胶囊悬浮窗**（自动预留原生弹性间距，绝不遮挡消息流，完美适配亮/暗主题）：
  - **⚡ 实时动态流式速度 (`tok/s`)**：流式输出期间每 `260ms` 动态跳动显示实时生成速率；单步完成后精准锁定纯解码速度（自动剥离工具执行等待与首字预填充耗时，支持同一会话内切换引擎自动同步最新速度）。
  - **♻️ 真实累计缓存命中率 (`累计缓存 XX%`)**：直读 Muse `session.jsonl`、Antigravity `conversations/*.db` Protobuf 与 Codex `sessions/*.jsonl`，彻底绕开原版 `geminiPromptUsage` 将缓存 Token 重复计入分母导致上限卡死 50% 的缺陷。
  - **🧮 单会话全树 Token 总量（含递归子代理，支持 `B` 十亿级显示）**：递归汇总当前会话下所有 `delegate_task` 子代理、孙代理及原生子代理 Token（如 `2.34B tok`），内置 `O(1)` 缓存索引，400+ 子代理热查询仅需 `< 8ms`。
  - **💰 官方费率等效费用 (`$XX.XX (+N子)`)**：复用 T3 官方 `usage-model-rates.json` 5,900+ 模型阶梯定价（含超长上下文阶梯价与缓存节省金额）。
  - **🔋 智能周额度剩余 (`周余 XX%`)**：
    - **Antigravity (AGY)**：默认显示 `Gemini · Weekly`；当在输入框切换为 **Opus / Sonnet / Claude / GPT** 模型时，**无需发消息即刻自动切换**显示 `Claude & GPT · Weekly` 周余（低额度自动橙/红预警）。
    - **Muse / Codex**：自动匹配当前引擎的 `Weekly` 剩余额度；鼠标悬停可一览**所有引擎的 `5-hour / Session / Weekly` 额度条与重置倒计时**。
  - **◔ 圆环上下文占比（紧邻图谱按钮前）**：
    - 彻底修复 Antigravity 下原版双倍计入缓存（500k+）及分母虚标 `1M` 的问题，按真实滑动窗口上限（如 AGY `30万`、Codex `47.5万/25.8万`、Muse `101万`）显示真实占比；
    - 鼠标移上圆环弹出极简卡片：**`上下文容量 XX万/XX万 (XX.X%)` + 圆角进度条 + `平均缓存命中率`**。
  - **🧹 自动精简右侧边栏**：通过纯 CSS 隐藏右侧边栏底部冗余的原生「额度」与「上下文」区块，保留干净的分支 / PR / 提交面板，同时保持底层额度状态实时在线。
  - **🌿 可拖拽 Git 分支拓扑图悬浮窗 (`Option + G`)**：多泳道 SVG 分支曲线、工作区脏文件数角标、搜索过滤、点击任意 Commit 查看改动文件列表与语法高亮 Diff（自动过滤 T3 内部 `refs/t3/*` 快照噪音）。

---

## 📦 一键安装（任何装有 T3 Code 的 Mac）

### 方式一：一行命令安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/install.sh | bash
```

### 方式二：克隆仓库安装

```bash
git clone https://github.com/kingmaozi/t3-code-hud.git
cd t3-code-hud
./install.sh
```

安装完成后，执行以下命令重启一次 T3 Code 即可生效：

```bash
t3-hud restart
```

> 💡 安装脚本同时会在 `~/Applications/T3 Code HUD.app` 生成带官方图标的启动器，可直接拖到 **macOS Dock 栏** 或通过 **Spotlight / Raycast** 一键启动。

---

## 🛠️ 常用命令

```bash
t3-hud start     # 启动挂载了 HUD 的 T3 Code（若已运行原版则自动无缝切换）
t3-hud restart   # 优雅重启 T3 Code 并重新挂载 HUD
t3-hud reload    # 零重启热更新 UI 与后端统计逻辑（修改代码后秒级生效）
t3-hud status    # 查看当前挂载状态与进程 PID
```

### 快捷键

- `Option + G`：打开 / 关闭右侧可拖拽 Git 分支拓扑图抽屉
- `Esc`：关闭 Git 图谱抽屉

---

## 🗑️ 一键卸载

```bash
curl -fsSL https://raw.githubusercontent.com/kingmaozi/t3-code-hud/main/uninstall.sh | bash
```
（本插件**零修改** `/Applications/T3 Code.app` 内部文件，卸载后重启 T3 Code 即 100% 恢复原厂状态。）

---

## 📄 License

[MIT](./LICENSE)
