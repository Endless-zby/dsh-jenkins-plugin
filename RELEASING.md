# 发布流程

改完代码后照这份清单走一遍即可。每一步都写了**怎么确认成功**，以及失败时怎么处置——
本项目在发布上踩过的坑（npm 的异步窗口、token 档位、staged-only、tag 漂移、README 图片主机）
都已经固化进流程或 `scripts/release-check.mjs`。

范围：官方渠道是 **npm registry**；社区目录是 `dsh-plugin.org` 与 `dsh-pluginmarket/metadata`
（两个都不是官方，见 [AGENTS.md](AGENTS.md) 的发布一节）。

---

## 0. 一次性准备（只做一次）

| 需要什么 | 怎么办 |
|---|---|
| npm token | npmjs.com → Access Tokens → **Granular Access Token**：Expiration 7 天、Packages 选 **All packages**、Permissions 选 **Read and write**（**不是** "Read and write (stage only)"）、**勾上 Bypass 2FA** |
| 临时 npmrc | 内容只有一行引用，**放工作区外**：`%TEMP%\dsh-npm-publish\.npmrc` → `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` |
| token 注入 | 只经进程环境变量：`$env:NPM_TOKEN='npm_...'`，**绝不写进仓库任何文件**（`npm run check:secrets` 每次都会复检） |
| GitHub 推送 | 用本机 git 凭据（开发机上 `github.com` 不通，只有 `api.github.com` 通，所以 push 必须由人执行） |

预检脚本会自己读 `package.json` 判断版本，不需要参数。

---

## 1. 改完代码：先过三道闸

```powershell
cd D:\dsh-jenkins-plugin
npm run check
```

**期望**（三个数字都要对上）：

```
10/10 test files passed                     # 当前 415 项断言
scanned NN tracked file(s): 0 failure(s), 0 warning(s)
The packed payload is complete and carries no repository internals.
```

不绿就**停在这里**，不要进入下一步。`npm test`（只跑断言）、`npm run check:secrets`、
`npm run check:payload` 也可以单独跑，便于定位是哪一类问题。

---

## 2. 定版

```powershell
npm version patch --no-git-tag-version     # 同时改 package.json 与 package-lock.json（实测确认）
```

版本号规则（0.x 阶段）：

| 改了什么 | 用哪个 |
|---|---|
| 只改文档 / README / 打包内容 | `patch`（如 0.1.0 → 0.1.1） |
| 新功能 / 新配置字段生效 | `minor`（如 0.1.1 → 0.2.0） |
| 破坏性变更（字段改名、行为反转） | `major` |

`npm version` 会同时改 lockfile，所以别再用「手改 package.json + `npm install --package-lock-only`」——
手改过一次就会让 `npm ci` 在 CI 上抱怨不同步。

然后提交，**tag 要打在提交之后**：

```powershell
git add -A
git commit -m "Release 0.2.0"
npm run release:check                      # 见下一步
git tag -a v0.2.0 -m "dsh-jenkins-plugin 0.2.0"
```

---

## 3. 预检：这个版本现在能发吗

```powershell
npm run release:check
```

它检查的都是「`npm publish` 成功也照样出事」的项：

- 工作区干净（否则 tarball 不对应任何提交）
- `v<version>` tag 未被占用、该版本**未在注册表上存在**（防重复发布）
- `package.json` 可发布（没有 `private`）、`dsh.bundle.patch` 与 `dsh.client.platform` 都在
- README 里确实有安装命令
- `package-lock.json` 的版本一致、`lib/index.js` 与 `lib/client.js` 是**新构建**的
  （`lib/client.js` 比 `src/client/**` 任何文件都新）
- README 图片是绝对 URL 且不指向 `raw.githubusercontent.com`

全 PASS 才会打印接下来的命令。任何 `BLOCKED` 都不要硬发。

---

## 4. 打包实测（发布前唯一能真装一遍的机会）

```powershell
npm pack                                   # 产出 dsh-jenkins-plugin-<ver>.tgz
$env:DSH_HOME = "D:\dsh-jenkins-plugin\.e2e\publish-home"
$env:DSH_TELEMETRY_DISABLED = "1"
$bin = ".e2e\node_modules\@deepseek-ai\dsh\lib\bin.js"
node $bin --profile pubcheck --from-default-profile web --dump-config   # 建干净 profile（不启动）
node $bin plugin --profile pubcheck add "D:\dsh-jenkins-plugin\dsh-jenkins-plugin-<ver>.tgz"
node $bin --profile pubcheck --port 8145 --host 127.0.0.1 --no-open     # 起来后：
#   另开一个窗口：/jenkins-plugin/state 应为 401（Host 半加载 + 守门在）
```

