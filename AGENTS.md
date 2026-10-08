# AGENTS.md — dsh-jenkins-plugin

DeepSeek Harness 的 Jenkins 插件：Web GUI 里的实时构建进度面板 + 面向模型的构建工具。

**功能基线是 [SPEC.md](SPEC.md)，功能范围以它为准。** 本文件只管工程约定、当前状态和下一步。

## 当前状态

已完成：

- `src/config.ts` — SPEC §3 全部 24 个配置字段 + `settingsFile` + schemastery 校验 + `denyJobs` 匹配。
  `baseUrl`/`username` 已改为**可选**（默认空）：静态配置现在只是**回退层**（合成一个 id 为
  `config` 的实例），非 Web 组合与无人值守部署仍可纯配置驱动。
- `src/settings.ts` — 实例清单持久化：`JenkinsSettings = { instances[], defaultInstanceId }`，
  写 `$DSH_HOME/jenkins.json`（0600，tmp+rename 原子写，带 `version: 2`）。**只存 url/账号/凭据名，
  绝不存密码**。能读第一版的扁平单实例格式并自动迁移。凭据名默认由 id 派生（`tokenRefFor`），
  因为凭据引用必须匹配 `[A-Za-z_][A-Za-z0-9_]*` 语法。
- `src/connection.ts` — `InstanceRegistry`：多实例注册表，`list()` / `require(id?)` / `replace()` /
  `reset()`；优先级 `设置页 > 静态配置`；**每个实例一个 `JenkinsClient`**（各自 crumb 缓存），
  身份（url/账号/凭据名）不变时复用。
- `src/jenkins/client.ts` — REST 客户端：Basic 认证、crumb 缓存、自签证书/自定义 CA、超时、字节上限；
  `listJobs` / `jobDetail`(历史分页) / `buildDetail`(阶段+变更集+测试+产物+触发原因) /
  `consoleLog`(**本地切片式**，见下「真实 Jenkins」) / `workspace`(能力探测) / `whoAmI` / `trigger` /
  `cancel` / `queueItem` / `resolveBuildNumber`。**所有 `tree` 查询都过 `tree()` 编码器**。
- `src/jenkins/types.ts` — 归一化领域类型；`buildOutcome()` 把 `result: null` 区分为
  「运行中」与「已中止」；`stageProgress`/`activeStage`/`failedStage`。
- `src/tools/jobs.ts` — `jenkins_jobs`（带 `instance` 参数；输出 schema 收窄，不随客户端字段漂移）。
- `src/watch.ts` — **纯逻辑**的关注构建判定：`pendingNotices()` 决定哪些构建该发通知（终态 +
  未被通知过），`NoticeLog` 记录已通知的键（有界，最老先淘汰）。键是
  `instanceId/jobPath#buildNumber`，所以同一构建只通知一次、同一 job 的**下一次**构建会再通知。
  刻意不依赖时钟/网络/cordis，方便直接测。
- `src/follow.ts` — `FollowWatcher`：**只轮询关注列表**（每个实例一次列表请求，不是每个 job 一次），
  发现终态构建就用平台自己的后台作业机制（`ctx.jobs.start`）交付一次完成通知。
  `notifyOnComplete` 关或组合里没有 jobs 服务时不启动（静默降级，不算错误）。
  一轮 tick 用重入标志挡住，且任何异常都被吞掉——控制器宕机/凭据轮换不能让 watcher 死掉。
- `src/tools/builds.ts` — 四个工具：`jenkins_build_status`、`jenkins_log`、`jenkins_workspace`、
  **`jenkins_build`**（唯一的写工具；触发后会 `tracker.trackQueue()`，所以**模型触发的构建也会自己
  出现在面板上**，对应 SPEC §10 验收第 1 条）。
- `src/policy.ts` — **写操作的配置判定**（纯函数 `checkWritePolicy`）：`denyJobs` → `allowTrigger`
  /`allowCancel`，按 SPEC §7 的顺序**先判且无副作用**。模型工具在它之后再加 `ctx.approval`，
  面板路由到它就停。抽出来是为了两条路共用同一份判定，而不是各写一遍（`tests/write-policy.ts` 14 项）。
- `src/tracker.ts` — `BuildTracker`：跟踪表 + **轮询决策**。三条规则（SPEC §10）：
  ①**无订阅者不轮询**——循环放在这个类里、next to 订阅计数，`start(poll)` 装一次定时器，
  `runTick()` 先看 `watched`，没订阅者直接返回（实测：无订阅者时 stub 命中数 **0**）；
  ②**无进展就退避**——`nextInterval()` 纯函数，未变则翻倍至 `idleBackoffMaxMs`，变了回到
  `progressIntervalMs`（实测 1000→2000→4000→8000→8000）；
  ③**结束就不再轮询**——`state='finished'` 后 `isDue()` 永远 false。
  `snapshot()` 输出整份状态而非增量，重连的面板无需重放逻辑；`sweep()` 按 `retainMs` 回收。
  **新增 `queued` 态**（SPEC §2/§8）：触发回答的是排队项而不是构建，所以 `trackQueue()` 先记一条
  没有 buildNumber 的记录（id 是 `<instance>/<job>@<queueId>`，**故意不是构建 id**），轮询读排队项，
  拿到号后 `adopt()` 把它**重新挂键**到 `<instance>/<job>#<号>`——面板按构建号找记录，所以
  「重新挂键」正是让刚触发的构建出现在卡片上的那一步。排队超过 `queueTimeoutMs` 就 `detach()` 成
  `detached` 并带上原因，而不是无声消失。`track()` / `trackQueue()` 都会 `publish()`：记录出现本身
  就是面板要画的变化，不 publish 的话点「触发构建」后卡片会一直没反应，直到第一次轮询。
  `tests/tracker.ts` 53 项断言覆盖以上全部（含 `isRecordGone`：只有「Jenkins 没有这个」才终结一条
  记录，凭据/网络问题下一轮还要重试；以及 **`adopt` 遇到同一构建号的旧记录时替换而不是合并**——
  合并会留着旧记录的终态，把一条真在跑的构建报成 finished）。
- `src/routes.ts` 的 `GET /jenkins-plugin/events` — **SSE 实时通道**。连接本身就是订阅：
  开着就连带启动 host 轮询，断开就停（*no subscribers, no polling* 由连接生命周期保证）。
  要跟踪什么随订阅一起给：`?instance=<id>&builds=<jobPath>#<n>,<jobPath>#<n>`。
  每帧是全量快照；另有 20s 的注释帧防中间层掐断静默连接。
