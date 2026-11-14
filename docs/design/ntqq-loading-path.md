# NTQQ 附着路径评估：官方插件 API、LiteLoader 与启动注入

> 评估日期：2026-11-12。对象：本机 QQ `9.9.33-52230`（`D:\qq`，x64）。
> 本文只做只读评估，**没有修改 QQ 文件、没有向 QQ 注入代码、没有启动 QQ**。
>
> 后续（2026-11-13）：S0 已在该路线上完成 patcher + 自研 loader + OneBot 最小验证，
> 见 [S0 结案与 S1 边界](s0-closure-and-s1-boundary.md)。本文保留为路径评估记录。

## 结论

1. **QQNT 没有腾讯官方插件 API。** 没有公开的 addon/extension SDK，也没有文档化的
   “加载第三方 Node 模块”入口。社区所谓“QQNT 插件”全部依赖 Electron/Node 的非官方
   hook；LiteLoaderQQNT、QQNTim、NapCat 都是这个性质。
2. **当前 QQ 版本把应用代码加密并签名。** `application.asar` 里的
   `app_launcher/index.js` 只有 80 字节且是密文；`application.json` 对
   `application.asar`、`wrapper.node`、`major.node`、`package.json` 四个文件保存了
   签名/摘要。修改 `package.json` 的 `main` 会触发 QQ 的文件完整性校验（社区补丁
   文档描述为 SHA256 + `memcmp`，校验失败直接显示“文件损坏”）。
3. **LiteLoaderQQNT 的官方安装方式要求绕过这个校验。** 它的 README 明确要求使用
   Telegram 群内未公开的 `dbghelp.dll`，或用 `QQNTFileVerifyPatch` 修改 `QQNT.dll`。
   前者是不可审计的 DLL 劫持，后者是每次 QQ 更新都要重打的二进制补丁；LiteLoader
   仓库本身已归档，最新 release 停在 `1.4.1`（2025-12-02）。
4. **NapCat 的 Windows 路线不是 Electron 插件，而是启动注入。**
   `NapCatWinBootMain.exe` 挂起启动 QQ，注入 `NapCatWinBootHook.dll`，在进程内重定向
   文件读取，让 QQ 加载 NapCat 的 JS，再用固定偏移 hook 原生收发。它在
   **同一 QQ 版本 9.9.33-52230** 上有崩溃报告（`QQNT.dll+0x26b6e3a`，
   `0x80000003`，JS 层未执行）；NapCat 的许可证也禁止公开分发修改版和商业使用。
5. **`NODE_OPTIONS=--require` 这条“干净”路线走不通。** 虽然本机 QQNT 的 Electron
   fuse 显示 `EnableNodeOptionsEnvironmentVariable` 已启用，但 Electron 官方文档明确：
   打包应用里 `NODE_OPTIONS` 除 `--max-http-header-size`、`--http-parser` 外**一律
   被忽略**。QQ 是打包应用，`--require` 不会生效。
6. **唯一仍然“只读、不改文件”的代码执行入口是 `--inspect`。** 本机 QQNT 的
   `EnableNodeCliInspectArguments` fuse 也是启用的；如果启动器把该参数传给 Electron，
   就可以用 DevTools 协议在 QQ 主进程里执行研究代码。但 inspector 端口没有认证，
   不能作为发布方案，只能做受控实验。
7. **推荐：不把 LiteLoader + dbghelp 作为 Lodestar 的依赖，不实现完整性绕过，不打包
   NapCat。** 近期只做一次受控的 `--inspect` 可行性实验；如果失败，原生附着就停在
   研究阶段，产品继续使用 Core + OneBot 上游兼容后端。

一句话：用户想要的“QQ 自身 Electron addon/插件装载路径”**并不存在一个干净的官方版本**；
现有路线要么改签名文件并绕过校验，要么做进程注入。评估结果不支持把任何一条直接变成
Lodestar 的发布依赖。

## 本机只读事实

