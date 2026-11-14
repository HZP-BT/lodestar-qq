# Lodestar（lodestar-qq）

<p align="center"><img src="packages/web/public/logo.jpg" alt="Lodestar" width="240" /></p>

> 产品名已正式更名 **Lodestar**。为兼容已有部署，`POLARIS_*` 环境变量、`polaris_*` 指标名、
> `data/polaris.db` 和 native loader 的 `polaris-loader.js` 文件名仍保留；新配置优先使用
> `LODESTAR_*`。Core 继续使用 Apache-2.0。

Lodestar 是一个 **Apache-2.0 的 OneBot v11 运行时**，面向“附着真实 NTQQ 客户端 + 工程化保活”的场景。Core 与客户端适配器分离：Core 负责协议、会话、可靠性、独立探针、可观测与 WebUI；适配器可以是外部 OneBot 后端（M1）或原生 NTQQ 注入适配器（M3 spike）。

## 下载与安装（新用户，推荐）

从 [GitHub Releases](../../releases) 下载 `lodestar-portable-0.1.0-m1.2-windows-x64.zip`。
解压后双击 `Lodestar-Setup.cmd`。包内自带 Node、Core、WebUI 和 QQ loader，
**不需要安装 Node 或 pnpm**。

前置条件：

- Windows 10/11 x64；
- QQ `9.9.37-54395`（安装器会自动查找安装目录，常见 `D:\qq`）；
- AstrBot 已安装（自动查找，常见 `D:\AstrBot`），并启用 aiocqhttp 反向 WS（默认 `6199`）；
- 管理员权限（首次打补丁/安装 loader 需要 UAC）；
- 只使用测试号。

完整步骤、SendGuard 默认值、群/私聊配置、故障排查和回滚见
[便携版新用户指南](docs/portable-quickstart.md)。

> 注入/补丁路线属于第三方方案，与腾讯/QQ 无隶属或授权关系；它只能降低、不能归零
> 账号被风控、踢下线或封禁的风险。请只使用测试号，并自行承担风险。

> 当前状态：M1.1–M1.5 已交付（Docker Compose 尚未实机验证）；OneBot 上游适配器作为
> 兼容/迁移后端保留；原生 NTQQ loader 已在本机 9.9.37 上跑通私聊/群文本、图片/语音
> 和 OneBot 动作；接口、目录和补丁仍会随 QQ 版本调整，不构成生产级保证。

## 为什么做 Lodestar

- NapCat 无头版频繁掉线、账号被封；SnowLuma 转为私有 不再公开。
- 现有方案的保活边界通常在“进程内 Hook”：进程和 WebSocket 都活着，但数据面已经停止。Lodestar 用**独立探针**从外部验证数据面，而不是依赖 `status.good`。
- 许可证：Core 使用 Apache-2.0；不打包 SnowLuma、NapCat 等限制性许可证代码。可选注入后端放在独立包/独立仓库，按各自许可证分发。

## 架构（M1.2 A 组第一步）

```
AstrBot ── reverse WS (6199/ws, Bearer token) ──►  @lodestar/core
                                                   ├─ OneBot v11 反向 WS 客户端
                                                   ├─ 动作路由 / echo 精确回传
                                                   ├─ SendGuard（STOP/白名单/@/配额/限频）
                                                   ├─ EventSink.publish（拒绝 meta、去重、outbox）
                                                   ├─ EventStore（node:sqlite：dedup/outbox/message_ref）
                                                   ├─ OutboxDispatcher（按 deliverSeq 重放）
                                                   ├─ Probe（ONLINE/IDLE/DEGRADED/OFFLINE）
                                                   ├─ Watchdog（独立 worker，阻塞时 SIGKILL）
                                                   ├─ 心跳、指数退避重连、并发上限
                                                   └─ 结构化日志（pino）
```

`SendGuard` 与 `EventSink` 都在 Core，与外部 OneBot 后端或原生注入后端无关。后续里程碑加入 `@lodestar/adapter-mock`、`@lodestar/probe`、Docker Compose 与 WebUI。架构决策见 ADR 0001–0007。

- [ADR 0001：后端范围与官方 Bot API 的否决](docs/adr/0001-backend-scope.md)
- [ADR 0002：Core 与适配器的许可证边界](docs/adr/0002-license-boundary.md)