- `src/client/*` — 三个浏览器界面：
  - **设置页**（`settings.section`，左侧导航 `Jenkins`，order 40）：`SettingsSection.tsx` 管理实例
    的增删改、测试连接、设为默认、保存；密码通过 DSH 的 credentials Remote 写入，不经过本插件路由。
  - **右侧栏面板**（`sidebar.right.pane.tab`，id/kind 都是 `jenkins-build`）分两个模块：
    **「我关注的」**（每个关注 job 一张卡片：状态点 / `#build` / 状态标签 / **进度条** / 取消关注）
    和 **「所有 job」**（**默认折叠**，展开后每行末尾有 ☆/★ 按钮可关注/取消）。
    点 job 或卡片继续下钻：`Builds.tsx` `JobView`(构建历史+分页) → `BuildView`(构建详情
    阶段条/内嵌日志窗/测试/变更集/产物)。**全部在页面内完成，不跳远程 Jenkins**（产物下载是唯一例外）。
  - **卡片的数据来自 SSE，不是定时器**：面板按「当前正在跑的构建」拼出
    `GET /jenkins-plugin/events?instance=<id>&builds=<jobPath>#<n>,…` 开一条 `EventSource`
    （`api.ts` 的 `subscribeEvents`，另有 `onopen/onerror` 回调让页面显示「实时 / 已断开」）。
    连接即订阅，所以「没人看就不轮询」由连接生命周期保证，面板不需要说停。
  - `live.ts` 是**纯规则模块**（无 React/DOM），因为卡片最难的判断都在这里：
    `buildsToFollow`（**只跟正在跑的构建**——已结束的构建数字不会再变，跟它等于每张卡白花一次
    请求）、`recordsFor`（快照是**跨实例**的一张表，必须按实例过滤）、`trackedFor`（用 tracker
    自己的 id 找记录）、`anyStateChanged`（**任何状态变化**都说明关注列表可能过期，据此重新拉一次
    列表：构建结束要看有没有下一次构建，排队项变成构建更是列表里从没出现过的新构建）、
    `queuedFor`（按 **job 路径**找排队记录——排队中的构建还没有号，`trackedFor` 找不到它，
    卡片上的「已排队」胶囊就靠这个）、`activeStageOf`、`cardState`（**live 记录永远压过列表**：
    构建刚结束而列表还写着 building 的那一小段时间里，卡片必须已经显示结果）、
    `favoritesOf`（关注列表**带实例标签**，只有实例对得上才能用——见下「一次卡死」）。
    这些规则、卡片的两条新判断（`changeSummary` 一行提交、`wantRebuild` 只认 `failure`）
    和 `api.ts` 的参数解析一起由 `tests/panel-live.ts` 断言（64 项）。
  - **面板的写操作**在 `Builds.tsx`：`TriggerAction`（JobView，参数框 + 二次确认）和 `WriteAction`
    （BuildView 的**重新构建**/**中止构建**，同样是「按钮 → 确认 → 执行」）。确认是**行内**的而不是
    弹窗：侧边栏很窄，行内提示能把「要发哪个 job、带什么参数」摆在眼前，弹窗反而会盖住被确认的东西。
    拒绝（`denyJobs`/`allow.*`，或 Jenkins 自己的报错）就显示在对应按钮下面，不会变成页面级横幅。
    **重新构建沿用上次参数**：`buildDetail` 现在也从 `actions[parameters[name,value]]` 里取参数
    （`JenkinsBuildDetail.parameters`），构建详情页会把它们显示成小标签。
  - **失败卡片上的「重新构建」与「交给 AI 分析」**——`wantRebuild(outcome)` 只认 `failure`
    （`unstable`/`aborted` 不是失败），点击时**先读该构建的 `parameters` 再触发**，所以参数化 job
    也能重建（猜参数比没有按钮更糟）。**「交给 AI 分析」**走 `POST /jenkins-plugin/analyze`，
    见下。两个按钮共用一个 `WriteAction`，分析那个传 `immediate`（不二次确认）：它不改控制器上的
    任何东西，点击本身就是意图。
- `src/analyze.ts` — **把失败构建交给模型的纯逻辑**。`failurePrompt()` 组装提示词：
  哪个 job/构建、结果、失败阶段（没有就**明说「未报告」**，因为「Jenkins 没说」和「我们没看」
  是两件事）、触发原因、最新的几条提交（最多 5 条、每条只取首行、超长截断）、**日志尾部**，
  然后要求「① 一句话原因 + 支撑它的日志行 ② 1-3 条具体修复 ③ 不够就说要哪一段」，
  并明确**不要复述日志、不要给与日志无关的通用建议**；还告诉它可以用 `jenkins_log`（`tail_lines`
  最多 2000 行）/`jenkins_build_status`/`jenkins_workspace` 自己取更多。
  `handOverFailure()` 是实际的交接：**读日志取尾巴**（`analyzeLogBytes`，默认 16 KiB——
  失败行在末尾，而日志可能上百 MB）、读一次 `buildDetail` 拿阶段/提交/触发原因，然后
  **只排一条消息**（`followup(prompt)`），返回「交出去了多少」供面板显示。
  两个读都收窄成 `AnalyzeReads` 接口，所以能用假控制器直接断言（`tests/analyze.ts` 41 项：
  提示词内容、截断声明与真实大小、提交条数与截断、以及**用了哪个 offset/上限**）。
- **`POST /jenkins-plugin/analyze`**（面板点「交给 AI 分析」）：守望门 → 校验 job/build/session →
  `allowAnalyze` 关则 403 → **`ctx.get('agents')` 找不到则 503**（本组合没有 agent 运行时）→
  `agents.get(sessionId)` 没有则 **409 `no-session`**（会话没有活着的 agent，排队一条消息只会
  丢掉它——错误信息直接说「先在那个会话里发一条消息」）→ 同一构建**在途去重**（`analysisKey`，
  双击不会买两次模型轮次；键在处理完即释放，所以不需要任何时间窗口配置）→ 读、组装、`followup`。
  会话 id **由面板随请求带来**（`sidebar.right.pane.tab` 是 `scope: 'session'` 的座位，
  `PropsRuntime` 里有 `sessionId`；为此在 devDependencies 加了 `@deepseek-ai/dsh-client-ui-session`
  ——`SessionStandardProps` 的 `sessionId` 是它 declare 的，只 `import type {}` 引入，运行时零影响）。
  消息用 `createUserMessage`（**值**导入 `@deepseek-ai/dsh-llm`，已加进 peerDependencies），
  这样 id/冻结/source 都由平台负责，而不是手搓一个形状。
  **为什么是路由而不是工具**：点按钮的是人，不是模型；答案要出现在他正在读的那个会话里。
  **这条也顺带证明了「会话 → agent」是可达的**（`ctx.get('agents').get(sessionId)` +
  `Agent.followup`），也就是待办里 `notifyWakeOnFailure` 缺的那一半：watcher 需要的不是新机制，
  而是**把会话 id 记进关注项**（人从哪个会话关注的就归谁）。
- **Maven 版本号是可行的，实测过**：`GET <build>/mavenArtifacts/api/json` 在 Maven job 上返回
  200 且给出 `moduleRecords[].mainArtifact.version`（真机上 `2.0.10-SNAPSHOT` 这种），
  非 Maven 的 job 一律 404——所以它同时就是「是不是 Maven」的判据。`client.mavenVersion()`
  **永不抛异常**（版本只是装饰，抛出的 `not-found` 上一层会让 tracker 丢掉整条记录），
  404/500/连不上都返回 `undefined`。挂在 `/favorites` 上（`mavenVersion`），一个构建一次、
  带 500 条上限的读缓存，**非 Maven 也缓存为「没有」**，所以 404 只发生一次而不是每次刷新。
  **注意**：真实 2.176.2 上这个端点在构建**跑完之前**不一定有内容（Maven 的 `MavenArtifactRecord`
  是构建结束时产生的），所以正在跑的 Maven 构建卡片上通常看不到版本号——这是如实降级，
  没有版本就不显示，绝不猜一个。
- `src/client/WriteAction.tsx` — 三处写/动作共用的一个控件（JobView / BuildView / 关注卡片）：
  「按钮 → 行内二次确认 → 执行 → 就地显示结果」，失败也是就地显示。`immediate` 只给不改控制器
  的那个动作（交给 AI 分析）用，别拿它绕开确认。别在别处再写一遍这套状态机。
- `src/settings.ts` 同时保存**关注列表**（`favorites`，按实例 id 分键）。
- `tests/stub-jenkins.ts` — 零依赖 stub Jenkins（两层 folder 树 + 阶段 + `/me/api/json` + 可浏览页面）。
  **正在跑的构建的 `timestamp` 必须相对当前时刻**（`RUNNING_AGE_MS`）：写死日期的结果是进度条把
  「这个固定日期距今多久」当成构建耗时显示出来，看起来像面板坏了。
  **写端点也已具备**（`POST /job/<path>/build|buildWithParameters`、`POST /job/<path>/<n>/stop`、
  `GET /queue/item/<id>/api/json`）：触发会**真的改状态**——buildCount +1、`building=true`、
  发一个 `queue` 项、`QUEUE_DELAY_MS`(2.5s) 后才给出 `executable`。延迟是刻意的：不留等待窗口的话
  `queued → running` 这条路径根本没机会被验证。**`POST` 也在凭据墙后面**（Jenkins 同样要求），
  所以触发器要带 Basic。被触发过的 job 会带 `triggered` 标记，它的阶段列表由 `runningStages()`
  合成「前面的都 SUCCESS、最后一条 IN_PROGRESS」——照搬静态列表会让一个刚起的构建画出满进度条。
  **`consoleText` 也有了**，而且**故意和真实控制器一样不配合**：忽略 `?start=`、不发 `x-text-size`
  （只有 `content-length`）。日志最后一行写着 `stub log for <job> #<n>`，所以一眼能看出拿到的是尾还是头。
  **`maven-web` 是这台 stub 上的 Maven job**（`hudson.maven.MavenModuleSet`、失败、参数化），
  只有它回答 `mavenArtifacts/api/json`（`moduleRecords[0].mainArtifact.version`），别的 job 一律 404。
  触发时**把它收到的参数存回 job**（`node.parameters`），构建的 `actions[parameters]` 因此会报出
  「这个构建是用什么参数跑的」——真实 Jenkins 就是这样，也正是「重新构建沿用上次参数」能被断言的原因。
  每个构建还带 3 条 `changeSet` 提交（最新那条消息里含 `#<number>`），供卡片的变更说明使用。
- `tests/*.ts` — **仓库内断言测试**，没有测试框架，`node tests/<name>.ts`（先 `tsc`）：共 235 项。
  `panel-live.ts` 64（面板规则 + 参数解析 + 关注列表的实例标签 + `changeSummary` + `wantRebuild`）、
  `tracker.ts` 53（轮询决策 + queued 态 + `isRecordGone` + **同一构建号再次变为存活时替换而不是
  合并旧记录**）、`analyze.ts` 41（提示词内容、缺席事实要明说、截断声明带真实大小、提交条数与截断、
  在途去重键，以及**交接用了哪个 offset/上限、只排一条消息**）、`watch.ts` 30（通知判定：跑着的
  不通知、同一次构建只通知一次、下一次要再通知、`NoticeLog` 有界）、`console-log.ts` 22
  （**进程内假控制器**复现真实 2.176.2 行为：忽略 `?start=`、只给 `content-length`，断言 tail
  是尾不是头、`x-text-size` 优先、超窗读要如实报 `truncated`）、`maven-version.ts` 11
  （Maven 版本解析的每种形状 + **404/500/连不上都必须安静地返回 undefined**）、
  `write-policy.ts` 14（写权限判定；还顺带断言 `routes.ts` **没有**用 `ctx.approval`，
  因为「面板写路径不接审批」这件事在行为上不可见，只能对着源码断言）。

**多实例与配置模型（2026-09-24 定的设计，勿擅自改回）**：

| 项 | 决定 |
|---|---|
| 实例清单 | 存 `$DSH_HOME/jenkins.json`；优先级 `设置页 > 静态配置`（静态配置合成 id `config` 的实例） |
| 密码 | 每实例一个凭据引用（默认 `JENKINS_TOKEN_<ID>`），只走 `ctx.credentials`；**配置文件里没有密码** |
| 设置页写密码 | 走 **DSH 自己的 credentials Remote**（`ctx.remote.credentials.set`），不新增插件路由 |
| 登录态判定 | `credentials.describe(ref)` 的 `configured` |
| 保存顺序 | **先逐行探测（whoAmI）全部通过，才写凭据与文件**；任一行失败则整次保存被拒、零写入 |
| 空密码字段 | 表示「沿用已存凭据」；已存凭据的行不再要求重填 |
| 面板所选实例 | 按会话 cookie 记忆（`POST /select`），默认实例作为回退 |

**验证已通过**：`plugin add` → profile 补丁配好 → `dsh web` 起来后客户端 bundle 进 `__DSH_BOOT__`
清单与 application 批次；不带 cookie 被守门挡成 401；**人在浏览器里确认过**头部入口与 job 列表、
点行能打开构建页。**面板侧**：`unconfigured` → 错误凭据被 401 拒绝且零写入 → 正确凭据连上并列出
job（含 `lastBuild`）→ 写入并重启后仍生效 → 断开回退。**对真实 Jenkins 也全链路验证过**：
设置页的 probe/save/select 与 `job`/`build`/`log` 三条读路由都实测通过（777 jobs、构建历史分页、
变更集、产物、控制台日志），并且**两处 stub 掩盖不了的真 bug 就是这样被抓出来的**——`tree` 未编码
被真实 Jenkins 判 400；`<build>/api/json` 不接受 `last` 别名。

三个踩过的坑，别再花时间：① **桌面版（Electron）永远看不到这个面板**——它的 harness home
(`AppData\Roaming\dsh-desktop\harness`) 里没有本插件，且 SPEC §1 已声明桌面载体不在保证范围；
验证必须用 `dsh web` 的实例。② **空会话落地页不渲染会话头部**：`ConversationMainPanel.tsx`
里 `sessionId === undefined ? null : renderSlot('conversation.session.header', …)`，所以
必须先发一条消息进入真会话，头部（含 `…header.actions`）才存在。③ **`clsx` 不是模块表行**：
插件 bundle 必须把它内联（平台自己的客户端包也这么做），externalize 它会在运行时抛
「module table cannot answer」。


**面板接 SSE 已实测通过**（`.e2e/probe-live-panel.mjs`，14 项断言）：真实 Jenkins 那一刻没有正在跑的
构建（三个关注 job 的最新构建都已结束），所以在 stub 上验——加了 `stub` 实例（端口 18090）并关注
`team/service/api-build`（永久处于构建中、4 个阶段、`Test` 在跑），面板那条路径整条走通：
带 cookie 换 303 会话 → `POST /instances` 存 ci+stub（**ci 的 3 个关注没被抹掉**）→
`/favorites` 拿到 `building=true` → 开 `/events?instance=stub&builds=team/service/api-build#42`
拿到 `text/event-stream`，帧里 `state=running`、`progress.kind=stages`（`fraction 0.5`/`completed 2`/`total 4`）、
`stages` 里 `Test` 是 `IN_PROGRESS`。另外 `.e2e/probe-bundle.mjs` 确认**服务器下发的 bundle 就是刚构建的
那个**（在 `/plugins/` 的两个脚本里都能搜到 `jenkins-plugin/events` / `live.closed` / `state.building`），
所以浏览器刷新后跑的一定是新面板。

**面板写操作也已实测通过**（`.e2e/probe-panel-writes.mjs` 23 项 + `.e2e/probe-panel-abort.mjs` 11 项，
policy 由 profile 补丁给：`denyJobs: [infra/*]`）。不关 `allowCancel` 时：触发 `infra/deploy-prod`
得到 **403 + `code:"forbidden"` + 报文里点名 denyJobs**（且 Jenkins 一个请求都没收到）；`smoke`
的触发被接受并回排队号；**面板自己就能看到排队态**（帧里 `state=queued`、有 `queueId`、没有
`buildNumber`），~2.5s 后同一帧流变成 `state=running` + 真构建号 + 阶段进度（`progress.kind=stages`），
**全程没有任何人再请求过什么**——这就是「连接即订阅」的效果。`/favorites` 随后也把新构建当作
`lastBuild` 报出来（`building=true`）。中止在 `allowCancel=false` 时是 403。把补丁改成
`allowCancel: true` 重启后：同一路径触发→运行→**中止 200 `aborted:true`**→SSE 自己报
`state=finished, outcome=aborted`→**再中止一次返回 `aborted:false, state=already-finished`**
（是事实不是错误）。`.e2e/probe-stub-writes.mjs` 另有 17 项直接验证 stub 自己的写端点。
`.e2e/probe-bundle.mjs` 确认服务器下发的 bundle 里能搜到 `jenkins-plugin/trigger`、`write.confirmTrigger`、
`favorites.queued` 等只存在于新面板的字符串，所以浏览器刷新后跑的一定是新代码。

**一次「卡死」的完整根因链**（用户看到卡片永远停在「已排队」；`.e2e/probe-live-containment.mjs`
10 项断言把这个场景钉住了，别再犯）：① **一条坏记录拖垮整批**——轮询回调本该只让坏记录失败，
但整个批次在一次 `for` 里，且 `runTick` 一次 `try` 包住全部，于是排在前面那条「实例上不存在的
job」每 1.5s 抛一次，后面所有构建（包括刚触发的排队项）**永远轮不到**。现在逐条 `try`，
配合 `isRecordGone()`：只有 `not-found`/`config` 才 `detach`（带原因），凭据/网络问题留待下一轮。
② **关注列表跨实例**——面板在切换实例的那一帧里，实例 id 已经是新的、列表还是旧控制器的，
于是它拿 ci 的 job 去问 stub。现在列表带实例标签（`favoritesOf`），对不上就一律不用。
③ **重启后残留的构建号**——老的构建号（这里 `smoke#7`）在新控制器上不存在；stub 以前对任意号
都编一行出来（假 finished），现在**如实 404**，于是记录被 `detach` 而不是变成一条看得见却没意义的
构建。④ 面板侧：SSE **重连**（而非首次打开）时重新读一次关注列表——重连正是「宿主重启过了」的样子。
另外两条纯属我自己踩的：探针**一次 `read()` 只解一帧**，剩下的帧留在缓冲里看不见（背退避到 24s
的时候看起来就是「什么都没发生」）；以及探针用「最新的记录」而不是「我要的那一号/那个排队项」
去匹配，会被残留记录带偏。

**写 `.e2e` 探针时另外三个坑**（都浪费过时间）：① **别用 `process.exit()`**——Windows 上 undici
还有异步句柄没收完就退，会触发 libuv 断言 `!(handle->flags & UV_HANDLE_CLOSING)`，把一次通过的
运行报成崩溃（退出码 `0xC0000409`）。改成 `process.exitCode = …`，并在收尾前 `await reader.cancel()`
关掉 SSE 流。② **不要用 PowerShell 重写这些文件**：`Set-Content -Encoding utf8` 会加 BOM，
而「手动去掉 BOM」的 `Substring(1)` 会把 `/**` 开头的 `/` 一起吃掉（当时三个探针全变成 `**` 开头）。
要改就用编辑工具。③ 探针的**预期值依赖 profile**（`probe-panel-writes` 断言 `allowCancel: false`
的拒绝，`probe-panel-abort` 需要它为 true）：现在前者会先探测开关状态，不符就打印 `SKIP`
而不是 FAIL——测试配置是 `allowCancel: true`（这样面板上的「中止构建」可用），SPEC 默认仍是 false。

**卡片三样新东西也已实测通过**（`.e2e/probe-card-extras.mjs`，21 项）：`/favorites` 上 Maven job
给出 `mavenVersion: "1.4.2"`、非 Maven 的 job 是 `undefined`；SSE 帧里正在跑的构建带着
`changes`（最新在前，≤3 条）与 `changeCount`；点「重新构建」那条路（读该构建的 `parameters`
→ 触发）在参数化 job 上走通，**新构建报回来的参数与旧构建一致**（stub 会把收到的参数存进构建，
所以这件事是被断言的而不是假设的）。Maven 版本号能否拿到是**先在真机上读出来的**
（`.e2e/probe-maven-version.mjs` / `probe-maven-shape.mjs`，只读、不触发任何构建）：
`mavenArtifacts/api/json` 对 Maven 返回 200 且有个 `moduleRecords[].mainArtifact.version`
（实测到 `1.0.3`、`2.0.9`、`2.0.10-SNAPSHOT`），对 Freestyle 一律 404。

**已知与 SPEC 的有意偏差**（都是因为「关注的 job」这个设计比 SPEC 的「跟踪会话」模型更强，别改回去）：
- `maxTrackedBuilds`（默认 5）**没有强制**：关注列表是用户自己挑的，5 个正在跑的关注 job 是正常场景，
  硬卡上限会让面板少画几条。请求量靠退避和「只跟正在跑的构建」控制。
- SPEC §5.3 的「停止跟踪 / 重新附着」在订阅模型下**不需要单独按钮**：连接即跟踪，断开即停；
  构建的来源是关注列表和队列项，所以不存在「丢了跟踪要手动附着」的状态。
- 「打开 Jenkins」不做：用户明确要求一切都在面板内完成，唯一例外是产物下载。


## 命令

```sh
npm install --ignore-scripts --cache .npm-cache   # 见下方沙箱说明
npm test                                         # tsc + node scripts/run-tests.mjs（7 个 tests/*.ts）
npm run check                                    # test + build + 密钥扫描 + 打包内容审计
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit   # 类型检查
node node_modules/typescript/bin/tsc -p tsconfig.json            # 产物：lib/*.js + lib/**/*.d.ts
node scripts/build-client.mjs                                    # 产物：lib/client.js
```

`npm run build`（= tsc + build-client）在普通 shell 下等价可用；沙箱会话里 `npm run` 会因为 npm 派生脚本进程而失败，用上面的直接调用形式。

### 沙箱注意

受限会话（`workspace-write`）下有三个坑，已在脚本里规避或需按此执行：

1. **npm 缓存默认在工作区外**，会被拒。加 `--cache .npm-cache`。
2. **依赖生命周期脚本会 `spawn EPERM`**。加 `--ignore-scripts`；esbuild 的平台二进制走 optionalDependencies，跳过脚本不影响使用。
3. **`execFile` 与 esbuild 的 JS API 都会失败**：前者内部建管道，后者用管道拉起常驻服务进程。可用的形式是 `spawn(..., { stdio: 'inherit' })` —— `scripts/build-client.mjs` 已按此实现，不要改回 JS API 或 `execFile`。

## 发布（npm + 社区插件市场）

**两条渠道，别混为一谈**：官方只有一个发行渠道——npm registry / git 仓库 / `.tgz`，用户在
**Plugins 页面**或 `dsh plugin add` 安装（`packages/boot/plugin-manager` 只认这四种 spec，源码里
**没有**第一方插件市场）。你听到的「插件市场」是社区目录站
[dsh-plugin.org](https://dsh-plugin.org/zh/submit)（DSH Plugin Hub）与 dshbase.com 之类，站点自己声明
与 DeepSeek 无隶属关系。

已核实的发布事实：

- `dsh-jenkins-plugin` 这个 npm 名**没被占用**（`registry.npmjs.org/dsh-jenkins-plugin` → 404）。
- 社区市场的收录条件（站点原文）：**公开** GitHub 仓库 + 仓库 topic 加 **`dsh-plugin`** +
  README 含安装命令（`dsh plugin --profile web add <包名>`）+ 插件导出 **`apply(ctx)`** + 不冒充官方；
  靠自动扫描收录，提交入口是按它的模板开一个 Issue，收录后先 `unconfirmed`、人工核实后 `verified`。
- git 安装拉的是**源码不是产物**：`package.json` 的 `prepare` 必须能独立构建
  （已配 `"prepare": "npm run build"`），装的人还要在 profile 的 `pnpm-workspace.yaml` 里
  `allowBuilds: dsh-jenkins-plugin: true`。npm 与 tarball 都不需要这一步。
- **`dsh.client.inject` 只列"组合里真有 boot row 的客户端包"**（`locale` / `ui-conversation` /
  `ui-session` / `ui-settings` / `ui-sidebar-right`）。`@deepseek-ai/dsh-client-ui-slots`、
  `dsh-client-store`、`ui-primitives`、`ui-dockkit` 是**模块表基线**（由 shell 自己的 bundle 提供），
  它们**没有独立 boot row**——把 ui-slots 写进 inject 就是让本行等一个永远不来的工厂。这是踩过的：
  最初按"我们注册进 ui-slots 的座位"把它列进去了，`.e2e/probe-boot-inject.mjs` 直接报
  `every injected package has a row of its own: @deepseek-ai/dsh-client-ui-slots`。
  判断依据只能是**组合自己的 boot graph**，不是"我们依赖谁"的直觉。

发布前三道闸（也就是 CI 该跑的三条）：

```sh
npm test                 # tsc + 7 个 tests/*.ts（scripts/run-tests.mjs 汇总，235 项）
npm run check:secrets    # 凭据形状失败、内网主机名/个人绝对路径告警（扫"提交会带上"的文件）
npm run check:payload    # 读 npm pack 的清单：产物齐不齐、有没有把 src/ 或内部笔记打进去
npm pack                 # 出 tarball，先在一个干净 profile 上按 README 的命令装一遍再 publish
```

发布顺序：`npm run check` → 提交并打 `v0.1.0` tag → 公开 GitHub 仓库并加 topic →（干净 profile 验证）
→ `npm login && npm publish` → 用市场模板提交 → 收录后把徽章加进 README。

**还需要人拍板/提供的东西**（当前仓库里故意留空，别自己编）：

- GitHub `owner/repo`：`package.json` 的 `repository`/`homepage`/`bugs` 和 README 的仓库链接都要它。
- 截图：市场的检查清单要求"可见的证明"，README 里 `docs/panel-*.png` 的引用目前是注释掉的占位。
- `LICENSE` 的版权人目前写的是 `dsh-jenkins-plugin contributors`，要换成真人/组织就改这一行。
- 仓库公开范围已定：`AGENTS.md` 与 `SPEC.md` 都随仓库公开，但**内网主机名与个人路径已脱敏**
  （`check:secrets` 会对这两类再 WARN 一次；真正要挡住的是凭据形状，那一类是 FAIL）。

## 工程约定

- 配置字段一律**扁平 camelCase**，且必须是 `Config` 字段（不得硬编码可调值）；模型工具参数名用 **snake_case**。
- 每个模块头部写 JSDoc 说明职责；导出函数写 `@param`/`@returns`。
- 注册一律走 effect：`ctx.effect(() => ctx.webServer.register(...), 'label')`；可选服务用 `ctx.inject([...], cb)`，不要在 `inject` 顶层数组里写只在 Web 组合存在的服务。
- Jenkins 失败统一抛 `JenkinsError`，带稳定 `code`（`config`/`auth`/`not-found`/`network`/`timeout`/`http`）；工具与路由据此给出可读结果。
- 所有上限（日志字节、目录条目、产物大小）施加在**完整结果**上，并在返回值里显式给出「已截断 / 共多少」。
- 凭据只在 Host 内解析（`ctx.credentials.resolve(credentialRef(tokenRef))`，每次调用现取，支持热轮换），绝不进入工具输出、面板、日志或错误信息。

## 不得违反的技术约束

- **不能注册新的客户端 RPC 命名空间**：Client 的远程能力由 `@deepseek-ai/dsh-api-remotes` 在构建期固定（value import 白名单）。面板取数只能走插件自持的同源 HTTP 路由；每个 handler 必须先做浏览器信任守门，参考 `packages/host/open-in-app/src/index.ts`。**注意 `Reflect.get(ctx, 'connection')` 在本插件里会抛异常，不能用**——见下条。
- **Jenkins 的 `tree` 参数必须百分号编码**：`tree=jobs[name,url]` 这种未编码的方括号/逗号，在真实 Jenkins 上直接 **HTTP 400**；编码成 `%5B...%5D` 才是 200（已在真实控制器上实测对照）。
  方括号在 query 里语法上合法，所以各家客户端必须自己约定编码——`src/jenkins/client.ts` 里的 `tree()`
  就是干这个的，**任何新拼的 tree 查询都要过它**。这是 stub 掩盖过的真 bug：stub 不挑食，客户端怎么发都收。
- **可选服务只能用 `ctx.get(name)` 读，不能用 `ctx.connection` / `Reflect.get(ctx, 'connection')`**：cordis 的 context 是 Proxy，读一个没在 `inject` 里声明的属性会**抛** `cannot get property "connection" without inject`（不是返回 `undefined`），而且抛点在 `try/catch` 之外时会被 webserver 兜成 400。`open-in-app` 能写 `connectionOf(ctx)` 是因为它的 `inject` 里同时有 `webServer` 和 `connection`。本插件的 `connection` 是浏览器侧服务，**不能**放进 `inject` 顶层（否则非 Web 组合整个 Host 半加载不了），所以走 `ctx.get('connection')`——cordis 明确文档为「without the inject requirement」，没有时返回 `undefined`，守门自然 fail-closed。见 `src/routes.ts` 的 `trustOf`。
- **浏览器半必须打成 lazy-CJS 工厂**：`window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，`id` 是包名 `dsh-jenkins-plugin`。React / Cordis / `dsh-client-store` / `ui-slots` / `ui-primitives` / `ui-dockkit` 是平台基线模块，必须 external 并用注入的 `require` 解析；其余全部内联。仓库里的 `tsdown.client.ts` 不对外发布，所以本仓库自产这个格式。
- **面板的写操作不能走 `ctx.approval`**：该 seam 要求请求方处于未结束的轮次内，人在面板上的点击不满足。面板写操作用前端二次确认 + `allowTrigger`/`allowCancel` + `denyJobs` 守门；模型侧工具才走审批。
- 客户端依赖只作 `devDependencies`（类型用，`import type` 擦除），`@deepseek-ai/dsh-*` 走 `peerDependencies`，绝不放进 `dependencies`（否则会把整棵 harness 拖进 profile）。`@deepseek-ai/schemastery` 是唯一运行时依赖。

