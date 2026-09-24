# dsh-jenkins-plugin 功能规格（已冻结）

本文件是 Jenkins 插件的功能基线。功能范围以本文件为准；实现细节（模块划分、构建脚本）不在本文件约束内。

## 1. 交付形态与运行环境

| 项 | 决定 |
|---|---|
| 形态 | 独立插件包（bundle），通过 `dsh plugin --profile <name> add <包名\|tarball\|本地路径>` 安装 |
| 组成 | Host 半（`src/`）+ 浏览器半（`src/client/`），一个包两个导出 |
| 目标环境 | `dsh web` profile；单 Jenkins 实例；Pipeline（workflow）流水线；API token 认证 |
| 不保证 | Electron 桌面载体（其客户端 bundle 走 IPC 桥而非同源 HTTP）；非 Pipeline 的 Freestyle job 无阶段信息 |

## 2. 术语与状态模型

- **Job 路径**：`folder/sub/job` 形式，所有工具参数与面板显示统一使用该形式。
- **构建引用**：`<jobPath>#<buildNumber>`；`buildNumber` 额外接受 `last`、`lastSuccessful`、`lastFailed` 别名。
- **跟踪记录（Tracking）**：Host 内存持有的 `{ trackingId, sessionId, jobPath, queueId?, buildNumber?, state, result? }`。**不写 session log**，零 replay 成本。
- **跟踪状态**：`queued` → `running` → `finished`（含 `success` / `failure` / `aborted` / `unstable`）；另有 `detached`（失联）、`stopped`（人主动停止跟踪）。
- **进度**：阶段计数比（已完成阶段 / 总阶段）。Jenkins 不提供时间百分比，不估算剩余时间。

## 3. 配置面

全部字段为 Cordis `Config`，可在 `cordis.yml`、profile 补丁或用户 patch 中覆盖。任何部署可能不同的取值都必须是字段，不得硬编码。配置字段名为扁平 camelCase；模型工具的参数名为 snake_case。

### 3.1 连接

| 字段 | 含义 | 默认 |
|---|---|---|
| `baseUrl` | Jenkins 根地址 | 必填 |
| `username` | 登录用户名 | 必填 |
| `tokenRef` | `ctx.credentials` 引用名；配置文件不含明文 | `JENKINS_TOKEN` |
| `tlsMode` | `verify` / `allowSelfSigned` | `verify` |
| `tlsCaFile` | 自定义 CA 文件路径（`verify` 模式下可选） | 空 |
| `timeoutMs` | 单次 HTTP 请求超时 | `15000` |
| `crumbMode` | `auto` / `off` | `auto` |

### 3.2 可操作范围

| 字段 | 含义 | 默认 |
|---|---|---|
| `denyJobs` | 黑名单：匹配的 job 一律不可触发/中止。支持精确路径与 `folder/*` 前缀 | 空（即不限制） |
| `allowTrigger` | 允许触发构建 | `true` |
| `allowCancel` | 允许中止构建 | `false` |

> 已确认不设白名单，默认全开；`denyJobs` 与写操作强制审批是两个补偿项。

### 3.3 轮询与节流

| 字段 | 含义 | 默认 |
|---|---|---|
| `progressIntervalMs` | 活跃构建的阶段轮询间隔 | `3000` |
| `logIntervalMs` | 日志增量拉取间隔（仅面板当前选中构建） | `1500` |
| `idleBackoffMaxMs` | 连续无进展时的退避上限 | `30000` |
| `queueTimeoutMs` | 排队等待分配 build 号的超时 | `300000` |
| `maxTrackedBuilds` | 单会话并行跟踪上限 | `5` |
| `retainMs` | 构建结束后保留跟踪记录的时长 | `600000` |
| `historyCount` | 构建历史列表每次拉取条数（上限 50） | `10` |

### 3.4 边界

| 字段 | 含义 | 默认 |
|---|---|---|
| `maxLogBytes` | 单次日志返回字节上限 | `262144` |
| `maxWorkspaceEntries` | 单次目录列举条目上限 | `500` |
| `maxReadFileBytes` | 单次工作空间文件读取字节上限 | `1048576` |

### 3.5 行为与界面

| 字段 | 含义 | 默认 |
|---|---|---|
| `notifyOnComplete` | 构建结束后向会话注入一条通知 | `true` |
| `notifyWakeOnFailure` | 构建失败时用 `agent.followup()` 主动唤醒模型 | `false` |
| `uiAutoOpenOnTrigger` | 模型或人在本会话触发构建时自动打开面板 | `true` |

