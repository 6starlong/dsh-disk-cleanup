# dsh-disk-cleanup

给临时文件一个专用目录：shell 命令里的临时目录与包管理器缓存默认落在工作区之外，scratch 目录在需要时补齐写权限，系统提示告诉模型临时文件该写哪里。用户要保留的文件照旧留在工作区。

DSH 本身没有「临时文件目录」这个概念；模型写出的探针脚本、包管理器建出的依赖缓存默认都落在工作区内。这个插件提供统一的环境注入、scratch 目录授权和一段系统提示，让临时文件有地方可去，用户文件留在工作区。

## 它做什么

三条机制：

| 机制 | 覆盖的情况 | 做法 |
|---|---|---|
| shell 环境注入 | 脚本内部用 `tempfile` / `[System.IO.Path]::GetTempPath()` 之类，以及 `pnpm install` / `bun install` / `uv sync` 在工作区留下缓存 | 在 `pwsh` / `bash` 命令串前设置 `TMP` / `TEMP` / `TMPDIR`，并注入包管理器缓存变量，缓存一律进 `<DSH_HOME>/cache/<工具>` |
| 权限补齐 | workspace-write 下 scratch 目录对受限子进程不可写 | 给会话注册可写根 + 给目录补访问控制项 |
| 系统提示 | 模型不知道该往哪写 | 加一段祈使句，点明 scratch 位置、临时文件写那儿、用户文件留在工作区；路径每次构建时现算，只读会话不出这段 |

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

pnpm 用的是 `npm_config_` 前缀：npm 系工具（npm / pnpm / bun）认的都是这一套，`pnpm_config_` 是无效前缀。命令里已经自己设过同名变量的不覆盖。

项目自己的 `node_modules` 不接管——那是项目产物，属于工作区。同理，Python 项目的 `.venv`、Rust 的 `target`、各类 `__pycache__` 也一概不碰：插件只改包管理器的**全局缓存位置**，不动项目内的任何目录。

## 安装

```powershell
dsh plugin --profile <profile> add "link:<本仓库绝对路径>"
```

安装后重启 DSH 生效。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: disk-cleanup
  name: 'dsh-disk-cleanup'
  config:
    enabled: true
    scratchDir: ''              # 空 = 用 <DSH_HOME>/cache/scratch
    injectShellTemp: true       # pwsh/bash 的 TMP/TEMP 指向 scratch
    grantProcessWrite: true     # 给 scratch 补访问控制项，让子进程也能写
    runtimeCache: auto          # auto / always / never
    promptSection: true         # 往系统提示里加一段说明
```

## 测试

都不需要 DSH 运行时：

```powershell
node --test "test/*.test.mjs"
node test/e2e-shell.mjs
```

- `plugin` / `scratch`：插件装配与纯函数，覆盖 shell 包装、环境变量注入、可写根登记、提示词 section。
- `e2e-shell`：生成的前缀真的交给 pwsh 执行，确认 TMP/TEMP 落到 scratch。

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

## 尚未包含

过期清理（按空闲时间删除旧条目）、`attachments` 与派生图片缓存的回收、会话归档触发的清理。DSH 的图片缓存目前不会自动删除，处理它属于另一件事。