> 如果你拿到的是 `lodestar-portable-*-windows-x64.zip`，请直接按上面的
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

这条路径不需要 QQ、不需要 patcher，适合先验证 Core、SendGuard、审计和 WebUI。真实 QQ 需要额外的 OneBot 上游或独立 native adapter，不在 Core 仓库内分发。

## 快速开始（M1.1）

要求：Node.js 22.16+ / 24 / 26（LTS 线），pnpm 10。本机 Node 26.13 已跑通；CI 矩阵覆盖 22 / 24 / 26，并有 22.16.0 最低版本 job。

> **运行时 SQLite**：请使用官方 Node.js 安装包或官方 Docker 镜像。部分发行版/第三方 Node 包可能未编入 SQLite，`node:sqlite` 会不可用；Lodestar 启动时会 feature-detect 并输出当前 Node/ABI/诊断，可改用官方二进制或 `better-sqlite3` driver（ADR 0006）。

```bash
npm install -g pnpm@10
pnpm install
```

启动 core 并连接 AstrBot 的反向 WebSocket：

```bash
LODESTAR_ONEBOT_URL=ws://127.0.0.1:6199/ws \
LODESTAR_ONEBOT_TOKEN=your-token \
LODESTAR_SELF_ID=123456789 \
pnpm --filter @lodestar/core dev
```

Windows PowerShell：

```powershell
$env:LODESTAR_ONEBOT_URL = "ws://127.0.0.1:6199/ws"
$env:LODESTAR_ONEBOT_TOKEN = "your-token"
$env:LODESTAR_SELF_ID = "123456789"
pnpm --filter @lodestar/core dev
```

AstrBot 侧：新建 `OneBot v11` 机器人，反向 WS 主机 `0.0.0.0`、端口 `6199`，填写同一 Token。日志出现 `aiocqhttp(OneBot v11) 适配器已连接` 即成功。

> `LODESTAR_SELF_ID=0` 只用于 mock/演示；真实使用时必须填 QQ 号，否则 AstrBot 可能把动作路由到错误的账号。
>
> **M1.1 演示动作说明**：core 目前只注册 `get_login_info` / `get_version_info` / `get_status` 三个动作；其他动作返回 `1404`（CQHTTP WebSocket 的 404 / action not found），这是 M1.1 的预期行为，不是故障。真实动作由后续 adapter 提供。
>
> M1.1 还没有 adapter 的登录确认，`loginState` 默认 `UNKNOWN`，所以 heartbeat 与 `get_status` 的 `online` 为 `false`、`good` 为 `false` 属预期；M1.2 adapter 接入并由登录事件确认后才变 `true`。这不是“假在线”的反向版本，而是拒绝自证。

## 鉴权失败与恢复

- AstrBot/aiocqhttp 的反向 WebSocket **只检查 `Authorization` 请求头**，支持 `Bearer <token>` 或 `Token <token>`。query 参数 `access_token` 在反向 WS 路由上不会被检查；Lodestar 默认发 Header，query 模式仅用于其他 OneBot 实现。
- 路径用 `/ws`。aiocqhttp 也注册 `/ws/event` 与 `/ws/api`；Lodestar 默认以 `Universal` 角色连 `/ws`。
- **确定性失败不进入指数退避**：
  - `401` / `403` → `auth_failed`；
  - `404` / `426` 等其他确定性 4xx → `handshake_failed`；
  - `408` / `429` / `5xx` / 网络错误 → 正常指数退避重连。
- 进入 `auth_failed` / `handshake_failed` 后不会自动重试，避免刷爆对端。日志包含 `statusCode`、脱敏后的 URL、是否配置 token、修复提示。
- 修复配置后：进程内可 `setAccessToken()` 后调用 `resume()`；当前 CLI 直接改环境变量并重启。`resume()` 会先关闭旧连接再发起一次新连接，避免双连。
- `/healthz` 是 **liveness**：进程活着就 200（包括 DEGRADED / auth_failed），body 里带三轴状态；`/readyz` 是 **readiness**：只有 conn=open、login=LOGGED_IN、health∈{ONLINE,IDLE} 才 200，DEGRADED / OFFLINE / auth_failed 都 503。DEGRADED 用 `polaris_health_state{state="DEGRADED"}` 告警，不要依赖 healthz 状态码。实现随 M1.4 落地，契约见 [ADR 0004](docs/adr/0004-connection-auth-heartbeat.md)。
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
| 1503 | failed | 背压/队列满 | Lodestar 自定 | M1.2 主动生成（outbox） | 可延迟重试 |
| 1504 | failed | Lodestar 限流/配额 | Lodestar 自定 | M1.2 主动生成（SendGuard） | 可延迟重试 |
| 1505 | failed | 版本不兼容 | Lodestar 自定 | 预留 | 否 |
| 1506 | failed | 适配器鉴权失败 | Lodestar 自定 | 预留 | 否 |
| 1507 | failed | 消息记录不存在（`get_msg`） | Lodestar 自定 | 预留 | 否 |
| 1508 | failed | 发送被 STOP 禁用 | Lodestar 自定 | 主动生成（SendGuard） | 否 |

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

