# AGENTS.md — dsh-jenkins-plugin

DeepSeek Harness 的 Jenkins 插件：Web GUI 里的实时构建进度面板 + 面向模型的构建工具。

**功能基线是 [SPEC.md](SPEC.md)，功能范围以它为准。** 本文件只管工程约定、当前状态和下一步。

## 当前状态

已完成（垂直切片，链路已通但尚未装进 profile 实跑）：

- `src/config.ts` — SPEC §3 全部 24 个配置字段 + schemastery 校验 + `denyJobs` 匹配。
- `src/jenkins/client.ts` — REST 客户端：Basic 认证、crumb 缓存、自签证书/自定义 CA、超时、字节上限、folder 递归列举。
- `src/jenkins/types.ts` — 归一化领域类型 + Jenkins color → 状态映射。
- `src/tools/jobs.ts` — `jenkins_jobs`（含历史、截断上报）。
- `src/routes.ts` — `/jenkins-plugin/state`，handler 内先做浏览器信任守门。
- `src/client/*` — 会话头部面板（打开时拉状态、渲染 job 列表）。

未完成（SPEC §4/§5/§6/§8 的其余部分）：`jenkins_build`、`jenkins_build_status`、`jenkins_log`、`jenkins_workspace`、跟踪表与轮询器、SSE 实时阶段与日志、右侧栏面板（`sidebar.right.pane.tab`）、后台作业与完成通知、`denyJobs` 与审批接入、stub Jenkins 测试。

**尚未验证**：插件从未真正 `dsh plugin add` 进任何 profile，也没在浏览器里渲染过。

## 命令

```sh
npm install --ignore-scripts --cache .npm-cache   # 见下方沙箱说明
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

## 工程约定

- 配置字段一律**扁平 camelCase**，且必须是 `Config` 字段（不得硬编码可调值）；模型工具参数名用 **snake_case**。
- 每个模块头部写 JSDoc 说明职责；导出函数写 `@param`/`@returns`。
- 注册一律走 effect：`ctx.effect(() => ctx.webServer.register(...), 'label')`；可选服务用 `ctx.inject([...], cb)`，不要在 `inject` 顶层数组里写只在 Web 组合存在的服务。
- Jenkins 失败统一抛 `JenkinsError`，带稳定 `code`（`config`/`auth`/`not-found`/`network`/`timeout`/`http`）；工具与路由据此给出可读结果。
- 所有上限（日志字节、目录条目、产物大小）施加在**完整结果**上，并在返回值里显式给出「已截断 / 共多少」。
- 凭据只在 Host 内解析（`ctx.credentials.resolve(credentialRef(tokenRef))`，每次调用现取，支持热轮换），绝不进入工具输出、面板、日志或错误信息。

## 不得违反的技术约束

- **不能注册新的客户端 RPC 命名空间**：Client 的远程能力由 `@deepseek-ai/dsh-api-remotes` 在构建期固定（value import 白名单）。面板取数只能走插件自持的同源 HTTP 路由；每个 handler 必须先调 `ctx.connection.requestRejection(req)`（用 `Reflect.get` 读，避免硬依赖浏览器侧包），参考 `packages/host/open-in-app/src/index.ts`。
- **浏览器半必须打成 lazy-CJS 工厂**：`window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，`id` 是包名 `dsh-jenkins-plugin`。React / Cordis / `dsh-client-store` / `ui-slots` / `ui-primitives` / `ui-dockkit` 是平台基线模块，必须 external 并用注入的 `require` 解析；其余全部内联。仓库里的 `tsdown.client.ts` 不对外发布，所以本仓库自产这个格式。
- **面板的写操作不能走 `ctx.approval`**：该 seam 要求请求方处于未结束的轮次内，人在面板上的点击不满足。面板写操作用前端二次确认 + `allowTrigger`/`allowCancel` + `denyJobs` 守门；模型侧工具才走审批。
- 客户端依赖只作 `devDependencies`（类型用，`import type` 擦除），`@deepseek-ai/dsh-*` 走 `peerDependencies`，绝不放进 `dependencies`（否则会把整棵 harness 拖进 profile）。`@deepseek-ai/schemastery` 是唯一运行时依赖。

## 下一步

1. `dsh plugin --profile <测试 profile> add D:\dsh-jenkins-plugin`，确认能加载；用 `dsh --profile <name> --dump-config` 看层。
2. 起一个 dsh web，确认会话头部出现 Jenkins 按钮、点开能看到 job 列表（这是整条链路第一次端到端验证）。
3. 补 `jenkins_build`（trigger/cancel，走审批）、`jenkins_build_status`（阶段+变更集+测试）、`jenkins_log`、`jenkins_workspace`。
4. 跟踪表 + 轮询器（退避、无订阅者不轮询、只有选中构建拉日志）+ SSE 路由 + 右侧栏面板。
5. 后台作业与完成通知、`notifyWakeOnFailure`、stub Jenkins 契约测试。
