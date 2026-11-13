# dsh-disk-cleanup

给临时文件一个专用目录：shell 命令里的临时目录与包管理器缓存默认落在工作区之外，scratch 目录在需要时补齐写权限，系统提示告诉模型临时文件该写哪里，过期的临时文件到点自动清掉。用户要保留的文件照旧留在工作区。

DSH 本身没有「临时文件目录」这个概念；模型写出的探针脚本、包管理器建出的依赖缓存默认都落在工作区内。这个插件提供统一的环境注入、scratch 目录授权、一段系统提示和一份过期清理，让临时文件有地方可去、也不会越攒越多。

## 它做什么

四条机制：

| 机制 | 覆盖的情况 | 做法 |
|---|---|---|
| shell 环境注入 | 脚本内部用 `tempfile` / `[System.IO.Path]::GetTempPath()` 之类，以及 `pnpm install` / `bun install` / `uv sync` 在工作区留下缓存 | 在 `pwsh` / `bash` 命令串前设置 `TMP` / `TEMP` / `TMPDIR`，并注入包管理器缓存变量，缓存一律进 `<DSH_HOME>/cache/<工具>` |
| 权限补齐 | workspace-write 下 scratch 目录对受限子进程不可写 | 给会话注册可写根 + 给目录补访问控制项 |
| 系统提示 | 模型不知道该往哪写 | 加一段祈使句，点明 scratch 位置、临时文件写那儿、用户文件留在工作区；路径每次构建时现算，只读会话不出这段 |
| 过期清理 | scratch 只增不减，旧探针脚本一直留着 | 插件加载时扫一遍 `<DSH_HOME>/cache/scratch`，删掉超过保留天数没改动过的条目；之后每 6 小时最多再扫一次 |

不改写任何工具入参的路径：模型给什么路径就写什么路径。要不要把临时文件放进 scratch 由提示词引导，不由插件替模型决定。

## 落点规则

| 权限模式 | scratch 目录 | 怎么让它可写 |
|---|---|---|
| workspace-write | `<DSH_HOME>/cache/scratch` | 给会话注册可写根（文件工具）+ 给目录补访问控制项（子进程） |
| danger-full-access | `<DSH_HOME>/cache/scratch` | 不需要，本来就能写 |
| read-only | 不启用 | —— |

`<DSH_HOME>` 默认 `~/.dsh`，跟随 `DSH_HOME` 环境变量。**所有可写模式都用同一个位置**，工作区只留用户要的文件。

workspace-write 下写到工作区外面需要两步授权，插件在会话创建时（`agent/created`，此时权限模式已确定）就完成：

1. `sandboxPolicy.registerWritableRoot(session, dir)` —— 让文件工具能写这个目录。
2. `AclWriteGrant`（Windows）—— 用工作区自己的安全标识给目录加一条可写项，受限子进程也能写。

第 2 步只在 Windows 上做，且复用工作区的安全标识，所以不需要新身份、也不会放宽到别的目录。加在目录上的访问控制项是 **standing（常驻）** 的，和 DSH 自己处理可写目录一致：插件卸载时只释放授权对象，不删这条访问控制项，否则下一个会话写 scratch 会被挡回去。任何一步失败就整体退到 `<工作区>/cache/scratch`，不弹审批、不静默失败。

## 过期清理

只清 `<DSH_HOME>/cache/scratch`，也就是插件自己定的那个落点：

- **删什么**：`cache/scratch` 下的顶层条目，最后修改时间早于「现在减保留天数」的才删；目录整个删掉，含里面的内容。
- **不删什么**：包管理器缓存（`cache/pnpm`、`cache/bun`、`cache/uv`、`cache/npm`）一个都不碰——那是硬链接仓库，删了会让已装的项目失效。配置里自己指了 `scratchDir` 的，那个目录也不自动清，里面的东西未必可丢。
- **怎么算过期**：看条目自己的最后修改时间，不看访问时间（Windows 默认不更新访问时间）。目录里某个子文件刚被写过，目录的修改时间会一并刷新，正在用的工作目录不会被误删。
- **何时清**：插件加载时一次，之后每 6 小时最多一次（节流），不落状态文件。进程重启等于重新起算。
- **单个条目删不掉**（Windows 上被别的进程占着）就跳过，不中断整批。

保留天数可以在插件页的「过期清理」卡片里改：关掉开关就不清，天数留空恢复默认的 7 天。

## 运行时缓存

启动时在 `PATH` 里找 `pnpm` / `bun` / `uv` / `npm`，按 `runtimeCache` 决定接管哪些：

| 取值 | 行为 |
|---|---|
| `auto`（默认） | 只接管**没有现成缓存**的。用户已经有自己缓存位置的，用他自己的，不打扰 |
| `always` | 全部接管，缓存一律进 `<DSH_HOME>/cache` |
| `never` | 一个都不碰 |

`auto` 判的是「用户有没有现成的缓存」，不是「命令在不在 PATH 上」：缓存环境变量已经设了，或者该工具的默认缓存目录已经存在，就算用户有。命令在 PATH 上但一个缓存都没有时仍然接管——我们给的位置就是它第一次写缓存的地方。

