# ADR 0004：登录、连接、健康三轴与鉴权状态机

- 状态：Accepted（修订）
- 日期：2026-11-11
- 决策者：项目所有者、维护者

## 三条状态轴

之前把 `AUTH_FAILED` 放进 `HealthState`，导致探针域与连接域重叠，heartbeat 的 `online` 也被链路/数据面污染。现拆成三轴：

| 轴 | 取值 | 来源 | 用途 |
| --- | --- | --- | --- |
| `loginState` | `UNKNOWN` / `LOGGED_IN` / `LOGGED_OUT` | **adapter 确认**：外部 OneBot 后端由 Core 在连接后调 `get_login_info`；原生注入后端由 adapter 上报登录事件 | 只决定 `heartbeat.status.online` |
| `connState` | `idle` / `connecting` / `open` / `waiting` / `closed` / `auth_failed` / `handshake_failed` | WebSocket 握手与传输层 | 决定是否重连、是否可发 heartbeat |
| `healthState` | `UNKNOWN` / `ONLINE` / `IDLE` / `DEGRADED` / `OFFLINE` | **独立 probe** | 只决定 `heartbeat.status.good` |

硬规则：

- `heartbeat.status.online = (loginState === LOGGED_IN)`。
- `heartbeat.status.good = (healthState === ONLINE || healthState === IDLE)`。
- **probe 禁止修改 `online`；adapter 禁止修改 `good`。**
- `AUTH_FAILED` 只属于 `connState`，不再出现在 `HealthState`。

### loginState 的推进

- **外部 OneBot 后端（M1）**：Core 在反向 WS/适配器连接建立后，主动调用 `get_login_info`；返回非零 `user_id` → `LOGGED_IN`；调用失败或 `user_id=0` → `UNKNOWN`（可重试）或 `LOGGED_OUT`（明确登出）。
- **原生注入后端（M3）**：adapter 通过登录事件/health 快照显式上报 `loginState`；Core 不猜测。
- 冷启动目标：连接到首个 `online:true` 的 heartbeat ≤ **5s**；`get_login_info` 超时/失败要告警，不能把 `online` 自证为 true。

## heartbeat 内容

| loginState | healthState | online | good | 发送 |
| --- | --- | --- | --- | --- |
| LOGGED_IN | ONLINE | true | true | 正常间隔（30s） |
| LOGGED_IN | IDLE | true | true | 30s；长时间零入站但动作面健康，视为可用 |
| LOGGED_IN | DEGRADED | true | false | 缩短间隔（10s） |
| LOGGED_IN | OFFLINE | true | false | 10s；账号仍登录，但数据面已死 |
| LOGGED_IN | UNKNOWN | true | false | 30s；尚未完成探针 |
| LOGGED_OUT | 任意 | false | 由 healthState 决定 | 30s 或按策略停发 |
| UNKNOWN | 任意 | false | 由 healthState 决定 | 30s；adapter 尚未确认登录 |
| 任意 | 任意，且 connState=auth_failed/handshake_failed/closed | — | — | 不发（WS 不可用） |

heartbeat 默认**只发标准 OneBot 字段**（`status.online` / `status.good` / `interval`），不附加 `polaris_state`。

## 主动/被动探针目标

`get_group_list` 能通不代表能收到新消息；SnowLuma 的假死正是“动作可通、事件停摆”。探针必须分两层：

### 1. 动作面探针（15s 一次，5s 超时）

- 调用：`get_login_info`。OneBot v11 该接口没有 nonce 参数，**nonce 只放在反向 WS 请求的 `echo` 里**做本地关联，不塞进 `params`，避免对端判 100。
- 判定：动作 RTT、retcode、返回字段。只证明“动作面活着”，**不能单独判 ONLINE**。

### 2. 入站面探针

Adapter 暴露：

```ts
interface InboundProbeSnapshot {
  inboundCursor: number;   // 客户端收到的原始入站消息计数/序列，先于过滤
  lastInboundAt: number;
  eventSeq: number;        // 已上报 Core 的事件序号
  lastEventAt: number;
}
```

- **被动**：活跃会话下，`inboundCursor` 在 60s 内不前进 → DEGRADED；120s → OFFLINE。静默时段不作为唯一判据。
- **主动 canary**（推荐用于 72h 测试）：独立 canary 发送账号向白名单测试群发送带 nonce 的消息；probe 从 **adapter 的过滤前入站面**（`inboundCursor` / `lastInboundAt` / `inboundNonceSeen`）确认 nonce，而不是从过滤后的 AstrBot 事件流确认。这样即使群白名单不包含 canary 群，canary 仍能证明入站面健康。
  - 默认关闭（会发消息，增加账号行为风险）；开启后建议 15 分钟一次，测试群专用。
