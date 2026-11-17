# T3 Hub 接手修复提示词

将下面整段粘贴到 T3 新主会话，授权 T3 按仓库规则接手修复。它和 [只读优先的开关自测提示词](T3-HUB-SELFTEST-PROMPT.zh-CN.md) 不同：本提示词要求按 Issue 开发、验证并交付代码。

```text
现在请接手 ~/Documents/t3-hub 中的 T3 Hub 工作并持续做到有证据的交付。你有权在本工程范围内进行普通可逆的源码修改、隔离测试、审查协调、明确文件暂存、提交和按工程规则推送；不要因为常规读文件、写代码、运行隔离测试或正常 Git 操作反复询问。不要先输出方案然后停下。先核对工程状态并开始当前最高优先级工作。

开始必须阅读：AGENTS.md、docs/HANDOFF.md、docs/REQUIREMENTS-AND-EXPERIMENTS.zh-CN.md、docs/EXPERIMENTS-TIMELINE.zh-CN.md、docs/DEVELOPMENT.zh-CN.md。按顺序打开 GitHub Issues #10 项目总入口及 #6、#7、#8、#9。确认当前会话真实可用的 T3 子代理/审查/测试工具与 ~/.t3/hub/subagents.json 实时路由；遵守当前提示中真实具备的能力，不伪称没有工具或过去已做过两次失败尝试。路由配置缺失时按项目规则报告真实缺口；不要静默换模型。

从 ~/Documents/t3-hub（branch codex/t3-hub-handoff-20261116）继续，原 ~/Documents/t3-code-hud 工作树保留作为副本/证据源，不在那里另开一条实现线。保留已有 WIP，先看 git status、diff、候选源码 hash。最新 UI 候选已复制到本 worktree，但未独立终审，也未安装真实 T3；不要把更旧的审查、测试数或真实截图当成最新候选证据。公开 GitHub 仓库只提交所需的源码、测试和公开文档，私密会话/记忆/账号/日志/截图/报告禁止进入 Git。按路径显式 stage，完成 review 与相关测试后提交并 push，确保工作树状态清楚。

当前业务事实和硬边界：
- Hub 全局 Swarm/总指挥当前是 **ON**。最终保持 ON；新聊天仍曾实际自行编码并显示旧七角色、`code-review` high，这是复现中的问题。六宿主规则文件显示 ON/九角色，不等于当前新会话读取了这些规则。route guard 只改写已发生的 `delegate_task`，不会主动派单。
- 用户要求总指挥开时主会话做决策、拆解、派单与验收；Work L1 同一问题连续两次失败才转 L2，L2 再两次失败后主会话接管。防止重复 Orchestrator/Swarm、嵌套 AGY 原生蜂群和递归子代理。配置、当前新会话指令、实际 delegate 工具调用分层验收。
- AutoDream 配置 Muse Ember / medium / 每日 03:30 Asia/Singapore / enabled / 唤醒补跑。两次真实手动 Muse 执行都返回 `cli-exit-1`、0 条记忆变更，根因仍未知。此提示词**没有授权**发起新的 Muse/其他真实模型整理、认证检查或登录；只用 fixture/mock 单元测试。不能把 timer 正常写成 Agent 成功。
- 不重启或结束 T3 用户进程、不停止用户任务、不操作/修改/登录 AGY、不改变 AGY endpoint/auth/binary/原生 App、不增加 AGY 请求或自动重试。不得通过外部请求验证账号、模型或工具权限。这里限制的是额外诊断探针、AGY请求和新的真实梦境整理；不禁止按当前Hub实时路由为本工程派发必要的正常只读/研发子代理。若选定路由落到受禁止的AGY调用，报告该项阻点，不能静默换模型。
- 常规可逆研发可自主继续。只有遇到这几类阻点才暂停依赖项：需要越权访问/改变权限或认证、对外披露私人数据、额外真实模型/Muse/AGY 请求、会丢失无法恢复的用户数据、或无法安全复原的生产状态。清楚说明具体阻点和影响；不要把普通测试缺口包装成需要用户决定的业务取舍。

按此顺序落实：

P0 / Issue #6：总指挥新会话实际不派单
先只读查清注入链：新会话建立/启动/续聊时 T3 到底向系统指令输入了什么，Hub 的总指挥托管块、旧 AGY 七角色 Skill、Codex 的原生 Hook 候选、项目覆盖、自动派单工具的时序分别由谁控制。固定读取身份与触发时序，不能从 ASAR 偏移猜补丁。ASAR 中 AGY `ExternalPreInvocationHook.injectSteps` 已确认 SDK 不支持并被 Ignored；不要沿这条无效通道继续开发。Codex `UserPromptSubmit/additionalContext` 只是候选；先查它能否获得稳定的 native thread/turn/parent lineage 和 T3 顶层上下文，不能跨宿主泛化。

利用当前实际可用的子代理做用户已授权范围内的只读诊断任务，并验证新主会话是否真的按开关派单。子代理使用实时 Hub 路由 ID / role / provider / model / reasoning 与专属提示，先确认子代理读取自己的配置，不伪造“两次失败”。保存可重放的隔离测试证明开关 ON/OFF 提示互斥、防递归且不会越权；以真实新会话提示、实际派单和任务接收证据区分 PASS/FAIL/BLOCKED。若现有宿主没有安全可用的首轮注入点，给出最小证据解释并选择受支持的 host-specific 接线，不改用户模型或覆盖外部自定义文件。保留现有七个自定义 Claude agent 文件，不用旧七角色示例覆盖用户配置。

P0 / Issue #7：Muse 整理失败的安全诊断
保留已装的安全 promptfile 修复（0700 临时目录、0600 普通文件、finally + inode 所属检查和非递归清理），不要为诊断再真实运行模型。新增 `tests/hub-autodream-diagnostic.test.cjs` 的18个目标红测目前记录安全错误摘要缺失；先以 fake child/stderr fixture 证明失败，再添加实现，确保报告只写严格白名单的错误类别与 HTTP 状态，可用性不足时写 unknown。原始 stderr、命令行凭据、prompt、记忆文本绝不落日志或报告。专测对上此前52/52、54/54、8/8 的通过证据，新增相关测试转绿。离线 fake-runner 可以验证候选簇、安全合并校验、冲突保留、归档可恢复；不得声称已通过真实 Muse 模型验证。若 root cause 仍未知，明确保留未知。

P1 / Issue #8：最新任务面板与悬浮窗
严格按最新版：页头统一“任务面板”；悬浮窗只显示本会话主 Plan，子代理进度只在完整任务页；悬浮窗底部快捷栏整个移除；保留拖动、位置记忆/重置、默认展开、步骤圆圈勾和 N/M、主计划 Markdown/AGY 文件。完整任务页无论有无主计划都能呈现真实子任务。产物卡片改善可读性，点击用 Finder 定位并选中文件，完整任务页仍支持 Markdown 预览。确认最新候选与独立 code-review 的同一 hash，再跑对应测试及窄屏/桌面 fixture。新候选尚未安装；不要在本任务里重启 T3，只有源代码与隔离验证充分后，才采用当前请求允许且不重启的窄范围 reload，并单独报告实际安装和用户窗口验收状态。

P1 / Issue #9：实时速度和缓存
先复现当前轮采样生命周期。原生消息选择器已核对匹配；不要把选择器失配写成根因。streaming 的 DOM 文本估算与 backend completed-turn decode sample 是不同样本，缓存 streaming 时可能还未上报。允许修正仅包括传递明确归属当前 turn、provider 匹配的样本并标 `≈`，或展示“等待本轮上报”；禁止拿上一轮、全会话累计、旧 cache hit 率填当前值。保证生成期间数字/缓存不跳旧轮；完成后显示本轮，均速只在摘要/悬浮信息区。测试正常轮、无采样数据、provider 切换、零 output 和并发 turn，说明实际数据源与失败显示。

完成每项都要：先复现/先红后绿；改动边界尽量局部；相关独立审查只审最新确切 hash；使用隔离环境跑定向测试，并将交付状态分为源码、测试、已安装字节、当前 T3 RPC/window mounted 与真实行为。配置文件存在、成功保存、HTTP 可达都不等于宿主真正加载。不要重复已经通过且未受影响的 815/492/15项历史候选测试声称当前 WIP已全绿。任务结束时写更新后的 HANDOFF、requirements ledger、issue 证据链接与精确 commit/push 状态；不得假装安装、真实派单、Muse运行或T3窗口验证。
```
