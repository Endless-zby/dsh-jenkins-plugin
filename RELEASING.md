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
9/9 test files passed                       # 当前 332 项断言
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

## 8. 社区市场（只在首次收录或需要改元数据时做）

| 市场 | 机制 | 动作 |
|---|---|---|
| `dsh-plugin.org`（DSH Plugin Hub） | 爬虫按 GitHub topic **`dsh-plugin`** 扫描；人工复核看 Issue | 仓库 About → 齿轮 → Topics 里必须有 `dsh-plugin`；提交用 `[插件提交] owner/repo — 一句话价值` 开 Issue |
| `dsh-pluginmarket/metadata`（DSH Registry） | weekly 扫描器同样按 topic 自动开 `Add:` Issue；工作流校验后自动开 PR，维护者合并才发布 | 想快就自己用 **Add registry entry** 模板开 Issue（Kind/Name/GitHub repository/npm package/Description/Tags/Submitter），然后盯 PR 合并 |

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
| `check:secrets` 报警 | 追踪文件里出现凭据形状 / 内网主机名 / 个人绝对路径 | 前者必须修；后两者是"要不要公开"的决定 |

## 只有人能做的三件事

1. **给 npm token**（我只把它经环境变量传给 npm，不落盘）；
2. **执行 `git push`**（开发机到 `github.com` 不通）；
3. **撤销 token**。

其余（跑闸、定版、提交、打 tag、预检、打包实测、发布、注册表复验、API 核对）都可以按上面照做。
