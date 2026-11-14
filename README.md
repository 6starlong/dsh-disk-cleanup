# dsh-disk-cleanup

给临时文件一个专用目录：shell 命令里的临时目录默认落在工作区之外，scratch 目录在需要时补齐写权限，系统提示告诉模型临时文件该写哪里，过期的临时文件到点自动清掉。用户要保留的文件照旧留在工作区。

DSH 本身没有「临时文件目录」这个概念；模型写出的探针脚本默认都落在工作区内。这个插件提供统一的环境注入、scratch 目录授权、一段系统提示和一份过期清理，让临时文件有地方可去、也不会越攒越多。

## 它做什么

四条机制：

| 机制 | 覆盖的情况 | 做法 |
|---|---|---|
| shell 环境注入 | 脚本内部用 `tempfile` / `[System.IO.Path]::GetTempPath()` 之类 | 在 `pwsh` / `bash` 命令串前设置 `TMP` / `TEMP` / `TMPDIR`，指向 `<DSH_HOME>/cache/scratch` |
| 权限补齐 | workspace-write 下 scratch 目录对受限子进程不可写 | 给会话注册可写根 + 给目录补访问控制项 |
| 系统提示 | 模型不知道该往哪写 | 加一段祈使句，点明 scratch 位置、临时文件写那儿、用户文件留在工作区；路径每次构建时现算，只读会话不出这段 |
| 过期清理 | scratch 只增不减，旧探针脚本一直留着 | 按保留天数删掉 `<DSH_HOME>/cache/scratch` 里过期的条目，插件加载时与之后定期各扫一次 |

不改写任何工具入参的路径：模型给什么路径就写什么路径。要不要把临时文件放进 scratch 由提示词引导，不由插件替模型决定。

## 落点规则

| 权限模式 | scratch 目录 | 怎么让它可写 |
|---|---|---|
| workspace-write | `<DSH_HOME>/cache/scratch` | 给会话注册可写根（文件工具）+ 给目录补访问控制项（子进程） |
| danger-full-access | `<DSH_HOME>/cache/scratch` | 不需要，本来就能写 |
| read-only | 不启用 | —— |
| 任意可写模式 + 配置了 `scratchDir` | 配置里给的那个目录 | 同 workspace-write 的两步；这个目录不参与自动清理 |

`<DSH_HOME>` 默认 `~/.dsh`，跟随 `DSH_HOME` 环境变量。**所有可写模式都用同一个位置**，工作区只留用户要的文件。

workspace-write 下写到工作区外面要两步授权，插件在会话创建时就做好：

1. `sandboxPolicy.registerWritableRoot(session, dir)` —— 让文件工具能写这个目录。
2. `AclWriteGrant`（Windows）—— 用工作区自己的安全标识给目录加一条可写项，受限子进程也能写。

第 2 步只在 Windows 上做，复用工作区的安全标识，不加新身份、也不放宽到别的目录。补上的访问控制项是常驻的：插件卸载时只释放授权对象，不删这一项，否则下一个会话写 scratch 会被挡回去。任何一步失败就整体退到 `<工作区>/cache/scratch`。

## 过期清理

只清 `<DSH_HOME>/cache/scratch`，也就是插件自己定的那个落点：

- **删什么**：`cache/scratch` 下的顶层条目，最后修改时间早于「现在减保留天数」的才删；目录整个删掉，含里面的内容。
- **不删什么**：插件只清 `<DSH_HOME>/cache/scratch`，其它目录一概不碰。配置里自己指了 `scratchDir` 的，那个目录也不自动清，里面的东西未必可丢。
- **怎么算过期**：看条目自己的最后修改时间，不看访问时间（Windows 默认不更新访问时间）。目录里某个子文件刚被写过，目录的修改时间会一并刷新，正在用的工作目录不会被误删。
- **何时清**：插件加载时一次，之后定期再扫，进程重启等于重新起算。
- **单个条目删不掉**（Windows 上被别的进程占着）就跳过，不中断整批。

在插件**详情页**的「过期清理」卡片里可以关掉自动清理，也可以改保留天数（1–365）：天数留空恢复默认的 7 天。


## 安装

在 DSH 的插件管理页里安装，或者用命令行装：

```powershell
dsh plugin --profile <profile> add dsh-disk-cleanup
```

安装后重启 DSH 生效。

## 配置

插件详情页（插件页点开某个插件后的那一页）上那张「过期清理」卡片管 `autoCleanup` 与 `cleanupMaxAgeDays`；其余字段在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-disk-cleanup
  name: 'dsh-disk-cleanup'
  config:
    enabled: true
    scratchDir: ''              # 留空 = 默认暂存目录并自动清理；自定义目录不清理
    injectShellTemp: true       # pwsh/bash 的 TMP/TEMP 指向 scratch
    grantProcessWrite: true     # 给 scratch 补访问控制项，让子进程也能写
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
- `schema-probe`：核对 `Config` 能被真的 schemastery 构建，且默认值与实际生效的一致；要在装了本插件的 profile 目录里跑。
- `client-probe`：核对客户端产物 `lib/client.js` 能注册到插件页槽位、保存时写哪几个字段。

改 `src/client/index.jsx` 之后要重新生成 `lib/client.js`：

```powershell
node scripts/build.mjs
```

## 工具包装

包装只覆盖 `pwsh` 与 `bash`，并处理两个情况：

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