## 4. 模型工具面（5 个工具）

### 4.1 `jenkins_jobs` — 发现与历史

| 参数 | 必填 | 含义 |
|---|---|---|
| `query` | 否 | 名称/路径子串过滤 |
| `folder` | 否 | 限定在该 folder 下递归 |
| `include_history` | 否 | 是否附带最近构建 |
| `history_count` | 否 | 历史条数（默认取配置，上限 50） |

返回：`{ jobs: [{ path, name, url, color, lastBuild?: { number, result, timestamp, duration, building }, recentBuilds?: [...] }] }`

### 4.2 `jenkins_build` — 写操作（触发与中止）

| 参数 | 必填 | 含义 |
|---|---|---|
| `job` | 是 | job 路径 |
| `action` | 否 | `trigger`（默认）/ `cancel` |
| `parameters` | 否 | 参数化构建参数（`action: trigger`） |
| `build_number` | 否 | `action: cancel` 的目标（默认 `last`） |
| `wait` | 否 | 前台等到结束；默认 `false` 立即返回跟踪句柄 |

返回：`{ trackingId, jobPath, queueId?, buildNumber?, state, url }`

行为：触发后先进入 `queued` 跟踪，拿到 build 号后转 `running`；`wait: true` 时阻塞至结束或超时。
守门：`trigger` 与 `cancel` **都经 `ctx.approval.request()`**，并分别受 `allow.trigger` / `allow.cancel` 约束；命中 `denyJobs` 直接拒绝，不请求审批。

### 4.3 `jenkins_build_status` — 状态 + 阶段（+ 变更集/测试）

| 参数 | 必填 | 含义 |
|---|---|---|
| `job` | 是 | job 路径 |
| `build_number` | 否 | 默认 `last` |
| `include_stages` | 否 | 默认 `true` |
| `include_changes` | 否 | 默认 `false` |
| `include_tests` | 否 | 默认 `false` |

返回：`{ jobPath, buildNumber, result, building, timestamp, duration, estimatedDuration?, url, stages?: [{ name, status, startedAt, durationMs }], progress?: { completed, total }, changes?: [{ commitId, author, message, timestamp }], tests?: { total, failed, skipped, passed } | null }`

阶段状态取值：`NOT_EXECUTED` / `PENDING` / `IN_PROGRESS` / `PAUSED` / `SUCCESS` / `FAILED` / `ABORTED` / `UNSTABLE`。
无测试报告时 `tests: null` 并在 `render` 中说明，不视为错误。

### 4.4 `jenkins_log` — 控制台日志

| 参数 | 必填 | 含义 |
|---|---|---|
| `job` | 是 | job 路径 |
| `build_number` | 否 | 默认 `last` |
| `tail_lines` | 否 | 取末尾 N 行（默认 200，上限 2000） |
| `offset` | 否 | 字节偏移，用于增量续读 |

返回：`{ text, nextOffset, moreData, truncated, totalSize? }`

`offset` 失效（Jenkins 重启或日志被裁剪）时自动全量重拉，并在结果中标记事实。

### 4.5 `jenkins_workspace` — 工作空间与产物

| 参数 | 必填 | 含义 |
|---|---|---|
| `job` | 是 | job 路径 |
| `build_number` | 否 | 默认 `last` |
| `kind` | 否 | `workspace`（默认）/ `artifact` |
| `action` | 否 | `list`（默认）/ `read` |
| `path` | 否 | 相对根路径（list 的目录、read 的文件） |

返回：
- `list` + `workspace`：`{ entries: [{ name, path, type, size, url }], truncated, total }`
- `read` + `workspace`：`{ path, size, text?, url, truncated }`；二进制只返回元信息与 URL
- `list` + `artifact`：`{ artifacts: [{ name, path, size, url }] }`

**产物只列与给链接，不落盘**（首版决定）。`action: read` 对 `kind: artifact` 不支持。
路径限定在该构建的 workspace 根内，拒绝 `..`、绝对路径与越界符号链接。

## 5. 浏览器面板

### 5.1 挂载点

| Slot | 用途 |
|---|---|
| `sidebar.right.pane.tab`（keyed，key `jenkins-build`）+ `sidebar.right.pane.tab.title` | 面板主体与页签标题 |
| `conversation.session.header.actions`（list，id `jenkins-build`） | 会话头部入口 + 运行中构建数角标 |