接管的工具会被注入这些变量：

| 工具 | 变量 | 判默认位置 |
|---|---|---|
| pnpm | `npm_config_store_dir` / `npm_config_cache_dir` / `npm_config_state_dir` | `%LOCALAPPDATA%\pnpm\store` |
| bun | `BUN_INSTALL_CACHE_DIR` | `~/.bun/install/cache` |
| uv | `UV_CACHE_DIR` | `%LOCALAPPDATA%\uv\cache` |
| npm | `npm_config_cache` | `%LOCALAPPDATA%\npm-cache` |

pnpm / npm / bun 都认 `npm_config_*` 这一套前缀（配置键里的 `-` 写成 `_`），所以三个目录变量都用它，不要混用别的写法。命令里已经自己设过同名变量的不覆盖。

项目自己的 `node_modules` 不接管——那是项目产物，属于工作区。同理，Python 项目的 `.venv`、Rust 的 `target`、各类 `__pycache__` 也一概不碰：插件只改包管理器的**全局缓存位置**，不动项目内的任何目录。

## 安装

在 DSH 的插件管理页里安装，或者用命令行挂一个本地仓库：

```powershell
dsh plugin --profile <profile> add "link:<本仓库绝对路径>"
```

安装后重启 DSH 生效。客户端半边（插件页上的配置卡片）在首次安装前要先构建一次：

```powershell
node scripts/build.mjs
```

产物是 `lib/client.js`，和 `lib/index.js` 一起会被发布出去，用户装包时不需要自己构建。

## 配置

插件页上那张「过期清理」卡片管 `autoCleanup` 与 `cleanupMaxAgeDays`；其余字段在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: disk-cleanup
  name: 'dsh-disk-cleanup'
  config:
    enabled: true
    scratchDir: ''              # 空 = 用 <DSH_HOME>/cache/scratch；自己指了就别指望自动清理
    injectShellTemp: true       # pwsh/bash 的 TMP/TEMP 指向 scratch
    grantProcessWrite: true     # 给 scratch 补访问控制项，让子进程也能写
    runtimeCache: auto          # auto / always / never
    promptSection: true         # 往系统提示里加一段说明
    autoCleanup: true           # 启动时清掉过期的临时文件（插件页也能改）
    cleanupMaxAgeDays: 7        # 保留天数，1–365（插件页也能改）
```

## 测试

```powershell
node --test "test/*.test.mjs"
node test/e2e-shell.mjs
```

- `plugin` / `scratch` / `cleanup`：插件装配、纯函数与目录清理，覆盖 shell 包装、环境变量注入、可写根登记、提示词 section、过期判定与节流。
- `e2e-shell`：生成的前缀真的交给 pwsh 执行，确认 TMP/TEMP 落到 scratch。
- `schema-probe`：不是单测，用来核对 `Config` 能被真的 schemastery 构建、设置页显示的默认值与实际生效的默认值一致。schemastery 由 DSH 自带，插件以 link 方式装进 profile 时自身解析不到它，所以这条要在 profile 目录里跑（`node <本仓库>/test/schema-probe.mjs`）；在仓库里跑只会退到空壳构建器，结果恒为不一致。
- `client-probe`：不是单测，用假的 ui-primitives 核对客户端产物 `lib/client.js` 能否注册到配置卡片槽、编辑后保存写的是哪几个字段。

## 加载顺序与重入

两个已处理的情况：

- **目标工具可能比本插件晚注册**（bundle 顺序不定）。`install()` 只给此刻已注册的工具装包装，只有真的注册成功才记进「已装」集合；还没出现的留白，由 `tools/change` 事件补装。
- **注册包装会触发 `tools/change`**，监听器回头再调 `install()` 就是重入，会在同一作用域重复注册同名工具并抛错。用 `installing` WeakSet 挡住。

## 边界

- 拿不到 `sandboxPolicy` 服务，或当前会话是 read-only → 完全不动：不注入、不建目录。
- 可写根或访问控制项补不上 → 整体退到 `<工作区>/cache/scratch`，不混用两处。
- 非 Windows 平台 → 跳过访问控制项那一步；可写根注册那半仍然生效。
- 原工具被别的插件关掉 → 跳过该工具，其余照常。
- 原 `execute` 抛错 → 原样透传，不包装、不吞异常。
- `run_code` 不覆盖（工具名被宿主保留，注册会抛错），也不在覆盖范围内。
- 挂载后会话一建立就会建 scratch 目录（`agent/created` 时一次性建好），不等第一次写文件。
- `sandbox_permissions` / `justification` 原样透传，权限升级链路不断。
- 客户端半边注册失败（比如宿主没有槽位服务）只影响插件页的卡片，shell 注入、授权与清理照常。

## 尚未包含

`attachments` 与派生图片缓存的回收、会话归档触发的清理、包管理器缓存的体积上限。DSH 的图片缓存目前不会自动删除，处理它属于另一件事。
