# Lodestar（lodestar-qq）

<p align="center"><img src="packages/web/public/logo.jpg" alt="Lodestar" width="240" /></p>

> 产品名已正式更名 **Lodestar**。为兼容已有部署，`POLARIS_*` 环境变量、`polaris_*` 指标名、
> `data/polaris.db` 和 native loader 的 `polaris-loader.js` 文件名仍保留；新配置优先使用
> `LODESTAR_*`。Core 继续使用 Apache-2.0。

Lodestar 是一个 **Apache-2.0 的 OneBot v11 实现**，用来替代 NapCat、SnowLuma 这类 QQ 端后端：直接附着真实 NTQQ 客户端，把 OneBot v11 接口交给 AstrBot（aiocqhttp 反向 WS）。Core 与客户端适配器分离：Core 负责协议、会话、投递与 WebUI；适配器可以是原生 NTQQ loader（默认），也可以是外部 OneBot 上游（迁移/兼容）。

## 下载与安装（新用户，推荐）

从 [GitHub Releases](https://github.com/HZP-BT/lodestar-qq/releases) 下载最新的 Windows 安装包，解压后双击 `Lodestar-Setup.cmd`。
安装包自带 Node、Core、WebUI 和 QQ loader，**不需要安装 Node 或 pnpm**；一次双击会完成
环境安装、QQ 补丁/loader 安装和启动。

前置条件：

- Windows 10/11 x64；
- QQ `9.9.37-54395`（安装器会自动查找安装目录，常见 `D:\qq`）；
- AstrBot 已安装（自动查找，常见 `D:\AstrBot`），并启用 aiocqhttp 反向 WS（默认 `6199`）；
- 管理员权限（首次打补丁/安装 loader 需要 UAC）；
- 只使用测试号。

首次运行需要在 QQ 窗口登录测试号（脚本会提示并等待）；之后再次双击就是纯启动。
完整步骤、配置说明、故障排查和回滚见
[安装与启动指南](docs/quickstart.md)。

### Linux（网关模式）

Linux 上没有原生 NTQQ loader。Lodestar 在 Linux 上作为 OneBot v11 网关运行：连接上游
（NapCat / LagoneBot / LLOneBot 等），AstrBot 通过反向 WS 接 Lodestar。提供 Docker Compose
和 tar + systemd 两种方式：

```bash
cp config/upstream.example.json config/upstream.json   # 填 selfId / 上游 / AstrBot / admin token
docker compose -f docker-compose.linux.yml up -d --build
```

产物与步骤见 [Linux 部署指南](docs/linux.md)；构建 tar 包用
`bash scripts/release/package-linux.sh`。

> 注入/补丁路线属于第三方方案，与腾讯/QQ 无隶属或授权关系；它只能降低、不能归零
> 账号被风控、踢下线或封禁的风险。请只使用测试号，并自行承担风险。

> 当前状态：Windows 一键安装与 Linux 网关模式可用；OneBot 上游适配器作为
> 兼容/迁移后端保留；原生 NTQQ loader 只支持 `9.9.37-54395`，接口和补丁仍会随 QQ
> 版本调整，不构成生产级保证。

## 为什么做 Lodestar

- NapCat 无头版频繁掉线、账号被封；SnowLuma 转为私有不再公开。
- Lodestar 不做“又一层运行时平台”，只做一件事：附着真实 NTQQ，把 OneBot v11 接口给
  AstrBot，装上就能用。
- 许可证：Core 使用 Apache-2.0；不打包 SnowLuma、NapCat 等限制性许可证代码。loader/patcher
  为自研代码，按 Apache-2.0 分发。

## 架构

```
AstrBot ── reverse WS (6199/ws, Bearer token) ──►  @lodestar/core
                                                   ├─ OneBot v11 反向 WS 客户端
                                                   ├─ 动作路由 / echo 精确回传
                                                   ├─ EventSink.publish（拒绝 meta、去重、outbox）
                                                   ├─ EventStore（node:sqlite：dedup/outbox/message_ref）
                                                   ├─ OutboxDispatcher（按 deliverSeq 重放）
                                                   ├─ 运行状态（连接 + 适配器登录态 → ONLINE/OFFLINE）
                                                   ├─ 心跳、指数退避重连、并发上限
                                                   └─ 结构化日志（pino）
```

`EventSink` 在 Core，与外部 OneBot 后端或原生注入后端无关。`@lodestar/adapter-mock` 用于本地演示，Web 面板提供状态入口。

- [ADR 0001：后端范围与官方 Bot API 的否决](docs/adr/0001-backend-scope.md)
- [ADR 0002：Core 与适配器的许可证边界](docs/adr/0002-license-boundary.md)

> 如果你拿到的是 Release 里的安装包 zip，请直接按上面的
> [下载与安装](#下载与安装新用户推荐)操作；下面的 `pnpm install` / `pnpm demo` 是
> 源码开发与 mock 演示路径。

## 直接体验（mock，无需 QQ）

要求 Node.js 22.16+ 和 pnpm 10。首次安装依赖后，一条命令启动 mock 演示：

```bash
pnpm install
pnpm demo
```

`pnpm demo` 会构建并启动 MockAdapter、内置 mock AstrBot 和 Web 控制面板，终端会打印：

```text
Lodestar demo is running
  Panel:   http://127.0.0.1:18081
  Token:   <本机生成的 token>
  Health:  http://127.0.0.1:18080
  Control: http://0.0.0.0:18090
```

面板 token 持久化在 `data/demo/admin-token`；想重置 demo 时删除 `data/demo/`。默认端口：
`18080`（health）、`18081`（面板）、`18090`（mock 控制面）、`6199`（内置 mock AstrBot）。
如果这些端口已被真实部署占用，demo 会自动顺延到下一个空闲端口，并在终端打印实际地址。
可以让 mock 产生事件：

```bash
curl -X POST http://127.0.0.1:18090/emit -H "Content-Type: application/json" -d "{\"text\":\"hello\"}"
```

这条路径不需要 QQ、不需要 patcher，适合先验证 Core 和 WebUI。真实 QQ 需要额外的 OneBot 上游或独立 native adapter，不在 Core 仓库内分发。

## 从源码运行

要求：Node.js 22.16+ / 24 / 26（LTS 线），pnpm 10；CI 矩阵覆盖 22 / 24 / 26。

> **运行时 SQLite**：请使用官方 Node.js 安装包或官方 Docker 镜像。部分发行版/第三方 Node 包可能未编入 SQLite，`node:sqlite` 会不可用；Lodestar 启动时会 feature-detect 并输出当前 Node/ABI/诊断，可改用官方二进制或 `better-sqlite3` driver（ADR 0006）。

```bash
npm install -g pnpm@10
pnpm install
pnpm build
```

真实 QQ 路径：Windows 上按 [安装与启动指南](docs/quickstart.md) 的源码流程运行
`scripts\windows\setup.ps1`；或者参考下方“真实 OneBot 上游”，写好 `config/upstream.json`
后运行 `node scripts/upstream.mjs`。

无 QQ 的本地演示：`pnpm demo`（见上一节）。

## 鉴权失败与恢复

- AstrBot/aiocqhttp 的反向 WebSocket **只检查 `Authorization` 请求头**，支持 `Bearer <token>` 或 `Token <token>`。query 参数 `access_token` 在反向 WS 路由上不会被检查；Lodestar 默认发 Header，query 模式仅用于其他 OneBot 实现。
- 路径用 `/ws`。aiocqhttp 也注册 `/ws/event` 与 `/ws/api`；Lodestar 默认以 `Universal` 角色连 `/ws`。
- **确定性失败不进入指数退避**：
  - `401` / `403` → `auth_failed`；
  - `404` / `426` 等其他确定性 4xx → `handshake_failed`；
  - `408` / `429` / `5xx` / 网络错误 → 正常指数退避重连。
- 进入 `auth_failed` / `handshake_failed` 后不会自动重试，避免刷爆对端。日志包含 `statusCode`、脱敏后的 URL、是否配置 token、修复提示。
- 修复配置后：进程内可 `setAccessToken()` 后调用 `resume()`；当前 CLI 直接改环境变量并重启。`resume()` 会先关闭旧连接再发起一次新连接，避免双连。
- `/healthz` 是 **liveness**：进程活着就 200（包括 auth_failed / 离线）；`/readyz` 是 **readiness**：只有 conn=open、login=LOGGED_IN 且 health=ONLINE 才 200。健康状态没有独立探针，只由 OneBot 连接和适配器上报的登录态推导（`UNKNOWN` / `ONLINE` / `OFFLINE`）；契约见 [ADR 0008](docs/adr/0008-remove-probe.md)。
- 多账号：每个账号一个 `ReverseWsClient`，各自带 `X-Self-ID`。AstrBot 侧建议每个账号一个 OneBot v11 机器人条目，并使用独立反向 WS 端口，避免 `self_id` 路由歧义。M1 先单账号。

## 错误码与重试语义

OneBot v11 规范只定义 `status` / `retcode` 字段，**没有规定数值表**；下表只列 Lodestar 实际使用、且能给出出处的码。`status: failed` 是动作级失败：Core 只把失败响应写回当前 WebSocket，**不改变连接状态、不触发重连、不计入断线指标**。只有传输层 close/error、心跳 pong 超时、鉴权/握手确定性失败才会改变连接状态。

| retcode | status | 含义 | 出处 | Core 行为 | 是否重试 |
| --- | --- | --- | --- | --- | --- |
| 0 | ok | 成功 | OneBot v11 规范 | 主动生成 | — |
| 1 | async | 异步受理 | OneBot v11 规范 | 预留 | — |
| 100 | failed | 请求参数格式错误（当前路径：params 不是对象） | CQHTTP 3.4 API「响应说明」 | 主动生成 | 否 |
| 102 | failed | 数据无效，通常是无权限 | CQHTTP 3.4 API「响应说明」 | 预留 | 否 |
| 1400 | failed | WebSocket 对应 HTTP 400 | CQHTTP 3.2 WebSocket API | 预留 | 否 |
| 1401 | failed | WebSocket 对应 HTTP 401 | CQHTTP 3.2 WebSocket API | 仅透传/预留（握手期断连） | 否 |
| 1403 | failed | WebSocket 对应 HTTP 403 | CQHTTP 3.2 WebSocket API | 仅透传/预留（握手期断连） | 否 |
| 1404 | failed | WebSocket 对应 HTTP 404；动作不存在 | CQHTTP 3.2 WebSocket API；NapCat 兼容 | 主动生成 | 否 |
| 1500 | failed | Lodestar 内部错误 | Lodestar 自定 | 主动生成 | 否（动作级） |
| 1501 | failed | 动作处理超时 | Lodestar 自定 | 主动生成 | 否（动作级） |
| 1502 | failed | 适配器不可用 | Lodestar 自定 | 预留 | 由上层决定 |
| 1503 | failed | 背压/队列满 | Lodestar 自定 | Core 主动生成（outbox） | 可延迟重试 |
| 1504 | failed | 限流/配额（上游返回时透传） | Lodestar 自定 | 透传 | 由上层决定 |
| 1505 | failed | 版本不兼容 | Lodestar 自定 | 预留 | 否 |
| 1506 | failed | 适配器鉴权失败 | Lodestar 自定 | 预留 | 否 |
| 1507 | failed | 消息记录不存在（`get_msg`） | Lodestar 自定 | 预留 | 否 |
| 1508 | failed | 发送被禁用（预留码） | Lodestar 自定 | 预留 | 否 |

> `1401/1403` 在 CQHTTP 中通常不会出现在动作响应里：握手鉴权失败会直接断开连接。Lodestar 在连接层用 `auth_failed` 表达 401/403，不把鉴权失败当作动作 retcode。100 当前只用于 `params` 不是对象这一条路径；未来字段校验也归 100。

出处（检索/读取于 2026-11-11）：

- OneBot v11 规范：[api/README.md](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/README.md)，提交 `d4456ee`，2022-08-12。
- CQHTTP 3.4 API「响应说明」：[docs/3.4/API.md](https://github.com/kyubotics/coolq-http-api/blob/30bfedec692cd1c383ad7561af80c4744343861f/docs/3.4/API.md)，提交 `30bfede`，2018-01-20。该表定义 `0/1/100/102/103/201`；其中 **103 是“操作失败/权限或文件系统异常”，不是“动作不存在”**，Lodestar 不使用 103。
- CQHTTP 3.2 WebSocket API：[docs/3.2/WebSocketAPI.md](https://github.com/kyubotics/coolq-http-api/blob/30bfedec692cd1c383ad7561af80c4744343861f/docs/3.2/WebSocketAPI.md)，提交 `30bfede`，2017-11-15。该文档明确 `1404` 对应 HTTP 404（API 不存在）。
- 说明：`kyubotics/coolq-http-api` 是上游 `richardchien/coolq-http-api` 迁移/改名后的地址（GitHub API `full_name: kyubotics/coolq-http-api`，archived，最后 push 2020-08-02），不是第三方镜像。
- NapCat 的 `1200/1400/1401/1404` 是私有约定；`1404` 与 CQHTTP 的 404 映射一致。Core 生成 1404 仅用于动作不存在；上游 adapter 返回的其它 retcode 原样透传。

### AstrBot 收到 `status=failed` 的实际行为（源码证据）

- `aiocqhttp` 的 `_handle_api_result` 在 `status == "failed"` 时抛出 `ActionFailed`，不会自动重试；`ResultStore.fetch` 只等待带相同 `echo.seq` 的响应，超时才抛 `NetworkError`。
- AstrBot 的 respond stage 在 `event.send()` 外层 `try/except Exception`：捕获后执行 `logger.error("Failed to send the message chain...", exc_info=True)`，然后继续处理下一条；没有重试循环，也没有关闭/重建 WebSocket 的代码。
- AstrBot 在 `get_msg` / `get_group_file_url` 等转换路径里单独捕获 `ActionFailed`，记 error 并忽略该消息段。
- 结论：`status=failed` 会让 AstrBot **记一条 error + traceback（日志量与动作频率成正比，不会自我放大）**，但**不会重试、不会改连接状态、不会触发重连风暴**。
- 证据代码：[AstrBot respond/stage.py](https://github.com/AstrBotDevs/AstrBot/blob/68acac9b1ab92c2ac4cfd811c0898913a1391c8/astrbot/core/pipeline/respond/stage.py)（`event.send` 的 try/except）、[aiocqhttp_platform_adapter.py](https://github.com/AstrBotDevs/AstrBot/blob/68acac9b1ab92c2ac4cfd811c0898913a1391c8/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py)（`ActionFailed` 捕获）；AstrBot 提交 `68acac9`，2026-11-10。

## 开发命令

```bash
pnpm lint          # ESLint
pnpm format:check  # Prettier 检查
pnpm typecheck     # 全部 workspace 的 tsc --noEmit
pnpm test          # Vitest
pnpm build         # tsc 产出 dist
pnpm verify        # lint + format + typecheck + test + build
```

## Windows 安装（源码流程）

新用户请直接使用上面 Releases 里的安装包；本节是源码开发流程，需要 Node/pnpm。

源码前置：Windows x64、Node 22.16+、pnpm 10；先在仓库根目录运行 `pnpm install`。
QQ `9.9.37-54395` 已安装（默认 `D:\qq`）；AstrBot 已安装（默认 `D:\AstrBot`，
aiocqhttp 反向 WS 默认 `6199`）。

从源码目录双击 `Lodestar-Setup.cmd`，或运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
```

源码 external 流程会：

1. 自动查找 QQ 和 AstrBot 目录（注册表/运行中进程/常见路径/固定盘浅层扫描）；
2. 读取 AstrBot 的 `cmd_config.json`，自动识别 aiocqhttp 端口和 token；
3. 自动识别测试号 QQ 号（已保存配置 → loader 配置 → AstrBot 日志），都没有时只问一次；
4. 需要时弹出 UAC，自动打 9.9.37 补丁、安装 loader、启动 QQ；
5. 写入 `config/upstream.json`，启动 Core，打开 `http://127.0.0.1:18081` 并打印管理 token。

之后再次双击就是纯启动，不再询问。QQ 登录仍需你在 QQ 窗口完成；脚本会提示并等待
最多 300 秒。缺少 AstrBot、端口或 QQ 时会明确报错，**不会回退到 mock**。

- `-Demo` 仅保留给开发自测：`setup.ps1 -Demo`。
- `-SkipLoaderInstall` 用于已经有 OneBot 服务监听 `3001` 的场景（NapCat/LLOneBot/已装 loader）。
- 只支持冻结的 QQ `9.9.37-54395`；QQ 升级后 patcher 会拒绝执行。

> 如果卡在“需要管理员权限”且看不到 UAC：先完全退出 QQ，再双击 `Lodestar-Setup.cmd`，
> 脚本会用普通权限启动 QQ，不需要 UAC；或者右键 `Lodestar-Setup.cmd` → 以管理员身份运行。
> 已经登录 QQ 时，3001 正常监听就不会再要求提权。

## 真实 OneBot 上游（NapCat / SnowLuma）

> **定位说明：这是兼容/迁移后端，不是 Lodestar 的默认形态。** Lodestar 的默认后端是原生 NTQQ loader，直接附着真实 QQ 客户端，不经过 NapCat/SnowLuma/LLOneBot。上游适配器只用于：迁移期验证 Core 的协议与投递，以及在原生 loader 不可用时作为降级路径。

Lodestar 作为网关时，上游需要一个 OneBot v11 WebSocket **服务端**（不是反向 WS 客户端）：

1. 在 NapCat/SnowLuma 中启用 WebSocket 服务（NapCat 常见端口 `3001`），设置 Token。
2. 复制配置并填写：

```powershell
Copy-Item config\upstream.example.json config\upstream.json
```

- `upstream.url`：上游 WS 地址，如 `ws://127.0.0.1:3001/`
- `upstream.token`：上游 WS Token
- `astrbot.url`：AstrBot 反向 WS 地址，如 `ws://127.0.0.1:6199/ws`
- `astrbot.token`：AstrBot 的 OneBot v11 Token
- `selfId`：QQ 号

3. 运行：

```powershell
node scripts\upstream.mjs
```

Windows 常驻：仓库不再内置服务安装脚本。需要开机自启时，用计划任务或 NSSM 等工具
以仓库根目录为工作目录运行 `node scripts\upstream.mjs`。

## Web 控制面板（本地）

只监听 `127.0.0.1` 的本地状态面板，用于查看连接、登录态、队列和指标；
**不提供发送框**，发送仍只走 AstrBot → Core → loader。

```bash
pnpm build
```

```bash
LODESTAR_ADMIN_TOKEN=replace-with-a-local-token node scripts/upstream.mjs
```

打开 `http://127.0.0.1:18081`，输入同一管理密码。Windows 用 `$env:LODESTAR_ADMIN_TOKEN="..."`。
面板包含总览、协议端配置、指标、系统和三步初始化引导；支持深色/浅色主题切换。
系统页可以修改管理密码，并终止当前 Core 进程（QQ、loader、AstrBot 不受影响）。协议端配置保存后
平滑重启 Core 连接（面板不断线），总览异常可直接“尝试重启核心服务”；指标页展示健康状态、
就绪、OneBot 连接和队列长度。面板不做公网部署、多用户登录、移动端适配。
详见 [Web 控制面板设计](docs/design/admin-panel.md)。

## 存储

默认使用 Node 内置 `node:sqlite`（Node 22.16+，零 native 依赖），封装在 `SqliteDriver` 接口后；`better-sqlite3` 作为经 CI 验证的备选 driver，不作为默认依赖。取舍、API Added-in 与 CI 验证矩阵见 [ADR 0006](docs/adr/0006-storage-engine.md)。

## 仓库结构

```text
lodestar-qq/
├─ packages/core/
│  ├─ src/onebot/          # 反向 WS 客户端、动作路由、退避、鉴权
│  ├─ src/adapter/         # AdapterEvent/PublishResult、EventSink、eventKey、meta 拒收
│  ├─ src/storage/         # schema、node:sqlite driver、EventStore、OutboxDispatcher
│  ├─ src/observability/   # /healthz /readyz /metrics
│  ├─ src/runtime/         # CoreRuntime：Adapter→EventSink→Outbox→ReverseWsClient；health.ts 运行状态
│  ├─ src/admin/           # 本地管理 HTTP API（127.0.0.1 + token）
│  ├─ src/config.ts        # 配置 schema
│  ├─ src/logger.ts        # 结构化日志
│  ├─ src/main.ts          # 开发用 CLI
│  ├─ tests/               # Vitest + mock WS 服务
│  └─ dist/                # 构建产物（gitignored）
├─ packages/adapter-mock/  # MockAdapter：emit/freeze/crash/动作桩 + HTTP 控制面（测试/演示）
│  ├─ src/
│  └─ tests/
├─ packages/adapter-onebot-upstream/  # OneBot v11 上游 WS 客户端（连接 loader）
├─ packages/web/           # 本地状态面板（零框架 TS SPA）
├─ spike/ntqq-loader/      # NTQQ loader + OneBot 服务（安装器随包分发）
├─ docs/adr/               # 架构决策记录（0001–0009）
├─ docs/design/            # AdapterInterface、面板设计
├─ docs/quickstart.md      # Windows 安装与启动指南
├─ docs/linux.md           # Linux 网关部署指南
├─ config/upstream.example.json
├─ scripts/windows/        # bootstrap-external、setup（源码）
├─ scripts/release/        # 安装包构建（Windows zip / Linux tar.gz）
├─ scripts/upstream.mjs    # external runtime 入口
├─ scripts/dev-mock.mjs    # 本地 mock 演示入口
├─ Dockerfile.linux        # Linux 网关镜像
├─ docker-compose.linux.yml # Linux 网关部署
├─ deploy/                 # systemd 单元示例
├─ .github/workflows/      # CI 与发布
├─ package.json
├─ pnpm-workspace.yaml
└─ README.md
```

## 设计目标（非承诺）

下表是设计目标，不是承诺；未实测的一律写“待测”。

| 指标 | 设计目标（非承诺） | 实测值 |
| --- | --- | --- |
| 冷启动到 AstrBot 适配器连接 | ≤ 60s | 待测 |
| 消息投递成功率 | ≥ 99% | 待测 |
| 重复投递率（端到端，AstrBot 侧按 message_id） | ≤ 0.1% | 待测 |
| Core 空闲 RSS（不含 QQ 客户端） | ≤ 150MB | 待测 |
| 整机内存（含 QQ 客户端） | ≤ 1.2GB | 待测 |
| 新手按 README 完成部署 | ≤ 30 分钟 | 待测 |

## 风险与合规

**注入路线属于第三方方案，与腾讯/QQ 无隶属或授权关系。它只能降低、不能归零账号被风控、踢下线或封禁的风险；风险由使用者自担。**

Lodestar 不内置发送侧的风控、白名单或限流：AstrBot 发什么就发什么。风险控制交给使用方式：

- 只在测试群、只响应被 @ 或唤醒前缀触发的消息，不做主动群发；
- 控制消息频率（在 AstrBot 侧配置或人工掌握）；
- 发现异常时立即停止 Core 进程并关闭 QQ；
- **合规性由使用方式兜底，而不是由后端类型兜底。** 请遵守《QQ 用户协议》和当地法律，仅用于个人或小规模合法用途。

## 非目标

- 不做批量注册、养号、群发营销、加好友引流。
- 不做绕过验证码、安全验证或风控校验的对抗手段。
- 不承诺“绝对不封号”。
- 不提供官方 QQ Bot API 适配器（见 ADR 0001）。
- 不打包或修改分发 SnowLuma、NapCat 等限制性许可证项目。

## 许可证与商用边界

- `@lodestar/core` 及本项目自有代码：**Apache-2.0**。
- 可选适配器独立打包、独立仓库、独立许可证；不把限制性许可证代码混入 Core。
- 商用：Core 允许商业使用（按 Apache-2.0 保留声明与免责）；适配器可能另有许可证限制；使用者需自行遵守 QQ 协议与第三方项目许可证。
- 本项目不提供任何形式的账号安全担保。

## 文档

- [贡献指南](CONTRIBUTING.md)
- [安装与启动指南（Windows）](docs/quickstart.md)
- [Linux 部署指南](docs/linux.md)
- [Web 控制面板设计](docs/design/admin-panel.md)
- [AdapterInterface 设计稿](docs/design/adapter-interface.md)
- [ADR 0001：后端范围与官方 Bot API 的否决](docs/adr/0001-backend-scope.md)
- [ADR 0002：Core 与适配器的许可证边界](docs/adr/0002-license-boundary.md)
- [ADR 0003：OneBot retcode 策略](docs/adr/0003-retcode-policy.md)
- [ADR 0004：连接、鉴权与 heartbeat 状态机](docs/adr/0004-connection-auth-heartbeat.md)
- [ADR 0005：Adapter 事件契约与投递语义](docs/adr/0005-event-contract.md)
- [ADR 0006：SQLite 存储引擎选型](docs/adr/0006-storage-engine.md)
- [ADR 0007：风险缓释开关（已由 ADR 0009 取代）](docs/adr/0007-risk-controls.md)
- [ADR 0008：移除独立探针，健康状态改由连接与登录态推导](docs/adr/0008-remove-probe.md)
- [ADR 0009：移除 SendGuard](docs/adr/0009-remove-send-guard.md)