- **ONLINE 条件**：动作面探针健康，且（canary 在最近 3 个周期内成功，或 `inboundCursor` 在最近 10 分钟内前进过）。
- **IDLE**：动作面健康；连续 ≥10 分钟无入站，且没有“活跃会话下停滞”的证据。IDLE 视为可用：heartbeat `good:true`、`/readyz` 200；用 `polaris_health_state{state="IDLE"}` 单独观测。深夜零消息不应变成 DEGRADED/OFFLINE。
- **DEGRADED**：动作面健康，但**活跃会话**下事件 60s 停滞（不是单纯零消息）；或连续 3 次动作探针失败。
- **OFFLINE**：连续 5 次/90s 动作探针失败；或活跃会话下入站 120s 停滞；或 canary 连续 3 次失败。
- **静默时段规则**：长时间零入站进入 IDLE，而不是 DEGRADED/OFFLINE；“入站停滞”只在最近 10 分钟曾有入站、随后 60s/120s 不前进时才算异常。

探针进程/定时器与 Core 事件循环隔离；Core 卡死时 watchdog 仍能重启。

## /healthz 与 /readyz

| 端点 | 语义 | 200 条件 | 503 条件 |
| --- | --- | --- | --- |
| `/healthz` | **liveness：进程是否活着** | 进程运行中（包括 DEGRADED / auth_failed） | 进程已停止/无法响应 |
| `/readyz` | **readiness：是否可用** | `connState=open` 且 `loginState=LOGGED_IN` 且 `healthState ∈ {ONLINE, IDLE}` | DEGRADED / OFFLINE / AUTH_FAILED / HANDSHAKE_FAILED / UNKNOWN |

- **DEGRADED 时 `/healthz` 返回 200 是有意的**：进程没死，liveness 不该重启它；但它已经不可用，`/readyz` 必须 503。
- 响应体包含 `state`（conn/login/health 三轴）、`reason`、`lastProbeAt`；auth_failed 与 offline 通过 `connState`/`healthState` 区分。
- 指标：
  - `polaris_health_state{state="ONLINE|IDLE|DEGRADED|OFFLINE|UNKNOWN"}` gauge；
  - `polaris_ready` 0/1；
  - 告警规则：`polaris_health_state{state="DEGRADED"} == 1` 持续 60s → warning；`OFFLINE`/`AUTH_FAILED` → critical。
- 运维建议：**用 `/readyz` 判可用性/负载均衡；`/healthz` 只判进程存活；DEGRADED 用指标告警，不要依赖 healthz 状态码。**
- 实现随 M1.4 的 HTTP 服务落地；此前 CLI 只输出状态日志。

## auth_failed 与 resume

- 进程**不退出**；保持存活，进入 `auth_failed`，等待人工修正。
- 日志包含：`statusCode`、脱敏 URL（移除 `access_token`）、`tokenConfigured`、修复提示。
- `setAccessToken()` 只更新内存 token；必须调用 `resume()` 才生效。
- **`resume()` 合法态只有 `{auth_failed, handshake_failed}`**；其他状态（包括 `open`）抛出 `InvalidStateError`，且不关闭现有连接。WebUI 的 “Retry now” 必须按此约束禁用/报错。
- 真实 401 时序：握手被拒时 socket 已随 request 关闭，`resume()` 不应空等 1s；关闭旧 socket 的超时逻辑只用于仍存活的 socket。测试按真实 401 时序断言 resume 快速返回且只发起一次新连接。
- 仍失败则回到 `auth_failed`，不进入退避循环。
- CLI 提示：检查 AstrBot OneBot v11 Token、反向 WS 路径 `/ws`、端口 6199、`X-Self-ID`；修改环境变量后重启。未来 WebUI 提供 “Retry now” 按钮（仅合法态可用）与配置入口。

## 未知字段

- `aiocqhttp.Event` 是 **`dict` 子类**，`Event.from_payload(payload)` 直接包装原始 dict；未知字段被保留，不会被 pydantic `extra=forbid` 拒绝。证据：[event.py](https://github.com/nonebot/aiocqhttp/blob/2520928d2373f5be71059600b832e230a39ccdb9/aiocqhttp/event.py)，提交 `2520928`，2023-06-11。
- AstrBot 的 aiocqhttp 适配器直接消费该 `Event`，按 key 取字段；没有对整条事件做 pydantic strict 解析。
- 但为了不把兼容性建立在“消费者忽略未知字段”上，**Lodestar 默认不发送非标准字段**：heartbeat 不带 `polaris_state`，默认事件不带 `polaris_event_key`。状态只走 `/healthz`、`/metrics` 与结构化日志；`polaris_event_key` 仅在消费者明确支持时作为 opt-in 扩展。

## 后果

- `ReverseWsClient` 暴露 `loginProvider`、`healthProvider`、`heartbeatStatus`；`heartbeat` 与 `get_status` 从同一组轴派生。
- 测试覆盖：login/health 组合、ONLINE/IDLE/DEGRADED/OFFLINE heartbeat、401 不重试、resume 合法态/非法态、真实 401 快速 resume、无双连接。
- **空闲 6 小时测试**：在模拟时钟下连续 6 小时零入站、动作探针健康，状态必须为 IDLE，不产生 DEGRADED/OFFLINE，`/readyz` 返回 200，容器不被标 unhealthy。
- `/healthz`、`/readyz` 在 M1.4 实现前只作为契约。

## 重新审议触发条件

1. 需要区分更多 `healthState`（如 `RATE_LIMITED`）并影响 heartbeat。
2. AstrBot 对 `status.online/good` 有新的消费语义。
3. 多账号需要按账号暴露独立 healthz。
4. canary 账号方案不可用，需要替代的入站探针。
