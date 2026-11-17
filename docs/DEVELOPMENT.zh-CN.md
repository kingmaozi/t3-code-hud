# T3 Hub 工程环境

## 仓库

- 工程目录：`~/Documents/t3-hub`（本次接手专用 Git worktree）
- GitHub：<https://github.com/kingmaozi/t3-code-hud>
- `origin`：`https://github.com/kingmaozi/t3-code-hud.git`
- 接手分支：`codex/t3-hub-handoff-20261116`，基于 `4a28ce4`
- 当前版本：`package.json` 中的 `1.0.2`（已对齐官方 `T3 Code v0.1.10`）

本地新工程已经有 Git 历史和远程地址，不要再 `git init`、不要更换 remote。推送前先检查 remote、暂存清单和完整差异，因为 GitHub 仓库是公开的。私人会话、用户记忆库、日志、报告、密钥和账号资料不能提交。

## 本机开发步骤

```bash
cd ~/Documents/t3-hub
git status --short --branch
git remote -v
git log -1 --oneline
node --version
```

仓库未配置 `npm test` 脚本；测试直接用 Node 内置测试运行器并明确选择文件：

```bash
node --test tests/hub-v3-frontend-contract-xss.test.cjs
node --test tests/hub-tier-routing.test.cjs
node --test tests/hub-autodream-runtime.test.cjs
```

这些是按需选择的例子，不应为了流程机械运行全部测试。若测试涉及 Hub 后台或真实 T3，先读测试内容确认不会触发真实模型、修改用户配置、打开 AGY 或启动/结束用户进程。不要将任何真实 Muse 梦境纳入自动回归。

## 安装与热更新

`package.json` 的开发相关脚本仅声明 `install-hud` 和 `uninstall-hud`。仓库中的 `install.sh` 会复制多个源文件、处理安装配置并可能触发热更新，是安装脚本，不是安全的窄范围开发命令。执行前逐行审查当前版本、备份现有目标，并确认用户授权的生命周期范围。

实现代码和安装中的副本分开存在。若获准窄范围热更新，先确认正在运行的是哪个 T3 主 PID 和 Hub sidecar，再逐个备份目标、只复制所属模块、核对源码/目标 SHA-256；`src/renderer-ui.js` 的安装基底是 `~/.t3/hud-plugin/renderer-base.js`，随后需使用受支持的 `t3-hud reload` 重新组装当前 renderer。最后分别查看 `t3-hud status`、per-PID RPC 的 mounted/window mounted 与实际界面。不要把热更新写成重启；不要结束仍在处理任务的 sidecar 或 ACP 子进程。

没有用户明确授权时，不重启 T3、不改 AGY、不做真实模型请求、不更新账号认证、不安装未经审查的文件。回滚只恢复此次备份且经确认归属本次改动的文件。