## 运行与验证环境（已探明，别再重新摸一遍）

- **PATH 上没有 `dsh`**，也没有可用的全局安装。已验证可行的取法：装进仓库内的隔离目录
  `npm install --prefix .e2e --ignore-scripts --cache .npm-cache @deepseek-ai/dsh@0.1.6-alpha.2`，
  然后 `node .e2e/node_modules/@deepseek-ai/dsh/lib/bin.js ...`。`.e2e/` 已被 `.gitignore` 忽略。
- **`dsh plugin ...` 必须能 spawn pnpm**：`plugin` 子命令只是把参数转发给 pnpm（`pnpm-runner`）。
  受限沙箱下 pnpm 会 `spawn EPERM`；本机 pnpm 是桌面版的 `harness/.desktop-bin/pnpm.cmd` 包装。
  该命令需要放宽文件沙箱（会写用户级 pnpm store）。
- **Web 服务必须能 bind socket**：受限沙箱下 `dsh web` 报 `listen EACCES`。另外 Windows 在本机
  保留了 `8003-8102`、`7898-7997` 等段（`netsh int ipv4 show excludedportrange protocol=tcp`），
  落在保留段里的端口即使有权限也 bind 不了——**8099/8080/8199 都别用**。已验证可用：stub `18090`、
  web `8137`（早先也用过 `8123`）。
