# dsh-jenkins-plugin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Jenkins 插件：**Web GUI 右侧栏里的实时构建面板**，加上一组面向模型的 Jenkins 工具。

装完之后，你不再需要为了看一次构建进度而切到 Jenkins 页面：关注的 job 变成侧栏里的卡片，进度条实时走，构建结束发通知，失败了一键交给模型分析原因。

<!--
Screenshots are the marketplace's "visible proof" item. Add them here, for example:

![The Jenkins panel: favourite cards with live progress](docs/panel-favorites.png)
![A failed build's card, with rebuild and hand-to-AI](docs/panel-failed.png)
![The Jenkins settings page: instances, probe, save](docs/settings-instances.png)
-->

## 安装

推荐从 npm 安装（预构建产物，不需要任何构建授权）：

```sh
dsh plugin --profile web add dsh-jenkins-plugin
```

装完重启 `dsh web`，打开**设置 → Jenkins** 填一个实例（地址 + 账号 + 密码/API token），Save 之后右栏就会出现 **Jenkins** 面板。

其他安装来源：

```sh
# tarball（离线/内部分发）
dsh plugin --profile web add ./dsh-jenkins-plugin-0.1.0.tgz

# git 源码：需要授权 allowBuilds 让 prepare 脚本构建（pnpm ≥10 默认拒绝）
dsh plugin --profile web add github:<owner>/dsh-jenkins-plugin
```

git 安装拉的是**源码而不是产物**，所以必须在 profile 的 `pnpm-workspace.yaml` 里允许它的准备脚本：

```yaml
allowBuilds:
  dsh-jenkins-plugin: true
```

那等于允许本包代码在安装时于你机器上执行，请只对可信源码授权并锁定 commit（`github:<owner>/dsh-jenkins-plugin#<sha>`）。想省掉这一步就用 npm 或 tarball。

## 你会得到什么

**右栏面板**（侧栏右侧的 **Jenkins** 页签）分两个模块：

- **我关注的** —— 每个关注的 job 一张卡片：状态点、构建号、状态标签、**实时进度条**、当前阶段名、本次构建的变更说明、Maven 项目的版本号（构建结束后可取到时）。卡片直接来自 SSE 推送，不是轮询页面。
- **所有 job** —— 默认折叠，展开后每行末尾的 ☆/★ 一键关注。

点 job 或卡片继续下钻，全程不跳出面板：构建历史（可翻页）→ 构建详情（阶段条、内嵌控制台日志、测试摘要、变更集、产物列表）。产物下载是唯一会打开 Jenkins 页面的动作。

**写操作**都在面板内完成，并且是「按钮 → 行内二次确认 → 执行 → 就地显示结果」：

| 动作 | 说明 |
|---|---|
| 触发构建 | 参数化 job 有参数输入框（每行 `KEY=VALUE`） |
| 重新构建 | 只对失败的构建出现，**沿用上次构建的参数** |
| 中止构建 | `allowCancel` 默认关闭，开启后可用 |
| 交给 AI 分析 | 只对失败的构建出现，把失败日志尾部 + 阶段 + 变更集交给当前会话的模型，答案直接出现在对话里 |

`denyJobs` 里的 job 无论开关怎么设都拒绝，且**一个请求都不会发到 Jenkins**。

**给模型用的工具**（模型可以自己调用，不必你手点）：

| 工具 | 作用 |
|---|---|
| `jenkins_jobs` | 列 job 与状态，可选带最近构建历史 |
| `jenkins_build_status` | 一个构建的结果、耗时、Pipeline 阶段、变更集、测试摘要 |
| `jenkins_log` | 控制台日志，默认取尾部，可按 `next_offset` 续读 |
| `jenkins_workspace` | 构建的工作空间目录或产物列表（读工作空间需要 Jenkins Workspace API 插件） |
| `jenkins_build` | 触发或中止构建（唯一的写工具；先过 `denyJobs`/`allow.*`，再要求操作者审批） |

**多实例**：设置页里可以配多个 Jenkins，逐个「测试连接」通过才允许保存（任何一行连不上则整次保存被拒、零写入）；面板底部可切换实例，当前实例用绿色标出。多实例的实例清单和关注列表存在 `$DSH_HOME/jenkins.json`。

**完成通知**：关注的 job 一有构建结束就用平台的后台作业机制发一次通知，同一次构建只通知一次。

## 权限与风险

装之前请如实了解这个插件会做什么：

- **网络**：只向你配置的 Jenkins 地址发请求，没有别的外联。
- **凭据**：Basic 认证，密码/API token 通过 **DSH 自己的 credentials 服务**存取（`tokenRef` 指向一个凭据引用）。**插件自己的 `jenkins.json` 里只有地址、账号和凭据名，没有密码**，密码也不会出现在工具输出、面板或日志里。
- **写操作**：可以触发和中止构建。`allowTrigger` 默认开、`allowCancel` 默认关，`denyJobs` 可以硬封指定 job（含整个目录）。模型侧调用还要额外经过审批；面板上的点击是行内二次确认 + 同一份策略判定。
- **日志会进入模型上下文**：「交给 AI 分析」和模型自己调 `jenkins_log` 时，**构建日志的内容会作为提示词的一部分送给模型**。Jenkins 日志属于**不可信输入**——它可能包含任意文本（包括试图操纵模型的指令），请按此对待；默认只送失败日志的最后 16 KiB（`analyzeLogBytes`）。
- **本地状态**：`$DSH_HOME/jenkins.json`（实例清单 + 关注列表）、DSH credentials（密码）。
- 插件自己不会触发任何构建：只有你点按钮或模型显式调用才会。

## 兼容性

- **Harness**：针对 `0.1.6-alpha.2` 构建并验证（`package.json` 的 `engines.dsh` 与 peerDependencies 都钉在这个版本）。
- **Node**：与 harness 一致，`^22.19.0 || >=24.0.0`。
- **载体**：面板是 Web GUI 的界面（`dsh web`），在 Web 组合上验证过。
- **Jenkins**：在 **Jenkins 2.176.2** 上实测（FreeStyle 与 Maven job，777 个 job 的实例）。几条如实降级：
  - **Pipeline 阶段**需要 Blue Ocean 的 `wfapi` 端点；2.176.2 且没有 Pipeline job 时阶段列表为空，面板会退化成按耗时估算的进度条——这是"控制器没给阶段"，不是面板坏了。
  - **读工作空间**需要 Jenkins Workspace API 插件；缺失时 `jenkins_workspace` 会如实说明该 Jenkins 不支持。
  - **Maven 版本号**取自 `mavenArtifacts/api/json`，只有 Maven job 有，且真实 2.176.2 上通常在构建**结束后**才产生，所以正在跑的 Maven 构建卡片上可能没有版本号（拿不到就不显示，绝不猜）。
  - **产物没有大小**：Jenkins 的 `tree` 查询取不到 artifact size。
- **已知未完成**：`notifyWakeOnFailure`（失败时唤醒模型）与 `uiAutoOpenOnTrigger`（触发后自动展开面板）两个配置项已接受但**尚未生效**；`maxTrackedBuilds` 只是建议值，不硬性限制跟踪数量（关注列表是用户自己挑的）。

## 配置

静态配置只是**回退层**：面板设置页里配的实例优先，静态配置在没有面板设置时生效（实例 id 为 `config`）。`baseUrl`/`username` 可以留空——那正是"全部在面板里配"的用法。

```yaml
- id: jenkins
  name: dsh-jenkins-plugin
  config:
    baseUrl: https://ci.example.com/jenkins
    username: ci-bot
    tokenRef: JENKINS_TOKEN
    denyJobs: ['infra/*']
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `baseUrl` | 空 | Jenkins 根地址；留空表示只用面板设置 |
| `username` | 空 | 与 token 配对的登录名 |
| `tokenRef` | `JENKINS_TOKEN` | 存放 API token 的凭据引用；每次调用现取，支持热轮换 |
| `settingsFile` | `jenkins.json` | 面板设置文件：绝对路径，或 harness home 下的文件名 |
| `tlsMode` | `verify` | `verify` 校验证书；`allowSelfSigned` 接受不受信任的证书 |
| `tlsCaFile` | — | `verify` 模式下用于校验的自签 CA PEM |
| `timeoutMs` | `15000` | 单个 HTTP 请求的上限 |
| `crumbMode` | `auto` | `auto` 在写请求前取 CSRF crumb；`off` 跳过 |
| `denyJobs` | `[]` | 永不允许触发/中止的 job 路径；`folder/*` 匹配整个目录 |
| `allowTrigger` | `true` | 是否允许触发构建 |
| `allowCancel` | `false` | 是否允许中止构建 |
| `progressIntervalMs` | `3000` | 跟踪构建的阶段轮询间隔 |
| `logIntervalMs` | `1500` | 面板展示的构建的日志轮询间隔 |
| `idleBackoffMaxMs` | `30000` | 没有进展时的退避上限 |
| `queueTimeoutMs` | `300000` | 排队超过多久就报超时 |
| `maxTrackedBuilds` | `5` | 跟踪表的建议上限（不强制） |
| `retainMs` | `600000` | 已结束构建留在跟踪表里的时长 |
| `historyCount` | `10` | 构建历史默认条数（最大 50） |
| `maxLogBytes` | `262144` | 单次控制台日志**返回**的字节上限 |
| `logReadBytes` | `8388608` | 单次从控制器**读取**的日志字节窗口 |
| `maxListingBytes` | `4194304` | 递归列 job 时单次响应的字节上限 |
| `maxWorkspaceEntries` | `500` | 单次工作空间目录列出的条目上限 |
| `maxReadFileBytes` | `1048576` | 单个工作空间文件的读取上限 |
| `notifyOnComplete` | `true` | 关注的构建结束时是否发通知 |
| `notifyWakeOnFailure` | `false` | 失败时唤醒模型（**尚未生效**） |
| `allowAnalyze` | `true` | 是否允许把失败构建交给模型分析 |
| `analyzeLogBytes` | `16384` | 交给模型分析的日志尾部字节数 |
| `uiAutoOpenOnTrigger` | `true` | 触发后自动展开面板（**尚未生效**） |

`maxLogBytes` 和 `logReadBytes` 是两件事，因为真实 Jenkins 会**忽略 `?start=`**：读取窗口必须显著大于页大小，否则拿到的"尾巴"其实是日志开头。这也是本插件按窗口读取、本地切片的原因。

## 开发

```sh
npm install          # 会跑一次 prepare（=构建）
npm run typecheck
npm test             # 235 项断言，无测试框架：每个 tests/*.ts 都是可直接运行的脚本
npm run build        # tsc（Host 半）+ esbuild（浏览器半 → lib/client.js）
npm run check        # test + 密钥扫描 + 打包内容审计
```

浏览器半被构建成客户端模块系统的懒加载工厂（`window.__ModuleLoader__.load({ id, factory })`），React / Cordis / 静态 UI 库保持 external 并通过注入的 `require` 解析，其余全部内联——平台基线模块之外没有运行时依赖。

`tests/stub-jenkins.ts` 是一个零依赖的 stub Jenkins（`node tests/stub-jenkins.ts`），带阶段、失败构建、参数化 Maven job、写端点与队列延迟，用来验证面板的实时链路和写路径而不碰真实控制器。

发布前的三道闸（CI 也是这三条）：

```sh
npm run check:secrets   # 扫"提交会带上的文件"里的凭据形状（内网主机名/个人路径只告警）
npm run check:payload   # 读 npm pack 的清单：产物齐不齐、有没有把 src/ 或内部笔记打进去
npm pack                # 出 tarball，先在一个干净 profile 上装一遍再 publish
```

## 许可证

[MIT](LICENSE)