## Docker Compose（本地 demo）

```bash
docker compose up -d
docker compose logs -f lodestar-core
```

默认启动 `lodestar-core`（MockAdapter + 内置 mock AstrBot + WebUI）。日志会打印面板地址和 token；token 同时持久化在宿主机的 `data/admin-token`。端口只发布到宿主机回环地址：

- `127.0.0.1:18080`：`/healthz`、`/readyz`、`/metrics`
- `127.0.0.1:18081`：Web 控制面板
- `127.0.0.1:18090`：adapter-mock HTTP 控制面

```bash
curl http://127.0.0.1:18080/healthz
curl http://127.0.0.1:18080/readyz
curl -X POST http://127.0.0.1:18090/emit -H "Content-Type: application/json" -d '{"text":"hello"}'
```

容器内 AdminServer 通过 `LODESTAR_ADMIN_ALLOW_NON_LOOPBACK=1` 绑定容器网络；Compose 只把 `18081` 发布到宿主机 `127.0.0.1`。不要把该端口改成 `0.0.0.0` 或暴露到公网。当前开发机未安装 Docker，Compose 未在本机实机复验；本地 mock 演示以 `pnpm demo` 为准。

`healthcheck` 使用 `/readyz`：`interval: 30s`、`timeout: 5s`、`start_period: 60s`、`retries: 3`；`restart: unless-stopped` 只处理进程退出，**healthcheck unhealthy 不会自动重启容器**。DEGRADED 由 `/readyz` 503 + `polaris_health_state` 指标告警，不靠 healthz 状态码。

## Windows 便携版与源码流程

新用户请直接使用上面 Releases 里的便携包；本节是源码开发流程，需要 Node/pnpm。

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

### mock 演示包（开发/演示，不是 external）