- **`--profile` 的位置有讲究**：`dsh --profile <name> --port <p> ...`（全局 flag 后直接跟 app 自己的
  flag）。`dsh web --profile jenkins-test` 会报 `select a profile only once`，`dsh --profile x web` 会报
  `too many arguments`——`web` 本身就是 `--profile web` 的别名。实测可用的完整形式：
  `node .e2e/node_modules/@deepseek-ai/dsh/lib/bin.js --profile jenkins-test --port 8137 --host 127.0.0.1 --no-open`
  （**不要**再写 `web`）。启动输出的第一行就是带 `?token=<dev-token>` 的地址。
- **别把 `.credentials.yaml` 整个打到终端**：它的键名就是凭据引用名（`refs: { JENKINS_TOKEN_CI: … }`），
  所以「把 key 叫 password/token 的值打码」这种正则根本挡不住——真实泄漏过一次。要看结构就只列键名。
- **测试用隔离 home**：设 `DSH_HOME=<工作区内路径>` 再跑，profile 就落在 `$DSH_HOME/profiles/<name>`，
  不会碰桌面版 home。
- **Harness 源码 checkout 在 `D:\deepseek-harness-master`**（只读参考）。写路由+信任守门时参考
  `packages/host/open-in-app/src/index.ts`（注意它 `inject` 里有 `connection`，见上文约束）。客户端
  bundle 契约的唯一权威是 `packages/client/tsdown.client.ts`；平台基线模块清单在
  `packages/client/web/src/platform.ts`（目前 `PRELOADED_CLIENT_EXTERNALS` 为空）。