**装进去的文件应该是**：`lib/ cordis.patch.yml LICENSE package.json README.md README.zh.md`
（没有 `src/`、没有 `doc/`、没有 `AGENTS.md`/`SPEC.md`/`scripts/`）。

---

## 5. 发布

```powershell
$env:NPM_TOKEN = 'npm_...'
npm publish --userconfig "$env:TEMP\dsh-npm-publish\.npmrc"
```

看到 `+ dsh-jenkins-plugin@<ver>` 与
`Your package is being processed and may take a few minutes to become available.` 就是**受理成功**。

> ⚠️ **接下来几分钟里 `dist.tarball` 会 404，这是正常的**。判据是 packument 里
> `time['<ver>']` 出现，不是 tarball 那一下的 404。**不要**在这期间 unpublish 重发——
> unpublish 之后 24 小时内不能重发同一版本，会白烧一个版本号。

---

## 6. 发布后核实（必做，别只看 publish 的退出码）

```powershell
node .e2e/verify-publish.mjs <ver>
```

它轮询到 tarball 真的 200，然后打印：`latest`、文件数、README 里的图片主机计数、
安装命令是否存在，最后**把 README 里每一张图都按真实字节加载一遍**（每张最多试 3 次，
尺寸也打印出来）。**期望**：`latest=<ver>`、`tarball(<ver>)=200`、
`cdn.jsdelivr.net` 计数 = README 里的图片数、`raw.githubusercontent` = 0、
每张图都是 `ok <bytes>` 且退出码 0。

> 图片那一步是**唯一能证明"npm 页面上真的看得到图"的检查**：主机计数只能说明 URL 换了人，
> 说明不了 CDN 那头真有这个文件。CDN 按「文件 + 分支」取件，所以**只有在这次发布新增/更换了
> 图片文件本身时**，才需要先把图片 push 上 `main` 再跑这一步（只改 README 里的引用不必）。
> 任何一张图挂掉脚本就以 1 退出——那就是"npm 页面上一张破图"，比计数不对更严重，别跳过。

再从**注册表**装一遍（不是从本地 tgz，证明装到的就是发布的字节）：

```powershell
Remove-Item "dsh-jenkins-plugin-<ver>.tgz" -Force    # 关键：否则 pnpm 会继续复用 file: 依赖
$env:npm_config_registry = "https://registry.npmjs.org/"
node $bin plugin --profile pubreg add dsh-jenkins-plugin
# 比对 .e2e\publish-home\profiles\pubreg\pnpm-lock.yaml 里的 resolution.integrity
#   与注册表的 dist.integrity 是否一致（一致 = 装到的就是发布的字节）
```

---

## 7. 推到 GitHub

```powershell
git push origin main
git push origin v<ver>
```

**若移动过旧 tag**（amend 之后常见），旧 tag 要多一条 force：

```powershell
git push --force origin v0.1.0        # tag 是新键、无人引用，安全
```

推完可以用 API 核对（`github.com` 从开发机不通，走 `api.github.com`）：

```powershell
node .e2e/check-github.mjs Endless-zby/dsh-jenkins-plugin
```

> 匿名 API 限额是 **60 次/小时**，核对太勤会拿到 `remaining: 0`——那时脚本会打印
> `undefined`/`none`，那不是仓库坏了，等一小时再跑。

CI（`.github/workflows/ci.yml`）会在 push 后自动跑第 1 步的三道闸；README 顶部的徽章是
`img.shields.io`（`github.com/.../badge.svg` 在国内不可达）。

---

## 8. 社区目录站收录（三个独立渠道，能多投就多投）

官方**发行**渠道只有一个：npm / git / `.tgz`（第 5 步）。下面是**社区目录站**，互相独立、
各有各的入口与节奏：