注册一律走 `ctx.slots.inject(key, () => ctx.slots.register(...))`；向未声明 slot 注册会失败。

### 5.2 视图

**构建列表**：本会话跟踪的全部构建（并行），每行显示 job 名、`#build`、状态、已耗时。

**选中构建详情**，四个区块：

| 区块 | 内容 |
|---|---|
| 头部 | job 路径、`#build`、状态徽章、已耗时、触发原因、打开 Jenkins 链接 |
| 阶段进度条 | 每个 stage 的状态与耗时，当前阶段高亮；总体进度 = 已完成/总阶段 |
| 日志窗 | 控制台日志尾部实时跟随；暂停/继续、复制、打开完整日志 |
| 结果区 | 结果横幅；变更集（提交者/提交信息）；测试结果摘要（总数/失败/跳过）；产物列表（名称、大小、Jenkins 直链） |

### 5.3 操作

| 操作 | 说明 |
|---|---|
| 触发构建 | 选 job（可搜索）+ 填参数；**前端二次确认** |
| 重新构建 | 沿用上次参数；**前端二次确认** |
| 中止构建 | **前端二次确认**；受 `allow.cancel` 约束 |
| 停止跟踪 | 仅停止面板跟踪，不中止 Jenkins 构建 |
| 重新附着 | 从历史列表选一个构建，或直接输入 `job#number` |
| 打开 Jenkins | 浏览器新标签打开构建页 |

面板的写操作**不走 `ctx.approval`**——该 seam 要求请求方处于未结束的轮次内，人在面板上的点击不满足。因此面板写操作的守门是「前端二次确认 + `allow.*` 配置开关 + `denyJobs`」。

### 5.4 空态与失联

- 空态：列出可操作的 job（搜索框）+ 当前 job 的构建历史（`historyCount` 条），可直接点入查看或附着。
- DSH 进程重启后：跟踪记录丢失，面板显示「已失联」，提供按 `job#build` 重新附着的入口。
- Jenkins 不可达：断连横幅 + 手动重试；已停止轮询。

### 5.5 数据通道

Host 注册同源 HTTP 路由（`/jenkins-plugin/*`），每个 handler 先调 `ctx.connection.requestRejection(req)` 做信任与认证守门；面板经 SSE 订阅。

消息类型：`snapshot`（全量：构建列表 + 选中构建详情）、`stage`（阶段变更）、`log`（增量文本）、`result`（结束 + 变更集/测试/产物）、`error`（失联/认证失败）。

触发、重跑、中止、重新附着经同源 POST 路由；SSE 断线重连后由 Host 重放当前快照。

## 6. 会话内推送

| 档 | 机制 | 默认 |
|---|---|---|
| 完成通知 | 后台作业完成通知（现有机制，一次，含结果摘要） | 开（`notify.onComplete`） |
| 失败唤醒 | `agent.followup()` 开一轮让模型分析 | 关（`notify.wakeOnFailure`） |
| 逐阶段进度 | **不推送**，只在面板显示 | — |

逐阶段进度不进会话日志、不进模型上下文，避免 token 成本与日志膨胀。

## 7. 权限与安全

| 项 | 规则 |
|---|---|
| 模型触发的写操作 | `ctx.approval.request()`；会话策略为 `never` 时确定性拒绝 |
| 面板触发的写操作 | 前端二次确认 + `allow.*` + `denyJobs` |
| 凭据 | 只在 Host 内解析；工具输出、面板、日志、错误信息均不含 token |
| 面板路由 | `ctx.connection.requestRejection(req)` 守门；默认只绑 loopback |
| 工作空间读取 | 限定构建 workspace 根内，防路径穿越 |
| 审批与写开关的顺序 | 先判 `denyJobs` 与 `allow.*`（无副作用地拒绝），再请求审批 |

## 8. 生命周期与恢复

1. **触发** → 建跟踪记录（`queued`）→ 轮询队列项 → 取到 build 号 → `running`。
2. **运行中** → 按 `progressIntervalMs` 拉阶段；面板选中该构建时按 `logIntervalMs` 拉日志增量。
3. **结束** → `finished` + 结果；发完成通知；`wakeOnFailure` 开启且失败时 `followup`。
4. **保留** → `retainMs` 后回收跟踪记录（面板行移除，构建仍在 Jenkins）。
5. **DSH 重启** → 跟踪丢失，面板失联并可手动重新附着。
6. **Jenkins 重启** → 日志 offset 失效，自动全量重拉；队列跟踪改为按 job 的最近构建重试发现。

