# dsh-disk-cleanup

把模型写的临时文件（探针脚本、一次性检查、草稿）收进专门的 scratch 目录，用户要保留的文件照旧留在工作区。

DSH 本身没有「临时文件目录」这个概念：所有 `.ps1` / `.js` 探针都是模型自己用 `write` 写出来的，默认直接落在工作区根目录。包管理器（pnpm / bun / uv / npm）也会把动辄上百 MB 的依赖缓存建在工作区里。这个插件补上那一层。

## 它做什么

四条机制：

| 机制 | 覆盖的情况 | 做法 |
|---|---|---|
| 文件工具覆盖 | 模型直接 `write` / `edit` / `apply_patch` 一个裸脚本名 | 在 agent 作用域注册同名工具，改写 `file_path` 后调用原实现，返回给模型的 path 就是真实落点 |
| shell 环境注入 | 脚本内部用 `tempfile` / `[System.IO.Path]::GetTempPath()` 之类 | 在 `pwsh` / `bash` 命令串前设置 `TMP` / `TEMP` / `TMPDIR` |
| 运行时缓存改道 | `pnpm install` / `bun install` / `uv sync` 在工作区留下 `.pnpm-store`、`_buninstall` 之类 | 启动时探测本机装了哪些包管理器，只接管没装的那几个，把缓存目录注入成 `<DSH_HOME>/cache/<工具>` |
| 系统提示 | 模型不知道该往哪写 | 加一段说明，讲清临时文件与用户文件的落点区别 |

改写落点而不是拒绝调用：模型拿到的 path 就是真实位置，不需要重试，也不消耗额外轮次。

## 落点规则

| 权限模式 | scratch 目录 | 怎么让它可写 |
|---|---|---|
| workspace-write | `<DSH_HOME>/cache/scratch` | 给会话注册可写根（文件工具）+ 给目录补访问控制项（子进程） |
| danger-full-access | `<DSH_HOME>/cache/scratch` | 不需要，本来就能写 |
| read-only | 不启用 | —— |

`<DSH_HOME>` 默认 `~/.dsh`，跟随 `DSH_HOME` 环境变量。**所有可写模式都用同一个位置**，工作区只留用户要的文件。

workspace-write 下写到工作区外面需要两步授权，插件在**第一次真正要写入时**自动完成（不是会话创建时——那一刻权限还没落定，提前算会把文件送进错的目录）：

1. `sandboxPolicy.registerWritableRoot(session, dir)` —— 让 `write` / `edit` / `apply_patch` 认这个目录。
2. `AclWriteGrant`（Windows）—— 用工作区自己的安全标识给目录加一条可写项，受限子进程也能写。

第 2 步只在 Windows 上做，且复用工作区的安全标识，所以不需要新身份、也不会放宽到别的目录。任何一步失败就整体退到 `<工作区>/cache/scratch`，不弹审批、不静默失败。

## 判据：只动两类，其余一律不碰

1. **系统临时目录内的绝对路径** → 改到 scratch。
2. **裸文件名 + 脚本扩展名** → 改到 scratch。扩展名：`.ps1 .sh .bash .bat .cmd .py .js .mjs .cjs .ts .rb .pl .lua`

以下**永远不动**：

- 带目录的相对路径（`src/main.js`、`cache/scratch/x.ps1`、`.scratch/y.py`）
- 产物类扩展名（`report.md`、`data.json`、`notes.txt`、`out.csv`）
- 项目入口名（`server.js`、`main.py`、`vite.config.ts`、`index.mjs` 等）
- 工作区内的绝对路径
- 工作区里已经存在的同名文件（`write` 时）
- scratch 里已经存在的同名文件（`edit` 时优先改那一份）

不读文件内容，不按 `_` 前缀猜——判据是纯函数，见 `lib/redirect.js`。

## 运行时缓存

启动时在 `PATH` 里找 `pnpm` / `bun` / `uv` / `npm`，按 `runtimeCache` 决定接管哪些：

| 取值 | 行为 |
|---|---|
| `auto`（默认） | 只接管**没装**的。用户自己装了并配好全局缓存的，用他自己的，不打扰 |
| `always` | 全部接管，缓存一律进 `<DSH_HOME>/cache` |
| `never` | 一个都不碰 |

接管的工具会被注入这些变量：

| 工具 | 变量 |
|---|---|
| pnpm | `pnpm_config_store_dir` / `pnpm_config_cache_dir` / `pnpm_config_state_dir` |
| bun | `BUN_INSTALL_CACHE_DIR` |
| uv | `UV_CACHE_DIR` |
| npm | `npm_config_cache` |

命令里已经自己设过同名变量的不覆盖。项目自己的 `node_modules` 不接管——那是项目产物，属于工作区。

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
    redirectSystemTemp: true    # 系统临时目录里的写入改到 scratch
    redirectBareScripts: true   # 裸文件名脚本改到 scratch
    bareScriptExtensions: []    # 空 = 用内置集合
    injectShellTemp: true       # pwsh/bash 的 TMP/TEMP 指向 scratch
    grantProcessWrite: true     # 给 scratch 补访问控制项，让子进程也能写
    runtimeCache: auto          # auto / always / never
    promptSection: true         # 往系统提示里加一段说明
```

## 测试

纯函数与插件装配的单测不需要 DSH 运行时：

```powershell
node --test "test/*.test.mjs"
```

端到端测试要加载 DSH 运行时里的模块，用环境变量指向安装位置：

```powershell
$env:DSH_ASAR_ROOT = '<安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/'
node test/integration.mjs
node test/e2e-write.mjs
node test/e2e-edit.mjs
node test/e2e-shell.mjs
```

- `integration`：真实 cordis + ToolsService + SystemPromptService，验证同名覆盖在真实注册校验下成立。
- `e2e-write`：真实 LocalFileSystem + 真实 write 工具，真写文件。
- `e2e-edit`：edit 与 apply_patch 的重定向。
- `e2e-shell`：生成的前缀真的交给 pwsh 执行。

## 加载顺序与重入

两个已处理的情况：

- **目标工具可能比本插件晚注册**（bundle 顺序不定）。`install()` 只给此刻已注册的工具装包装，只有真的注册成功才记进「已装」集合；还没出现的留白，由 `tools/change` 事件补装。
- **注册包装会触发 `tools/change`**，监听器回头再调 `install()` 就是重入，会在同一作用域重复注册同名工具并抛错。用 `installing` WeakSet 挡住。

## 边界

- 拿不到 `sandboxPolicy` 服务，或当前会话是 read-only → 完全不动：不重定向、不注入、不建目录。
- 可写根或访问控制项补不上 → 整体退到 `<工作区>/cache/scratch`，不混用两处。
- 非 Windows 平台 → 跳过访问控制项那一步；文件工具那半仍然生效。
- 原工具被别的插件关掉 → 跳过该工具，其余照常。
- 原 `execute` 抛错 → 原样透传，不包装、不吞异常。
- `run_code` 不覆盖（工具名被宿主保留，注册会抛错），也不在覆盖范围内。
- 写 scratch 失败 → 抛原始错误，不静默回退到工作区。
- 挂载插件本身不产生任何磁盘写入，只有真正调用了被包装的工具才会建目录。
- `sandbox_permissions` / `justification` 原样透传，权限升级链路不断。

## 尚未包含

过期清理（按空闲时间删除旧条目）、`attachments` 与派生图片缓存的回收、会话归档触发的清理。DSH 的图片缓存目前不会自动删除，处理它属于另一件事。