- **桌面版的 harness home 是 `%APPDATA%\dsh-desktop\harness`**（`C:\Users\<你>\AppData\Roaming\...`），其 `profiles/desktop`
  由桌面壳独占，公开 CLI 不得管理。
- **静态配置不再是必填**：`baseUrl`/`username` 现在有默认空值，插件能在「什么都没配」的状态下正常加载，
  由面板的配置表单接管（见上文连接模型）。原因：schema 必填会在加载期就失败，那样面板根本没机会
  让用户填。静态配置仍可用，且当面板没有存储设置时生效（优先级最低）。
- **替面板写 token 时不能再从启动环境传 `JENKINS_TOKEN`**：启动环境提供的值是**只读来源**，
  `ctx.credentials.set()` 会直接拒绝并说明「would be shadowed」——这是刻意的防呆，不是 bug。
  要让面板拥有 token，启动时**不要**设该环境变量（设成空串也算未设）。这条也证明了
  「显式配置优先于面板」是真实生效的。
- **凭据来源**：`tokenRef` 默认 `JENKINS_TOKEN`，可从启动环境变量、`$DSH_HOME/.credentials.yaml`、启动目录
  `.env` 或 `$DSH_HOME/.env` 解析；面板写入的是 `.credentials.yaml` 的 `refs`。