| 目录 / 应用 | 清单来源 | 怎么投 | 生效节奏 |
|---|---|---|---|
| **dshmarket 应用内市场** + awesome-dsh-plugin 站点 | `awesome-dsh-plugin/awesome-dsh-plugin` 的 `data/plugins/*.yml` | **一个插件一个 YAML 文件，开 PR 到上游**（见 §8.1） | 合并后 `main` 重新生成 README；站点/市场通常一天内 |
| `dsh-plugin.org`（DSH Plugin Hub） | 爬虫按 GitHub topic **`dsh-plugin`** 扫描 + 人工复核 | 仓库有 topic 即可被扫到；想催就按模板开 Issue `[插件提交] owner/repo — 一句话价值` | 自述「每日」，未公布具体间隔 |
| `dsh-pluginmarket/metadata`（DSH Registry） | 同一套 topic 扫描 + Issue Form | 用 **Add registry entry** 模板开 Issue（Kind/Name/GitHub repository/npm package/Description/Tags/Submitter），工作流自动开 PR | 维护者合并才发布（实测会长期 open） |

### 8.1 awesome-dsh-plugin —— 市场应用真正读的那个（照这个做）

`dsh-market`（应用内市场插件）的 README 写明：**「这个仓库是市场应用本身，不是插件目录」**，
清单来自 `awesome-dsh-plugin`，要上架**去那边提 PR**。它的 `contributing.md` 规定：
**两个 README 由脚本生成、不要手改**；投稿就是**新增一个文件**，路径
`data/plugins/<owner>__<repo>.yml`（owner 与 repo 之间是**两个下划线**）。一个插件一个文件，
所以永远不会和别人的 PR 冲突。

文件内容（我们的实例）：

```yaml
url: https://github.com/Endless-zby/dsh-jenkins-plugin
name: Endless-zby/dsh-jenkins-plugin
category: dev
description:
  en: Jenkins CI integration with a live build-progress panel in the right sidebar, a multi-instance settings page, five model-facing tools (list jobs, build status, console log, workspace, trigger build), and a failure wake that hands a failed followed build to the conversation that followed it.
  zh: Jenkins CI 集成：右侧栏实时构建进度面板、多实例设置页、五个面向模型的工具（列 job、构建状态、控制台日志、工作区、触发构建），以及构建失败时唤醒当初关注该 job 的那个会话。
```

**硬性要求**（CI 会自动查；提交前逐条自查）：

| 要求 | 怎么确认 |
|---|---|
| `package.json` 声明 **`dsh.bundle`**（只声明 `dsh.client` **不可安装**，最常见被拒原因） | `node -e "console.log(require('./package.json').dsh.bundle)"` |
| 仓库根有 `cordis.patch.yml` | 同目录 `Test-Path cordis.patch.yml` |
| 仓库**创建满 1 天** | `curl -s https://api.github.com/repos/<owner>/<repo>` 看 `created_at` |
| 有 **`dsh-plugin`** topic | 同上响应里的 `topics` |
| 真实可用代码（占位 / 纯 README 不收） | —— |
| `category` 取自固定集合 | `agi ui usage theme model identity session memory tools wsl browser vision voice docs skill git notify dev security remote market fun`（选不贴切不会被打回，维护者会改） |
| 描述**属实**、无营销词 | 写数字 / 命令 / API 名之前先在代码里数一遍——夸大是主要打回原因 |

**步骤**（三条直链，把 `<owner>` 换成你的账号）：

1. **在正确路径新建文件** —— **从仓库根开始**，不要停在 `data/plugins/` 目录里：
   `https://github.com/<owner>/awesome-dsh-plugin/new/main?filename=data/plugins/<owner>__<repo>.yml`
   （`?filename=` 预填路径）→ 粘内容 → Commit。
   *（或者：在 `data/plugins/` 目录页点新建，但文件名只写 `<owner>__<repo>.yml`。两种都行，别同时用。）*
2. **开 PR 到上游**：base 必须是 `awesome-dsh-plugin/awesome-dsh-plugin:main`，head 是你 fork 的分支
   （直接从 fork 的 `main` 提也可以）：
   `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...<owner>:main?expand=1`
3. 按 `.github/pull_request_template.md` 的复选框逐条勾（就是上表）→ **Create pull request**。

**PR 会触发**：`pr-check` / `pr-gate` / `pr-guard`（校验 manifest、仓库年龄、YAML 格式、README 能否
重新生成，并**列出本 PR 动到的既有条目**——所以只许动自己那一个文件）；合并后 `sync-readme` 在
`main` 上重新生成两个 README，站点与应用内市场随后收录。

**只在这个渠道出现的两个坑**（都踩过，详见 [AGENTS.md](AGENTS.md)）：