| 项 | 值 | 证据 |
| --- | --- | --- |
| QQ 版本 | `9.9.33-52230` | `resources/app/package.json` |
| Electron | `40.0.0` | `QQNT.dll` 内 `Electron/40.0.0` 字符串 |
| Chromium | `144.0.7559.60` | `QQNT.dll` 内 `Chrome/144.0.7559.60` 字符串 |
| Node（Electron 40 自带） | `24.11.1` | Electron 40.0.0 发布说明 |
| 应用入口 | `./application.asar/app_launcher/index.js` | `resources/app/package.json` |
| shell 标记 | `isPureShell: true`、`isByteCodeShell: true` | 同上 |
| asar 内容 | `app_launcher/index.js` 仅 80 字节，密文；`preload.js` 240 字节 | 解析 `application.asar` 头部 |
| 完整性清单 | 四个文件对应 256 字节 base64 签名 | `resources/app/application.json` |
| 已安装 LiteLoader | 否 | 无 `LiteLoader*` 文件/目录 |
| QQ.exe 同级 dbghelp | 无 | `find D:\qq -iname dbghelp.dll` 只有 `resources/app/dbghelp.dll` |
| 自带 dbghelp | Microsoft 6.12，Tencent Authenticode 有效 | 文件版本/签名检查（非劫持 DLL） |

`npx @electron/fuses read --app "D:\qq\versions\9.9.33-52230\QQNT.dll"` 输出：

```text
Fuse Version: v1
  RunAsNode is Enabled
  EnableCookieEncryption is Disabled
  EnableNodeOptionsEnvironmentVariable is Enabled
  EnableNodeCliInspectArguments is Enabled
  EnableEmbeddedAsarIntegrityValidation is Disabled
  OnlyLoadAppFromAsar is Disabled
  LoadBrowserProcessSpecificV8Snapshot is Disabled
  GrantFileProtocolExtraPrivileges is Enabled
```

解读：

- `RunAsNode` 开启 → `ELECTRON_RUN_AS_NODE` 可把 QQ 二进制当 Node 用，但那是一个独立
  Node 进程，**不是**附着到已登录的 QQ 主进程。
- `nodeOptions` 开启只代表 Electron 不主动禁用环境变量；打包应用的 `--require`
  仍被 Electron 的 allowlist 拦掉（见下）。
- `nodeCliInspect` 开启 → `--inspect`/`--inspect-brk` 可能被接受，是唯一可研究的
  启动期代码执行入口。
- `embeddedAsarIntegrityValidation` 关闭 → QQ 不是用 Electron 的 asar 完整性功能，
  而是自己的 `application.json` 校验；这也是为什么改 `package.json` 仍会触发校验。

## 路径对比

| 路径 | 机制 | 改 QQ 文件 | 绕过完整性 | 版本稳定性 | 许可/供应链 | 账号风险 | 适合 Lodestar？ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 官方插件 API | 不存在 | — | — | — | — | — | 否 |
| LiteLoaderQQNT + dbghelp | 改 `package.json main` → JS loader；DLL 劫持/补丁绕过校验 | 是 | 是 | 差，QQ 更新即可能失效；上游已归档 | MIT loader，但绕过 DLL 不公开、不可审计 | 高，官方 README 警告可能下线/封号 | 否（最多用户自装） |
| NapCat Windows Boot | 挂起启动 + DLL 注入 + 文件读重定向 + 固定偏移 hook | 否（但注入进程） | 是（进程内绕过） | 差，同版本已有崩溃报告 | 非商业、禁止公开修改版；Boot 仓库无许可证 | 高 | 否（最多外部后端） |
| 自研 manual map（本仓库 spike） | 远程映射 PE + 远程线程 | 否 | 否（未改文件） | 未验证 QQ；需自己做版本 hook | 自有代码，AV 易误报 | 高 | 仅研究 |
| `--inspect` | 启动 QQ 时开 Node inspector，通过 CDP 执行代码 | 否 | 否 | 取决于启动器是否透传参数；未验证 | 使用 Electron 自带能力，无第三方二进制 | 中高（调试端口、QQ 检测） | 仅受控研究 |
| OneBot 上游适配器 | 连接 NapCat/SnowLuma/LLOneBot 的 WS | 否 | 否 | 取决于上游 | 不打包上游 | 取决于上游 | 当前唯一可发布 |
| 官方 QQ Bot API | 腾讯官方 API | — | — | 高 | 官方 | 低 | 已否决（ADR 0001） |

## 详细评估

### 1. LiteLoaderQQNT：不是官方 API，且依赖不可审计的校验绕过

LiteLoader 的工作方式（官方 README 与安装页）：