- **验证 stub 在 `tests/stub-jenkins.ts`**（Node 原生 http，零依赖，`node tests/stub-jenkins.ts`）。
  它回答 `/api/json?tree=jobs[...]`（含 `lastBuild[...]`）、`/crumbIssuer/api/json`、`/me/api/json`、
  `/<jobPath>/api/json`（含 `{0,N}` 历史）、`/<jobPath>/<n>/api/json`、`/<jobPath>/<n>/wfapi/describe`，
  凭据 `stub-user:stub-token`；另外提供可浏览的 HTML 页面（folder/job/build），供面板链接打开。
  **REST 面要求凭据、HTML 面不要求**——Basic challenge 无法自我说明，罩住 HTML 只会给用户一个猜不出
  密码的弹窗。**Jenkins 的 REST 尾巴是两段**（`api/json` 是 `api` + `json`），且 build 号会打断
  `job/<name>` 交替，所以路径要按「贪心解析后剩下的段数」分派——这是 stub 踩过的两个坑。
- **真实 Jenkins 调试实例（2026-09-24 探明，内网）**：**Jenkins 2.176.2**，
  Basic 认证可用**登录密码**（不必生成 API token）。**主机名与账号密码都不写进仓库**（本文件只留下面的
  机器事实；仓库要公开，所以连主机名也只留在口头/环境变量里）。这台机器上共有 **777 个 job**，全部是
  `FreeStyleProject`（429）+ `MavenModuleSet`（346）+ `MatrixProject`（2），**一个 Pipeline
  (WorkflowJob) 都没有**——所以 `wfapi/describe` 在这台上永远返回 0 阶段，那是正确降级而不是 bug；
  要验 Pipeline 阶段链路只能靠 stub 或另找一台有 Pipeline 的实例。列表响应约 240KB / 777 job。