1. **路径会重复一层**：在 `data/plugins/` 目录页点新建、文件名又写完整路径 → 落成
   `data/plugins/data/plugins/<owner>__<repo>.yml`。YAML 内容全对、位置全错，CI 也不会报错。
2. **PR 的 base 必须指向上游**：提成「自己的 fork ← 自己的分支」是 **fork 内部 PR**，合了也只进
   自己的 fork（`search ... author:<owner>` 会是 0）。修法不是重做，而是拿同一个 commit 再开一个
   base 指向上游的 PR。

**截图（2026-10-09 已声明）**：截图不放进投稿 PR，而是放在**你自己仓库**里 `package.json` 旁的
`screenshots.json` —— 1–8 张、路径**相对该文件**、不能以 `/` 开头或含 `..`，推自己的仓库即生效
（下一次构建自动抓，不用再来提 PR）。本仓库声明的就是 README 里那 6 张（顺序一致）；
**故意不列 `doc/settings-instances-first.png`** —— 那是第一版设置页的留档图，
审计清单（见 [AGENTS.md](AGENTS.md)）里记着它含内网 URL 与真人姓名，不该主动陈列到市场详情页。
不声明也没关系：市场会退化成从 README 自动抽取，声明只是为了控制顺序与取舍。

**我们的记录**：PR [#6942](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6942)，
单文件 `data/plugins/Endless-zby__dsh-jenkins-plugin.yml`（+6 行），base 指向上游、
head 是 `Endless-zby/awesome-dsh-plugin:main`。

收录之后把徽章加进 README 顶部（他们提交页给了模板）。

---

## 9. 收尾

1. **撤销 npm token**（发布完就没用了）。
2. 把结果记进 [AGENTS.md](AGENTS.md) 的「发布进度」：版本、`latest`、验证方式、市场状态。
   这份文档是下一个人的第一手资料，别让它停在旧版本上。

---

## 陷阱速查（症状 → 处置）

| 症状 | 真正原因 | 处置 |
|---|---|---|
| `npm publish` 403，报文要求 2FA | token 没勾 **Bypass 2FA** | 重建 token（页面上的三档权限也要选 "Read and write"） |
| `E_STAGE_REQUIRED` | token 是 **"Read and write (stage only)"** | 换成 "Read and write"；新包无法用 staged 流程引导 |
| publish 受理成功但 tarball 404 | npm 的**异步生成期**（几分钟） | 等 `time[<ver>]` 出现；**别 unpublish** |
| `npm ci` 报不同步 | `package.json` 与 lock 的 version 不一致 | 用 `npm version` 改版本；已手改就 `npm install --package-lock-only` |
| 旧 tag 指向别的提交 | amend 后没移动 tag | `git tag -d v<旧>` → 重建 → `git push --force origin v<旧>` |
| npm 页面上的截图是坏图 | 相对路径，或图片主机在读者网络不可达 | 绝对 URL + jsDelivr；`release:check` 会挡 `raw.githubusercontent` |
| README 截图泄漏内部信息 | 用了真机截图 | 只用 stub 实例重截（清单见 AGENTS.md「README 截图必须先审计再提交」） |
| CI 从来没跑过 | workflow 有 YAML 语法错 | `node .e2e/check-workflow.mjs` 先本地解析一遍 |
| 市场搜不到 | 仓库缺 `dsh-plugin` topic | 加上 topic，再等一个扫描周期 |
| 市场 PR 的内容明明是对的却没人理 | 路径重复了一层（`data/plugins/data/plugins/…`） | 从仓库根新建，或用 `?filename=` 直链 |
| 开了 PR 但上游搜不到你的提交 | base 选成了自己的 fork（fork 内部 PR） | 用同一个 commit 重开一个 base 指向上游的 PR |
| awesome-dsh-plugin 的 CI 卡住 | `dsh.bundle` 没声明，或仓库不满 1 天 | 两者都是 CI 自动查的；补上再提 |
| `check:secrets` 报警 | 追踪文件里出现凭据形状 / 内网主机名 / 个人绝对路径 | 前者必须修；后两者是"要不要公开"的决定 |

## 只有人能做的三件事

1. **给 npm token**（我只把它经环境变量传给 npm，不落盘）；
2. **执行 `git push`**（开发机到 `github.com` 不通）；
3. **撤销 token**。

其余（跑闸、定版、提交、打 tag、预检、打包实测、发布、注册表复验、API 核对）都可以按上面照做。