1. 在 `resources/app/app_launcher/` 下新建 `LiteLoader.js`，内容是一行
   `require(String.raw\`<LiteLoader 绝对路径>\`)`；
2. 把 `resources/app/package.json` 的 `main` 从
   `./application.asar/app_launcher/index.js` 改成 `./app_launcher/LiteLoader.js`；
3. QQ 启动时先执行 LiteLoader；LiteLoader 劫持 `require('electron')` 的
   `BrowserWindow`，注入自定义 preload，再加载插件。

问题不在于 loader 本身（MIT，代码公开），而在于第 2 步会触发 QQ 文件校验：

- 官方 README 的 Windows 安装步骤要求：从 Telegram 群下载 `dbghelp_*.dll`，重命名为
  `dbghelp.dll` 放到 `QQ.exe` 同级目录；或使用 `QQNTFileVerifyPatch` 的
  `Patcher_v1.0.4` 直接修改 `QQNT.dll`。
- `QQNTFileVerifyPatch` 的 README 自己写明：用 IDA 找 `.rdata` 里的 SHA256 常量，
  找到 `memcmp` 校验函数，把调用改成 `mov eax, 1`；`package.json` 被改后校验返回 0，
  QQ 就不加载 GUI，提示“文件损坏”。
- `dbghelp.dll` 不在公开仓库里，来源是 Telegram 群；它做的是 DLL 劫持 + 校验函数
  hook。对 Lodestar 来说，这是**不可审计、不可复现、不可打包**的供应链风险。
- LiteLoader 仓库已归档（GitHub API `archived: true`，最后 push 2026-05-09；最新
  release `1.4.1` 发布于 2025-12-02）。README 顶部还警告：QQ 安全中心可能把它当作
  “非法外挂工具”，下线设备甚至封号。

结论：LiteLoader 可以作为**用户自己已经装好**的第三方环境，让 Lodestar 以插件形式运行；
但不能成为 Lodestar 的默认依赖，更不能由 Lodestar 自动安装/分发绕过 DLL。QQNTim 是同类
第三方框架，同样依赖非官方 hook 和改 `main`/注入，不构成“官方路径”的替代。

### 2. NapCat Windows Boot：本质是注入，不是 Electron 插件

NapCat 的 Windows 启动链是：

```text
NapCatWinBootMain.exe QQ.exe NapCatWinBootHook.dll
  → 挂起创建 QQ 进程
  → 注入 hook DLL
  → 进程内重定向文件读取，让 QQ 的 main 解析到 napcat.mjs
  → QQ 恢复运行
  → hook 原生收发/事件，通过命名管道与 JS 层通信
```

它的优点是**不改磁盘上的签名文件**；缺点是仍然做进程注入和固定偏移 hook，版本一更新就
可能失效。最直接的证据是 NapCat issue #2116：环境正是 **QQ 9.9.33-52230 / Windows 11
25H2 26200**，`NapCatWinBootHook.dll` 注入后打印 `Process resumed`，QQ 在
`QQNT.dll+0x26b6e3a` 以 `0x80000003` 崩溃，JS 层完全没有执行；issue #2091（QQ
9.9.35-52892）报告同一偏移。issue #2116 已关闭，一条评论把原因归为目录被打了 low
integrity 标签、与沙箱机制有关，但没有给出修复或复现结论。**这不是说 NapCat 在所有机器
上都不可用**，而是说明这条路线在目标系统/版本上存在已知的、与安全机制相关的失败模式。

许可证方面，NapCat 是“Limited Redistribution License”：禁止未经许可的使用/修改/分发，
禁止商业使用，修改版不得公开分发；`NapCat-Windows-Boot` 仓库没有声明许可证。Lodestar
不能打包它，只能把它当用户自行安装的外部后端。

### 3. 自研 manual map：已验证“能注入”，但离“能用于 QQ”很远

本仓库 `spike/ntqq-inject` 已经在良性 target 上验证了 PE manual map + 命名管道回报：
连续 5 次执行、4 次完整断言通过；payload 为 3 KB、仅导入 kernel32。但它：

- 没有注入过 QQ；
- 没有做任何 QQ 版本相关的 hook；
- 被 Windows Defender 的 ML 启发式间歇判为 `Trojan:Win32/Bearfoos.A!ml`；
- 整段远端内存 RWX，未处理 TLS callback/CFG/异常目录，失败路径也未做故障注入。