- **这台 2.176.2 上已实测的读路径**（`jobDetail` 111ms / `buildDetail` 345ms / `consoleLog` 120ms）：
  - 构建历史：`builds[...]{offset,count}` 分页可用，`nextBuildNumber` 能推出总数（5 条/页拿到 `totalBuilds=17`）。
  - 变更集：真实数据很丰富（`ai-eval#6` 有 41 条 commit），`changeSet[items[commitId,author[fullName],msg,...]]` 有效。
  - 产物：`artifacts[fileName,relativePath,displayPath]` **有效**（`android-encrypt-test#52` 有 55 个产物），
    但 **tree 取不到 size**，所以 `JenkinsArtifact.size` 目前恒为 0，面板不能显示大小。
  - **控制台日志：`?start=` 被完全忽略**。实测 `consoleText?start=0` 与 `?start=2048` 返回**完全相同**的
    102664 字节；`X-Text-Size` / `X-More-Data` **两个头部都不存在**（只有 nginx 的 `Content-Length`）。
    也就是说「服务端增量续读」在这台上不成立。因此 `client.consoleLog()` 改为：**从 0 读一个受限窗口，
    在本地切片**；`offset` 在整份日志读得下时精确、读不下时尽力而为。
  - **`x-text-size` 是日志大小，`content-length` 只是本次响应大小**，前者优先。把两者搞反会让我把
    「被截断的短正文」误判成「日志本来就短」——那正是让 tail 返回 head 的原因（已修）。
  - **`maxLogBytes` 与 `logReadBytes` 是两件事**（SPEC §3.4 只定义了前者，后者是本仓库新增的配置字段）：
    前者限制**返回**的字节数，后者限制从控制器**读取**的字节数。因为 `?start=` 无效，用小页大小去读
    会把日志的**开头**当尾巴返回；所以读取窗口必须显著大于页大小（默认 8 MiB）。
  - 测试报告：`testReport/api/json` 对没有测试的构建返回 404 → 我们映射成 `tests: null`（正确）。
  - **工作空间 `/ws/api/json` 在这台上一律 404**：Jenkins 2.176.2 没有 Workspace API（构建页也没有
    任何 workspace 链接）。所以 `client.workspace()` 返回 `{ available: false }` —— **这是缺插件，
    不是我们的 bug**，`jenkins_workspace` 工具必须据此如实说明"该 Jenkins 不支持"。
  - **构建别名只对部分端点有效**：`consoleText` 接受 `last`，但 `<build>/api/json`（构建元数据）
    **不接受**，传 `last` 直接 404。所以客户端先 `resolveBuildNumber()` 把它换成真实号再请求；
    这也能给 `lastSuccessful`/`lastFailed` 统一语义（它们是 job 上的独立字段）。
  - **多实例路由已实测**：`GET/POST /jenkins-plugin/instances`、`POST /probe`、`POST /select`、
    `GET /job`、`GET /build`、`GET /log` 全部走通；**保存是原子的**——列表里只要有一行连不上，
    整次保存被拒且**零写入**（实测：坏的 `stub` 行导致 `failures:["stub"]`，随后 instances 仍是旧值）。