`Lodestar-Demo.cmd` 的 mock 包自带 `node.exe`、Core、WebUI 和 mock 后端，不需要 Node/pnpm。
面板会明确显示 **“演示模式（Mock）”**，状态不代表真实 QQ/AstrBot；它只用于演示界面和
SendGuard，不参与 external 流程。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release\package-windows.ps1 -IncludeNode
```

产物在 `release/`：包含 `lodestar-demo.cjs`、WebUI、`Lodestar-Demo.cmd` 和可选
`node.exe` 的 zip + `SHA256SUMS.txt`。

> 公开 Release 的主下载是 `lodestar-portable-*.zip`（面向新用户，包含本地 loader/patcher）；
> mock 演示包只用于开发/演示。源码仓库不提交 `node_modules`、`dist`、`data`、`logs`
> 或本地 `config/*.json`。

## Windows 安装（M1.5）

前置：Node 22.16+、pnpm 10、已 `pnpm install && pnpm build`。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 `
  -SelfId "123456789" `
  -Token "your-token" `
  -GroupId "987654321"
```

安装脚本会：

- 从 `config/polaris.example.json` 生成 `config/polaris.json`（已存在则不覆盖，参数可更新）；
- 校验 Node 版本、配置与入口文件；
- 注册 **计划任务** `LodestarCore`（登录时启动，失败每分钟重试，最多 999 次）；
- 创建 `logs/`、`data/`，并输出路径。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\stop.ps1
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall.ps1
```

- `stop.ps1` 先写 `data/STOP`（下一次发送立即停发），再停止计划任务/进程。
- 计划任务在**当前用户登录时**启动；若需要未登录也运行，请改用 Windows 服务（需管理员/服务账号），不要用计划任务硬绕。
- 若 `Register-ScheduledTask` 被拒绝，请用管理员 PowerShell 重新运行 `install.ps1`。
- 配置模板：[config/polaris.example.json](config/polaris.example.json)；环境变量覆盖参考：[.env.example](.env.example)。
- 服务入口默认 `packages/core/dist/main.js`；当前 M1.5 是服务封装，真实 adapter 接入后只需改 `entrypoint`/env，无需改脚本。
- `-Entrypoint <path>` 可显式覆盖入口（优先级高于 `config.entrypoint`），无需编辑 `polaris.json`。

### dev-mock 全链路验证

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -DevMock -Start
```

- 等价于把计划任务入口设为 `scripts/dev-mock.mjs`，`install.log` 会记录 `MODE=dev-mock`；没有现成配置时自动使用 demo `selfId=10001`。
- dev-mock 会占用 **18080/18090**，并与真实后端互斥；验证完再运行一次不带 `-DevMock` 的 `install.ps1` 即可切回默认入口。
- 验证顺序：`/readyz` → `POST /emit` → `stop.ps1`。

PowerShell 推荐用 `Invoke-RestMethod`，避免 `curl.exe` 的 JSON 引号问题：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:18090/emit -ContentType "application/json" -Body '{"text":"hello"}'
```

> PowerShell 5.1 给 `curl.exe` 传 `-d '{"text":"hello"}'` 时仍可能吞掉 JSON 引号，控制面会返回 `{"error":"invalid JSON body"}`。这是预期的 400 校验，不是服务故障；请用上面的 `Invoke-RestMethod`。

## M3 预研：原生 NTQQ 注入 spike

隔离目录 [spike/ntqq-inject](spike/ntqq-inject/README.md) 用于验证原生后端的底层能力，不属于
Core 依赖：

- 已实现 PE manual map（重定位、IAT、远程线程）与命名管道回报；
- 良性 target 上累计执行 5 次，4 次通过完整断言（退出码 0、管道消息、target 存活）；
- 负载用 Zig 构建为 3,072 字节、仅导入 kernel32 的 DLL，无 CRT/TLS 依赖；
- **未注入 QQ**，未接入 Core，也没有任何消息/登录 hook；
- Defender 对注入器有间歇性 `Trojan:Win32/Bearfoos.A!ml` 误报，尚未处理排除项或签名；
- 本机 QQ 为 `9.9.33.52230`（`D:\qq`，x64），探测结果见
  [evidence](spike/ntqq-inject/evidence/probe-qq-2026-11-12.txt)。

在 S1（良性附着 QQ）之前，需要先决定 Defender/装载路径问题。详见 spike 的
[README](spike/ntqq-inject/README.md) 与 [EVIDENCE](spike/ntqq-inject/EVIDENCE.md)。

装载路径的单独评估见 [NTQQ 附着路径评估](docs/design/ntqq-loading-path.md)：QQNT
没有腾讯官方插件 API；LiteLoaderQQNT 需要绕过 QQ 文件完整性校验且上游已归档；
NapCat 的 Windows 路线是启动注入。S0 已在该路线上完成自研 loader 与 OneBot 收发的
最小验证，不再重复论证路线。

S0 验证已收束，S0 边界、S1 关键路径和 backlog 见
[S0 结案与 S1 边界](docs/design/s0-closure-and-s1-boundary.md)。S1 只做 SendGuard
与低量观察，不新增收发/媒体功能点。

## 真实 OneBot 上游（NapCat / SnowLuma）

> **定位说明：这是 M1 的兼容/迁移后端，不是 Lodestar 的最终形态。** Lodestar 的目标后端是原生 NTQQ 注入适配器（M3 spike），直接附着真实 QQ 客户端，不经过 NapCat/SnowLuma/LLOneBot。上游适配器只用于：迁移期验证 Core 的探针/保活/可观测/协议，以及在原生注入 spike 失败时作为降级路径。

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

Windows 服务模式：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -Entrypoint scripts\upstream.mjs -Start
```

- `scripts/upstream.mjs` 读取 `config/upstream.json`；`service-runner` 的 `config/polaris.json` 仅用于 DevMock/默认入口，不会覆盖上游配置。
- 默认入口仍是 `packages/core/dist/main.js`；`-DevMock` 仍指向 mock，三种入口互斥。

## Web 控制面板（本地）

S1-b 起提供只监听 `127.0.0.1` 的本地控制面板，用于查看状态、审计、指标并管控 SendGuard；
**不提供发送框**，发送仍只走 OneBot/AstrBot → Core → SendGuard。

```bash
pnpm build
```

```bash
LODESTAR_ADMIN_TOKEN=replace-with-a-local-token node scripts/upstream.mjs
```

打开 `http://127.0.0.1:18081`，输入同一管理密码。Windows 用 `$env:LODESTAR_ADMIN_TOKEN="..."`。
面板包含总览、协议端配置、SendGuard、审计、指标、系统和三步初始化引导；支持深色/浅色主题切换。
系统页可以修改管理密码，并终止当前 Core 进程（QQ、loader、AstrBot 不受影响）。协议端配置保存后
平滑重启 Core 连接（面板不断线），总览异常可直接“尝试重启核心服务”；审计默认 2s
自动刷新，指标图带刻度、时间轴和悬停数值。急停/恢复/reset 统一收纳在 SendGuard 页，
并需要输入确认词。面板不做公网部署、多用户登录、移动端适配；审计接口只返回哈希/元数据，
不返回正文或明文 UID。详见 [Web 控制面板设计](docs/design/admin-panel.md)。

## 存储

默认使用 Node 内置 `node:sqlite`（Node 22.16+，零 native 依赖），封装在 `SqliteDriver` 接口后；`better-sqlite3` 作为经 CI 验证的备选 driver，不作为默认依赖。取舍、API Added-in 与 CI 验证矩阵见 [ADR 0006](docs/adr/0006-storage-engine.md)。

## 仓库结构（M1.2 A 组第一步）

```text
lodestar-qq/
├─ packages/core/
│  ├─ src/onebot/          # 反向 WS 客户端、动作路由、退避、鉴权
│  ├─ src/adapter/         # AdapterEvent/PublishResult、EventSink、eventKey、meta 拒收
│  ├─ src/storage/         # schema、node:sqlite driver、EventStore、OutboxDispatcher、运行期探测
│  ├─ src/probe/           # 健康状态机 + 独立 worker Watchdog
│  ├─ src/observability/   # /healthz /readyz /metrics
│  ├─ src/runtime/         # CoreRuntime：Adapter→EventSink→Outbox→ReverseWsClient
│  ├─ src/send-guard.ts    # STOP/白名单/@触发/配额/限频/熔断/审计
│  ├─ src/admin/           # 本地管理 HTTP API（127.0.0.1 + token）
│  ├─ src/config.ts        # 配置 schema
│  ├─ src/logger.ts        # 结构化日志
│  ├─ src/main.ts          # 开发用 CLI
│  ├─ tests/               # Vitest + mock WS 服务 + A1–A6 + B/C
│  └─ dist/                # 构建产物（gitignored）
├─ packages/adapter-mock/  # MockAdapter：emit/freeze/crash/canary/动作桩 + HTTP 控制面
│  ├─ src/                 # mock-adapter.ts、control-server.ts
│  └─ tests/
├─ packages/adapter-onebot-upstream/  # 真实 OneBot 上游 WS 客户端
├─ packages/web/           # 本地 SendGuard 控制面板（零框架 TS SPA）
├─ docs/adr/               # 架构决策记录（0001–0007）
├─ docs/design/            # AdapterInterface、mock 用例
├─ docs/evidence/          # 原始依赖证据
├─ docs/m1-acceptance.md   # M1“一条命令启动”子项
├─ docs/runbooks/          # 24h 冒烟
├─ config/polaris.example.json
├─ .env.example
├─ scripts/windows/        # install/start/stop/uninstall/service-runner
├─ scripts/dev-mock.mjs    # Compose 演示入口：mock AstrBot + CoreRuntime + health
├─ Dockerfile
├─ docker-compose.yml
├─ .github/workflows/ci.yml
├─ package.json
├─ pnpm-workspace.yaml
└─ README.md
```

## 设计目标 vs 实测值

下表是**设计目标，不是承诺**。实测值会在 M1/M2 的测试报告中回填；未实测的一律写“待测”。

| 指标 | 设计目标（非承诺） | 实测值 |
| --- | --- | --- |
| 冷启动到 AstrBot 适配器连接 | ≤ 60s | 待测 |
| 静默假死检出（进程活着、数据面停摆） | ≤ 90s | 待 M1.4 |
| 消息投递成功率 | ≥ 99% | 待 M1.2 |
| 重复投递率（端到端，AstrBot 侧按 message_id） | ≤ 0.1% | 待 72h 联调 |
| Core 空闲 RSS（不含 QQ 客户端） | ≤ 150MB | 待测 |
| 整机内存（含 QQ 客户端） | ≤ 1.2GB | 待实测 |
| 新手按 README 完成部署 | ≤ 30 分钟 | 待测 |

## 风险与合规

**注入路线属于第三方方案，与腾讯/QQ 无隶属或授权关系。它只能降低、不能归零账号被风控、踢下线或封禁的风险；风险由使用者自担。**

Lodestar 配套的降风险手段是：

- **最小频控**：按账号/群/动作限流，默认保守。
- **行为正常化**：随机延迟、静默时段、重复抑制、群白名单、@ 触发、每日额度。
- **可一键停用**：发现异常时立即停止发送并保留状态，人工处理后再恢复。
- **可观测**：断连原因、探针结果、消息成功率、内存曲线都可查。

**SendGuard（S1-b 产品化）**：默认空群白名单（拒绝所有群发）、私聊开启（白名单空=允许所有私聊，
填写后仅允许列表）、@ 触发默认关闭、日配额 200、群配额 80、同群最小间隔 2s、静默时段默认关闭、
重复抑制、`data/STOP` 立即生效；配额/速率/熔断/审计持久化到 SQLite，审计只记元数据不记正文；
探针 DEGRADED/OFFLINE、连续发送失败或显式安全信号会打开熔断，只允许人工 reset。详见
[ADR 0007](docs/adr/0007-risk-controls.md)。

**合规性由使用方式兜底，而不是由后端类型兜底。** 请遵守《QQ 用户协议》和当地法律，仅用于个人或小规模合法用途。

### 24h 主力号冒烟的风险说明

M2 可能用你的主力号做一次 24h 冒烟。必须按最小风险执行：

- 只在一个白名单测试群里、只在被 @ 时回复；不开主动群发、不加好友、不做营销。
- 最小消息量：建议 ≤1 条/15 分钟，日上限 ≤96 条；脚本提供每日额度与一键停用。
- 随时可一键停用：停止 Core 进程；Core SendGuard 在每次发送前同步检查 `data/STOP`，
  下一次发送立即返回 1508（5s timer 只维护状态/指标）。
- **即使如此，账号仍可能被风控/踢下线/封禁；风险由使用者自担。** 不能接受该风险时，不要用主力号，继续用 mock/回环。
- 72h 真实投递仍以 mock/回环为主；24h 冒烟只证明“能稳定跑”，不证明“零风险”。

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
- [M1 验收子项：一条命令启动与可观测](docs/m1-acceptance.md)
- [ADR 0001：后端范围与官方 Bot API 的否决](docs/adr/0001-backend-scope.md)
- [ADR 0002：Core 与适配器的许可证边界](docs/adr/0002-license-boundary.md)
- [ADR 0003：OneBot retcode 策略](docs/adr/0003-retcode-policy.md)
- [ADR 0004：连接、鉴权与 heartbeat 状态机](docs/adr/0004-connection-auth-heartbeat.md)
- [ADR 0005：Adapter 事件契约与投递语义](docs/adr/0005-event-contract.md)
- [ADR 0006：SQLite 存储引擎选型](docs/adr/0006-storage-engine.md)
- [ADR 0007：风险缓释开关（频控/白名单/@触发/STOP）](docs/adr/0007-risk-controls.md)
- [AdapterInterface 设计稿](docs/design/adapter-interface.md)
- [adapter-mock 用例清单](docs/design/adapter-mock-cases.md)
- [S0 结案与 S1 边界](docs/design/s0-closure-and-s1-boundary.md)
- [Web 控制面板设计](docs/design/admin-panel.md)
- [便携版新用户指南](docs/portable-quickstart.md)
- [S1-a 14 天低量观察 Runbook](docs/runbooks/s1a-14d-observation.md)
- [S1 安全限制与测试环境清理](docs/runbooks/s1-safety-and-cleanup.md)
- [24h 主力号冒烟 Runbook](docs/runbooks/24h-smoke.md)