结论：它是底层能力的证明，不是产品。即使继续，也需要版本指纹、按 section 权限映射、
异常/卸载处理和签名/白名单方案。

### 4. `--inspect`：唯一不改文件的启动期入口，但只能研究

Electron 的 `nodeCliInspect` fuse 在本机 QQNT 上是启用的，意味着：

```powershell
QQ.exe --inspect=127.0.0.1:9339
# 或 --inspect-brk 在 main 执行前停住
```

如果 QQ 启动器把参数透传给 Electron（NapCat 已证明 `--enable-logging` 会被传下去），
就可以用 DevTools 协议连上主进程，在 QQ 自己的 JS 执行前 `Runtime.evaluate` 一段代码。
这条路径：

- 不改 `package.json`、不替换 DLL、不绕过 QQ 的文件校验；
- 但仍然是在 QQ 主进程里执行任意代码，属于调试器注入，不是官方插件；
- inspector 默认无认证，必须绑定 `127.0.0.1`、使用随机/高位端口，用完立即关闭；
- 不能作为发布方案：普通用户不应长期开着调试端口，QQ 也可能检测/拒绝。

它适合做**一次受控实验**，用来回答“我们能否在 QQ 主进程里安全地加载自己的模块、观察
登录/消息 API”，从而决定原生 hook 是否值得继续。它不适合作为最终用户安装方式。

补充：`NODE_OPTIONS=--require` 看起来更干净，但 Electron 官方文档明确写着打包应用只允许
`--max-http-header-size` 和 `--http-parser`，其他 `NODE_OPTIONS` 一律忽略；所以不要把
它列入可行方案。`ELECTRON_RUN_AS_NODE` 只能起一个独立 Node 进程，也拿不到 QQ 的登录态。

### 5. OneBot 上游适配器：当前唯一可发布的路径

`@lodestar/adapter-onebot-upstream` 已经可以连接 NapCat/SnowLuma/LLOneBot 的 WS 服务端，
不改 QQ、不绕过校验、不依赖注入。它不能“替代”上游，但能让 Lodestar 的 Core（探针、
outbox、SendGuard、可观测、部署）先稳定下来；如果将来原生后端失败，它也是降级路径。

## 推荐决策

### 红线

- **不实现、不打包、不自动化 QQ 的文件完整性校验绕过**（包括 `dbghelp.dll` 劫持、
  `QQNT.dll` patch、任何“文件损坏”绕过）。
- **不把来源不明的 Telegram DLL、NapCat 修改版、LiteLoader 绕过组件放进 Lodestar 仓库
  或安装包。**
- 不把“能绕过校验”当成竞争力；这会把项目从“工程化 OneBot 运行时”变成“外挂分发”。

### 近期（建议）

1. 先做一次 **`--inspect` 受控实验**（见下），只验证“能否在 QQ 主进程执行代码、
   QQ 是否崩溃/检测”。实验用非主力号、QQ 完全退出、localhost、短时间、可回滚。
2. 如果实验失败或被 QQ 拒绝：**原生附着停在研究阶段**。继续 Core + 上游适配器，
   把精力放在假死探针、outbox、部署和可观测上；这仍然是相对 SnowLuma 的差异化。
3. 如果实验成功：只把它当作**研究 harness**，用来定位登录/消息入口和版本指纹；
   不把它包装成用户安装方式。是否继续投入原生后端，需要单独决策。

### 中期（可选）

- 如果用户明确接受“自己安装 LiteLoader”的前提，Lodestar 可以提供**可选插件包**：
  只包含我们的 JS/原生模块，不包含 loader、不包含绕过 DLL、不自动改 QQ 文件；
  文档写清楚“需用户自行安装 LiteLoader 并承担风险”。
- 但 LiteLoader 已归档，插件 API 也会随 QQ 更新失效；这条路线不能作为“比 SnowLuma
  更稳”的主卖点，除非我们能自己维护版本适配。

## 受控 `--inspect` 实验（尚未执行）

目的：验证 QQ 启动器是否透传 `--inspect-brk`，以及能否在主进程加载一个只写标记文件的
模块；不登录、不发消息、不读凭证。

步骤（需要用户明确同意后执行）：