## 9. 错误与边界行为

| 情况 | 工具返回 | 面板 | 重试 |
|---|---|---|---|
| 401/403 | 认证错误 + 指向 `tokenRef` | 红色横幅 | 否 |
| 404 job/build | 明确「不存在」 | 空态提示 | 否 |
| crumb 失效 | — | — | 自动重取 crumb 重试一次 |
| TLS / 不可达 | 连接错误 + `baseUrl` | 断连横幅 | 退避重试 |
| 排队超时 | queueId + 超时事实 | 「仍在排队」 | 继续跟踪 |
| 日志被裁剪/轮转 | 可得区间 + `truncated` | 「日志不完整」 | 全量重拉 |
| 目录/文件超限 | 结果 + `truncated` + 总数 | 「已截断」 | 否 |
| 路径越界 / 二进制 read | 拒绝或仅元信息 | 提示 | 否 |
| 无测试报告 | `tests: null` | 「无测试报告」 | 否 |
| 命中 `denyJobs` | 拒绝 + 原因 | 提示不可操作 | 否 |
| 审批被拒 | 拒绝结果（非 `isError` 的领域结果按需区分） | — | 否 |

统一边界规则：所有上限施加在**完整结果**上，并在结果中显式给出「已截断 / 共多少」的事实。

## 10. 非功能要求

- **无订阅者不轮询**：SSE 无活跃连接时暂停全部轮询。
- **日志只跟一个**：仅面板当前选中的构建拉日志，其余构建只拉阶段。
- **退避**：连续无阶段变化时按倍数退避至 `idleBackoffMaxMs`。
- **并发上限**：单会话并行跟踪不超过 `maxTrackedBuilds`，超出时拒绝新建跟踪并说明。
- **凭据热更新**：轮换 `tokenRef` 指向的值无需重启。

## 11. 分期

### P0（第一个可用版本）
包骨架与配置、凭据解析、5 个模型工具、后台作业与完成通知、`wakeOnFailure`（默认关）、面板（列表/详情/阶段/日志/结果区含变更集与测试摘要/构建历史列表）、多构建并行跟踪、手动重新附着、SSE 数据通道、写操作审批与 `denyJobs`、Jenkins stub 契约测试。

### P1
产物落盘下载、阶段级日志精确切片（依赖 Blue Ocean `execution/node/<id>/wfapi/log`）、跟踪记录持久化以支持自动恢复、Freestyle job 的降级展示。

### P2
多 Jenkins 实例、Jenkins 反向 webhook 推进会话、Electron 桌面载体适配。

### P0 验收标准
1. 会话内让模型触发一个 Pipeline 构建后，面板自动出现并在 `progressIntervalMs` 内反映阶段变化。
2. 面板日志在 `logIntervalMs` 内增量跟随，无重复行、无丢行。
3. 构建结束后出现完成通知；同一次构建只通知一次。
4. `denyJobs` 命中的 job 无法触发，且不产生审批请求。
5. 审批被拒时构建不触发，会话收到明确拒绝事实。
6. 同一会话并行跟踪 5 个构建时，只有选中构建拉日志。
7. 无浏览器订阅时，Jenkins 侧无轮询请求。
8. DSH 重启后可按 `job#build` 重新附着并恢复阶段与结果展示。
9. 工作空间路径越界请求被拒绝。
10. 产物只返回列表与直链，本地磁盘无新增文件。

## 12. 未决事项

| 项 | 说明 |
|---|---|
| 包名与 npm scope | 独立发布需确定包名（如 `dsh-jenkins-plugin` 或 `<scope>/dsh-jenkins`） |
| 依赖版本对齐 | 本机 dsh 为 `0.1.6-alpha.2`，npm 上 `@deepseek-ai/dsh-*` 最新为 `0.1.7-rc.1`；需锁定与安装目标一致的版本 |
| 阶段级日志切片 | 依赖 Blue Ocean REST，接口稳定性需实测后决定是否提前到 P0 |
| 跟踪持久化 | 是否用 domain KV storage 实现自动恢复（当前 P0 为手动重新附着） |
| 独立仓库位置 | 插件代码放在本仓库还是独立仓库 |