- **HTTP 层端到端自测法**（跑完 `dsh web` 之后，不需要浏览器）：从启动输出里取 `?token=<dev-token>`，
  用 `curl -c cookies.txt -L "http://127.0.0.1:<port>/?token=<tok>"` 换出 `dsh-auth-*` cookie，
  再带 `-b cookies.txt` 请求 `/jenkins-plugin/state`。不带 cookie 应当得到 401。
- **用 PowerShell 给这些路由发 JSON body 的坑**：`curl -d '{"a":1}'` 会被 PS 吃掉引号（服务端报
  `body is not JSON`），`Set-Content -Encoding utf8` 在 PS 5.1 会写成带 BOM 的 UTF-16。可靠写法是
  `node -e "require('fs').writeFileSync(p, JSON.stringify(obj))"` 落文件，再
  `curl --data-binary "@file"`。

## 下一步

已完成：设置页/多实例、面板两个模块（**我关注的**卡片区含进度条 + **所有 job**默认折叠、行内 ☆/★）、
三层下钻（构建历史 → 构建详情含阶段条/内嵌日志/测试/变更集/产物）、
**关注 job 的完成通知**（`src/watch.ts` + `src/follow.ts`）、**面板写操作**（触发/重新构建/中止，
行内二次确认 + `denyJobs`/`allow.*`，**不接** `ctx.approval`）、**触发的构建会自己出现在面板上**
（排队项 → 构建号的重新挂键），以及全部五个模型工具
（`jenkins_jobs` / `jenkins_build` / `jenkins_build_status` / `jenkins_log` / `jenkins_workspace`）。

剩余工作按此顺序：

1. `notifyWakeOnFailure`（`agent.followup()`）：构建失败时唤醒模型。
   **归属问题已经解决，别再重新设计**：`analyze` 路由证明了 `ctx.get('agents')` →
   `agents.get(sessionId)` → `Agent.followup(createUserMessage(...))` 这条链是活的，
   所以 watcher 不需要新机制，缺的只是**把会话 id 记进关注项**（人从哪个会话点的关注就归谁），
   失败时按这个 id 取 agent 排一条提示词（可以直接复用 `src/analyze.ts` 的 `handOverFailure`）。
   注意两点：关注项在**历史会话**里点的也算数，`agents.get()` 返回 undefined 时必须静默放弃
   （会话已结束不是错误）；以及**不要**给同一条构建排两次消息（`NoticeLog` 的键可以复用）。
   没写会话 id 的老关注项按「不唤醒」处理，比猜一个 owner 安全。
2. **HTTP 路由契约**还没固化成仓库内测试：401 守门、`POST /instances` 的原子性（一行连不上则零写入）、
   `favorites` 与 `instances` 共享设置文件时互不覆盖、`/trigger` 与 `/abort` 的 403 形状。
   这一层现在只有 `.e2e` 探针覆盖（跑起来要 stub + dsh web + dev token）。要变成 `tests/*.ts`，
   得先在进程内起一个最小的 host（参考 `tests/console-log.ts` 的假控制器写法），别引入测试框架。
3. 阶段级日志精确切片（SPEC §12 未决项）：依赖 Blue Ocean `execution/node/<id>/wfapi/log`。
   （`consoleText` 的两种控制器行为已经由 `tests/console-log.ts` 的假控制器覆盖，
   stub 端也补了同样不配合的 `consoleText`，这条不再是缺口。）

补功能时注意：
- SPEC 要求角标/历史等可调值全部走 `Config` 字段。
- 面板写操作**不走** `ctx.approval`（人在面板上的点击不在未结束轮次内），所以 `jenkins_build`
  与面板写路径是两套守门，别共用一条。
- **写工具的守门顺序是硬要求**（SPEC §7）：`denyJobs` 与 `allow.*` **先判且无副作用**，再
  `ctx.approval.request()`。实测断言：命中 `denyJobs` 时审批请求数为 **0**。
  `allowCancel` 默认 false，所以默认情况下「中止」是被拒的——这是有意的。
- **两个模块共享同一个设置文件**：实例列表和关注列表都在 `$DSH_HOME/jenkins.json`。
  写任何一边**都必须保留另一边**——已经踩过一次：`POST /instances` 曾把关注列表整个抹掉。
  现在的做法是 `InstanceRegistry.saveInstances()` / `storeFavorites()` 各自读取当前设置再合并，
  **不要再直接调 `replace()` 传一个完整对象**。
- **UI 样式约定**：本仓库的浏览器半由 `scripts/build-client.mjs` 打包，**没有 CSS 管道**，所以
  组件用内联样式 + DSH 设计令牌（`--dsw-alias-*` / `--dsw-font-*` / `--dsw-static-*`），
  不要 `import './x.module.css'`（平台自己的包能这么写，是因为它们走 tsdown + lightningcss）。
  可用令牌清单：在 `D:\deepseek-harness-master\packages\client\**\*.css` 里 grep `var(--dsw-`。
- **「当前」的和「不可用」的不能画成一样**：`Pill` 的 `active`（选中态，用
  `--dsw-alias-state-success-*`：primary 描边+文字、tertiary 底）和 `disabled` 是两件事。
  踩过的坑：面板下方的实例切换器把当前实例同时传了 `disabled`，于是「你正在看的这个」被画成
  半透明的灰胶囊，和旁边可点的实心胶囊相比反而像坏了。现在选中态**保持满不透明度**并配绿色，
  另外保留 `● ` 前缀——颜色不能是唯一的区分手段（色觉障碍下就看不出来了）。