1. 完全退出 QQ，确认无 `QQ.exe` 进程。
2. 在仓库外准备 `probe.cjs`：只写一行 JSON（时间、`process.type`、
   `process.versions.electron/node`）到 `data/inspect-probe.json`，不启动网络、不读文件。
3. 启动 `QQ.exe --inspect-brk=127.0.0.1:9339`；用 `ws` 连接
   `http://127.0.0.1:9339/json` 拿到 webSocket URL。
4. 发送 `Runtime.enable`，用 `Runtime.evaluate` 执行
   `require(String.raw\`<probe.cjs 绝对路径>\`)`，再 `Runtime.runIfWaitingForDebugger`。
5. 成功标准：标记文件出现；QQ 显示登录窗口；无崩溃；结束后关闭 QQ，端口不再监听。
6. 失败/回滚：直接结束 QQ 进程；不改任何 QQ 文件；不输入账号密码；如果 QQ 报错或
   安全提示，停止实验并记录。

风险：`--inspect` 是调试接口，QQ 可能检测；inspector 端口在运行期间对本机其他进程
可见；这是“调试器注入”，不是无风险操作。**没有用户同意不执行。**

## 参考与出处

本地：

- `D:\qq\versions\9.9.33-52230\resources\app\package.json`（版本、main、shell 标记）
- `D:\qq\versions\9.9.33-52230\resources\app\application.json`（四文件签名清单）
- `D:\qq\versions\9.9.33-52230\resources\app\application.asar`（ASAR 头；80 字节密文条目）
- `D:\qq\versions\9.9.33-52230\QQNT.dll`（Electron/Chromium 字符串；fuse 读取目标）
- `npx @electron/fuses read --app ...\QQNT.dll`，2026-11-12
- `D:\qq\versions\9.9.33-52230\resources\app\dbghelp.dll`（Microsoft 6.12，Tencent 签名）

外部（检索于 2026-11-12）：

- LiteLoaderQQNT 仓库（`archived: true`，最后 push 2026-05-09；release `1.4.1`
  2025-12-02）：<https://github.com/LiteLoaderQQNT/LiteLoaderQQNT>，commit
  `1a8c9707c3673e0491445a1d6d7a86f0a1aa8000`。README 要求 Windows 使用
  Telegram 群内 `dbghelp.dll` 或 `QQNTFileVerifyPatch`，并警告可能下线/封号。
- LiteLoaderQQNT 安装页：<https://liteloaderqqnt.github.io/guide/install.html>
- QQNTFileVerifyPatch（README 描述 SHA256 + `memcmp` 校验与 `mov eax,1` 补丁；
  最后 push 2024-11-05）：<https://github.com/LiteLoaderQQNT/QQNTFileVerifyPatch>，
  commit `f62c9bc7bc50cb0655d9a0bd6a4db0d21fc2d8d4`
- NapCat issue #2116（QQ 9.9.33-52230，`QQNT.dll+0x26b6e3a`，`0x80000003`；
  创建 2026-10-22，关闭 2026-10-30）：<https://github.com/NapNeko/NapCatQQ/issues/2116>
- NapCat issue #2091（QQ 9.9.35-52892，同一偏移）：<https://github.com/NapNeko/NapCatQQ/issues/2091>
- NapCat 许可证（Limited Redistribution License，禁止商业使用/公开修改版）：
  <https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE>
- NapCat-Windows-Boot（无许可证声明，最后 push 2025-04-13）：
  <https://github.com/NapNeko/NapCat-Windows-Boot>，commit
  `3ff3346e6b2ad8e2900dd9993eacbef9cfc95fbe`
- Electron 40.0.0（Chromium 144.0.7559.60 / Node 24.11.1）：
  <https://www.electronjs.org/blog/electron-40-0>
- Electron 环境变量文档（打包应用只允许两个 `NODE_OPTIONS`）：
  <https://github.com/electron/electron/blob/3307393d919e9979b2cd1cefd1f6037dd370214e/docs/api/environment-variables.md>
- Electron Fuses 文档（各 fuse 默认值）：
  <https://github.com/electron/electron/blob/3307393d919e9979b2cd1cefd1f6037dd370214e/docs/tutorial/fuses.md>
- 说明：LiteLoader/QQNTFileVerifyPatch 的校验细节来自第三方逆向文档，**未在本机对
  QQ 做修改验证**；本机只确认了签名清单、密文 asar 与 fuse 状态。
