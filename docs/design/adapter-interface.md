# AdapterInterface 与上行事件契约（设计稿）

- 状态：Draft，等待确认
- 日期：2026-11-11
- 范围：`@lodestar/core` 与 `@lodestar/adapter-mock`、外部 OneBot 适配器、原生 NTQQ 适配器之间的边界
- 目标：先锁定事件上报契约，再写 adapter-mock 实现

## 1. 边界与职责

```text
QQ / 外部 OneBot 后端
        │  (adapter 负责)
        ▼
Adapter（mock / external-onebot / ntqq-inject）
        │  AdapterEvent + EventSink.publish()
        ▼
Core EventPipeline
  ├─ 幂等去重（eventKey）
  ├─ 顺序与重排窗口（seq）
  ├─ message_id 归一化（有符号 int32）
  ├─ 持久化 outbox
  └─ 背压/限流
        │  OneBot v11 event JSON
        ▼
AstrBot（反向 WebSocket 客户端）
```

- **Adapter 负责**：连接/注入真实客户端、把原始事件规范化为 OneBot v11 事件、执行 Core 下发的动作；adapter 不提供 sessionId/seq。
- **Core 负责**：OneBot v11 语义、事件去重、顺序、`message_id` 生成与映射、outbox、重试/背压、指标、AstrBot 连接。
- **Adapter 不负责**：AstrBot 连接、事件去重、message_id 分配、限流策略、WebUI。

### 事件来源归属（P0）

| 事件 | 产生方 | 规则 |
| --- | --- | --- |
| `meta_event/lifecycle` | **Core only** | adapter 不得上报 |
| `meta_event/heartbeat` | **Core only** | 内容由 probe 健康状态派生；adapter 不得上报 |
| 其它 `meta_event` | **Core only** | 当前没有；未来仍由 Core 统一管理 |
| `message` | Adapter | 私聊/群聊消息 |
| `notice` | Adapter | 群文件、管理员、撤回、戳一戳等 |
| `request` | Adapter | 好友/加群请求 |

`EventSink.publish()` 对 `post_type=meta_event` 的 adapter 事件返回
`{ accepted: false, reason: 'forbidden_event_source' }`，并记
`adapter_forbidden_event_total{type}` + 告警。这样 AstrBot 不会看到双份
lifecycle/heartbeat，也不会出现“adapter 说在线、Core 说离线”的状态抖动。

## 2. 类型与签名（设计稿）

```ts
export interface AdapterEvent {
  /** QQ 账号。 */
  accountId: number;

  /** adapter 收到事件的时间（epoch ms），用于延迟指标。 */
  occurredAt: number;

  /** 上游原生事件/消息 ID（若能拿到）；用于跨 adapter 重启的幂等键。 */
  sourceEventId?: string;

  /** 上游原生消息 ID；可能是数字、字符串、负数或超出 int32。 */
  nativeMessageId?: string | number;

  /** OneBot v11 事件；message 事件的 message_id 可以缺省，由 Core 归一化后注入。 */
  payload: OneBotEvent;

  /** 背压优先级；默认 normal。 */
  priority?: 'critical' | 'normal' | 'low';
}

export type PublishResult =
  | {
      accepted: true;
      eventKey: string;
      /** Core 分配的持久化单调投递序号，跨 adapter 重启不重置。 */
      deliverSeq: number;
      mode: 'delivered' | 'queued';
    }
  | {
      accepted: false;
      reason:
        | 'duplicate'
        | 'backpressure'
        | 'not_connected'
        | 'shutting_down'
        | 'forbidden_event_source';
      eventKey?: string;
      /** 背压时固定 1503；STOP 由发送路径返回 1508。 */
      retcode?: 1503;
      retryAfterMs?: number;
    };

export interface AdapterSession {
  /** Core 分配，adapter 只用于日志，不得用于 eventKey/排序。 */
  sessionId: string;
  accountId: number;
}

export interface EventSink {
  /**
   * Adapter 上报一个事件。Core 在内部分配 deliverSeq；adapter 不提供
   * sessionId/seq。Adapter 必须 await 它再读取下一条，以传导背压。
   */
  publish(event: AdapterEvent): Promise<PublishResult>;
}

export interface AdapterActionResult {
  ok: boolean;
  data?: unknown;
  /** 上游 OneBot retcode；没有则不打。 */
  retcode?: number;
  message?: string;
  /** 只对只读动作有意义；发送类动作不得自动重试。 */
  retryable?: boolean;
  latencyMs?: number;
}

export interface AdapterHealth {
  process: 'starting' | 'ready' | 'stopped';
  /** Adapter-confirmed login state; Core never infers this from the socket. */
  loginState: 'UNKNOWN' | 'LOGGED_IN' | 'LOGGED_OUT';
  /** 数据面健康是 hint，Core 的独立探针才是最终判定。 */
  dataPlane: 'unknown' | 'healthy' | 'silent' | 'dead';
  /** 客户端收到的原始入站计数/序列，先于过滤；用于入站面探针。 */
  inboundCursor?: number;
  lastInboundAt?: number;
  /** 过滤前看到的 canary nonce（若有）；用于白名单不影响入站面证明。 */
  inboundNonceSeen?: string;
  eventSeq?: number;
  lastEventAt?: number;
  qqBuild?: string;
  detail?: string;
}

export interface AdapterCapabilities {
  protocol: 'onebot11';
  actions: string[];
  events: string[];
  media: {
    image: boolean;
    voice: boolean;
    video: boolean;
    file: boolean;
    forward: boolean;
  };
  multiAccount: boolean;
  version: {
    adapter: string;
    qqBuild?: string;
    hook?: string;
  };
}

export interface AdapterInterface {
  readonly accountId: number;

  start(
    sink: EventSink,
    session: AdapterSession,
    replayManifest?: string[],
  ): Promise<void>;
  stop(): Promise<void>;

  execute(
    action: string,
    params: Record<string, unknown>,
    context: ActionContext,
  ): Promise<AdapterActionResult>;

  health(): Promise<AdapterHealth>;
  capabilities(): AdapterCapabilities;
}
```

## 3. 身份、幂等键与顺序（Core 分配）

### 3.1 eventKey

由 **Core** 计算，不信任 adapter 自报的 key；**不对 payload 做内容哈希**：

1. 有 `sourceEventId`（原生消息/事件 ID）：`eventKey = sha256(accountId + ":source:" + sourceEventId)`。
2. 无 `sourceEventId`：`eventKey = sha256(accountId + ":delivery:" + deliverSeq)`。
3. 消息事件若 `nativeMessageId` 存在，优先使用它作为 `sourceEventId`。

`deliverSeq` 由 Core 在 `publish()` 内分配，跨 adapter 重启不重置。无 `sourceEventId` 时不去重内容相同的真人消息；同账号同会话两条“好的”/“1”/重复表情包，deliverSeq 不同，eventKey 不同，必须都投递。

去重表：

```sql
CREATE TABLE event_dedup (
  event_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX event_dedup_expiry ON event_dedup(expires_at);
```

- 默认 TTL：message 7 天；notice/request 3 天；meta 1 天。
- `publish` 命中重复 → `{ accepted: false, reason: 'duplicate' }`，不转发给 AstrBot。
- 去重发生在 outbox 之前，避免重复落盘。

### 3.2 deliverSeq

- Core 维护 `account_delivery_seq(account_id, next_deliver_seq)`；每次 `publish()` 在 `BEGIN IMMEDIATE` 内取号并 +1。
- `deliverSeq` 跨 adapter 重启、跨 session **不重置**，是 outbox 的唯一排序键。
- adapter 不提供 sessionId/seq；Core 在 `start(sink, session)` 下发 `sessionId` 仅用于日志。
- adapter 必须 `await publish()` 再读取下一条；若并发调用导致乱序，Core 允许最多 200ms 重排窗口，硬上限 500ms、缓冲最多 256 条；超时/溢出记 `event_seq_gap`，**禁止无界缓冲**。
- 旧 session 的 deliverSeq 永远小于新 session；重放按 `(account_id, deliver_seq)` 排序，不会出现“旧 50 排到新 1 之后”。

### 3.3 adapter 重启重报风险

- 有 `sourceEventId`：eventKey 稳定，重报命中 duplicate；风险≈0。
- 无 `sourceEventId`：eventKey 基于新 deliverSeq，不会跨重启去重；重复量 = adapter 重放缓冲条数 N。
- 缓解：消息事件必须提供 `sourceEventId`；`start()` 时提交 `replayManifest`（最近 1000 条 sourceEventId）供 Core 预热 dedup；无 manifest 时在报告中写明 N 与重复上界。

## 4. message_id 生成策略

OneBot v11 的 `message_id` 是**有符号 32 位整数**，负值合法。要求：稳定、按账号唯一、可通过 `get_msg` 查回。

### 4.1 原生 ID 优先

- 若 `nativeMessageId` 可解析为整数且落在 `[-2147483648, 2147483647]`，直接使用（保留符号，绝不做 `>>> 0`）。
- 注册映射：

```sql
CREATE TABLE message_ref (
  account_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  native_message_id TEXT,
  conversation_type TEXT NOT NULL,
  conversation_id INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (account_id, message_id)
);
CREATE UNIQUE INDEX idx_message_ref_native
  ON message_ref(account_id, native_message_id)
  WHERE native_message_id IS NOT NULL;
CREATE INDEX message_ref_expiry ON message_ref(expires_at);
```

### 4.2 合成 ID（原生缺失或超出 int32）

- 使用**负数区间**，避免与常见正数原生 ID 冲突：
  - 持久化计数器 `synthetic_counter`；
  - `candidate = -1 - (counter % 2147483647)`；
  - 若 `(account_id, candidate)` 已存在且指向不同消息，递增重试；
  - 计数器写入 SQLite 后再返回 ID，保证崩溃后不复用。
- 分配与插入在同一 `BEGIN IMMEDIATE` 事务内；DB 硬约束：
  - `PRIMARY KEY (account_id, message_id)`；
  - `CREATE UNIQUE INDEX ... ON message_ref(account_id, native_message_id) WHERE native_message_id IS NOT NULL`；
  - 冲突插入必须抛错，由分配器重试。
- 重启后 `message_ref` 与 counter 保留；同一 `eventKey` 不得分配第二个 ID。
- 合成 ID 也写入 `message_ref`，`get_msg` 通过 `(account_id, message_id)` 查回。
- 冲突/回绕记 `message_id_collision_total` 指标。
- 多账号：`message_ref` 以 `account_id` 为主键一部分；AstrBot 动作请求按当前连接/`self_id` 路由到对应账号。M1 先单账号。

### 4.3 get_msg 未命中

返回 `1507 MESSAGE_NOT_FOUND`（Lodestar 自定），不要返回成功空对象。

## 5. 事件发送失败与背压

### 5.1 publish 的语义

| 场景 | message/notice/request（critical/normal） | meta/heartbeat（low） |
| --- | --- | --- |
| AstrBot WS 已连接 | 直接发送 → `delivered` | 发送或合并 → `delivered` |
| AstrBot WS 断开 | 写入 outbox → `queued` | 丢弃/合并 → `not_connected` |
| outbox 未满 | 入队 → `queued` | 丢弃 → `not_connected` |
| outbox 满 | `backpressure` + `retcode:1503` + `retryAfterMs` | 丢弃 → `backpressure` |
| 正在 shutdown | `shutting_down` | `shutting_down` |

- Adapter 必须 `await publish()`；收到 `backpressure` 时暂停读取 QQ/上游，而不是继续堆内存。
- **pending 全量超限**：达到 10,000 且无可删 `sent` 时，`publish` 返回 `backpressure` + `retcode:1503`；adapter 停止读取；**绝不静默丢弃、绝不删除 pending**。
- **STOP 哨兵**：Core watchdog 每 5s 轮询 `data/STOP`；发送路径在调用 adapter 前检查内存 flag，≤5s 生效，返回 `1508 SEND_DISABLED`。
- **绝不静默丢弃 message/notice/request**；丢弃只允许发生在 low 优先级 meta 事件。
- 重复事件返回 `duplicate`，adapter 不应重试。

### 5.2 outbox

```sql
CREATE TABLE account_delivery_seq (
  account_id INTEGER PRIMARY KEY,
  next_deliver_seq INTEGER NOT NULL
);

CREATE TABLE event_outbox (
  event_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  deliver_seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed')),
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account_id, deliver_seq)
);
CREATE INDEX event_outbox_order ON event_outbox(account_id, deliver_seq);
CREATE INDEX event_outbox_cleanup ON event_outbox(status, sent_at);
```

- 入队先落盘，再尝试发送；发送成功的判定是 `ws.send` 回调无错误，**不是** AstrBot 已处理。
- 重连后按 `(account_id, deliver_seq)` 顺序重放；默认**不附加** `polaris_event_key` 等非标准字段。消费者明确支持时再 opt-in。
- 语义是 **at-least-once**；不承诺 exactly-once。
- **投递确认边界**：`ws.send` 回调成功只表示本地/内核接受，不表示 AstrBot 已消费；OneBot v11 事件没有应用层 ACK。
- outbox 状态：`pending` / `sending` / `sent` / `failed`。崩溃窗口内的 `sending` 事件会重放，可能重复；这是明示取舍。只有 `sent` 不重放。
- 可度量指标（替代几乎恒为 0 的“重复率”）：
  - `outbox_replay_total` / `outbox_replay_ratio`；
  - `outbox_sending_stale_seconds`（硬上限 60s）；
  - `crash_replay_total`；
  - `outbox_replay_duplicate_total`；
  - 端到端 `duplicate_message_rate_e2e` 在 AstrBot 侧按 `message_id` 统计（联调测试，不在 Core 伪造）。
- 发送失败：指数退避，最大 3 次；仍失败则保留在 outbox 并告警，不阻塞后续 meta 事件。
- 指标：`event_outbox_depth`、`outbox_replay_total`、`outbox_sending_stale_seconds`、`event_drop_total{priority}`、`event_send_failure_total`。

### 5.3 status=failed 不会触发重连

- Lodestar 返回给 AstrBot 的 `status: failed` 只是动作级结果。
- Core 收到上游 adapter 的 `ok: false` 也只返回动作失败；**不改变连接状态、不触发重连、不计入断线指标**。
- 只有传输层 close/error、心跳 pong 超时、鉴权/握手确定性失败才进入连接状态机。

## 6. 动作路径

1. AstrBot → Core：`{action, params, echo}`。
2. Core 校验 action 是否在 `capabilities().actions` 中；不在 → `1404 ACTION_NOT_FOUND`。
3. Core → Adapter：`execute(action, params, ctx)`。
4. Adapter → Core：`AdapterActionResult`。
5. Core → AstrBot：`status: ok|failed`，retcode 按第 7 节映射。

重试规则：

- **只读动作**（`get_*`、`can_*`）可重试，最多 3 次，指数退避。
- **发送类动作**（`send_*`、`upload_*`、`set_*`、`delete_*`）不自动重试；返回失败与 `retryable` 提示，由上层决定。
- 动作超时 → `1501`；adapter 应尽力取消底层请求。

## 7. 错误码映射

- Adapter 返回 `retcode` 时，Core **原样透传**，不做语义改写（尤其 NapCat 的 1200/1400/1401/1404）。
- Adapter 没有 retcode 时：
  - `ok: true` → `0`；
  - `ok: false` → `1500`，除非是已知的 Core 层错误（超时 1501、不可用 1502、背压 1503、限流 1504、版本 1505、鉴权 1506、消息不存在 1507）。
- 未知 action → `1404 ACTION_NOT_FOUND`。

## 8. 健康与探针

三条轴分离（详见 ADR 0004）：

- `loginState`：adapter 确认的登录态，只决定 heartbeat `status.online`。
- `connState`：Core 的 WebSocket 状态（含 `auth_failed` / `handshake_failed`）。
- `healthState`：独立 probe 的 `UNKNOWN/ONLINE/IDLE/DEGRADED/OFFLINE`，只决定 `status.good`（ONLINE/IDLE 为 true）。
- `loginState` 来源：外部 OneBot 后端由 Core 连接后调 `get_login_info`（非零 user_id → LOGGED_IN）；原生注入后端由 adapter 显式上报；冷启动到首个 `online:true` heartbeat ≤5s。

探针目标：

- **动作面**：`get_login_info` 每 15s 一次，5s 超时；nonce 只放 `echo`，不进 params；只证明动作可用，不能单独判 ONLINE。
- **入站面**：adapter 暴露 `inboundCursor` / `lastInboundAt` / `inboundNonceSeen` / `eventSeq` / `lastEventAt`；活跃会话下 cursor 60s 不前进，且动作探针超过 60s 未成功 → DEGRADED，120s → OFFLINE。动作探针持续成功时，入站静默不单独触发降级。
- **主动 canary**（推荐 72h 测试）：独立 canary 账号向测试群发 nonce；probe 从**过滤前**的 `inboundCursor`/`inboundNonceSeen` 确认，而不是从 AstrBot 事件流确认。即使群白名单不包含 canary 群，仍能证明入站面健康。默认关闭，开启时 15 分钟一次。
- **IDLE**：动作面健康、连续 ≥10 分钟无入站 → IDLE；`good:true`、`/readyz` 200、单指标 `polaris_health_state{state="IDLE"}`。深夜零消息不得变成 DEGRADED/OFFLINE。
- ONLINE 表示动作面持续健康；DEGRADED/OFFLINE 需要动作面失败，或动作探针失效后仍出现入站停滞证据。
- `AdapterHealth.dataPlane` 只是佐证；Core 不单独信任。
- 探针超时/失败不直接等于“重启”，先进入 SUSPECT/DEGRADED，按恢复阶梯处理。

## 9. adapter-mock 的约束

- 实现 `AdapterInterface`，但不需要真实 QQ。
- 提供一个控制面（HTTP 或 stdio JSON 命令）用于脚本化：
  - `emit`：注入一条 `AdapterEvent`；
  - `disconnect`：模拟 AstrBot WS 断开（由 Core 侧处理）；
  - `freeze`：进程活着、`health()` 仍 ready，但停止发事件与响应探针；
  - `crash`：进程退出；
  - `auth_fail`：模拟上游鉴权失败；
  - `slow_action`：模拟动作超时；
  - `backpressure`：快速灌事件。
- mock 必须使用与真实 adapter 相同的 `AdapterEvent`/`PublishResult` 契约，不能走旁路。

## 10. 已定决策与待确认项

已定（见 ADR 0003–0006）：

- retcode：1404 用于动作不存在；仅使用有出处的码。
- 连接/鉴权/heartbeat：auth_failed 不自动重试；heartbeat 由 probe 状态派生。
- 事件契约：lifecycle/heartbeat 仅 Core；at-least-once；重排窗口 ≤500ms。
- 存储：默认 `node:sqlite`，封装在 `SqliteDriver` 后；`better-sqlite3` 为备选。

仍需确认：

1. `seq` 用 JS `number`（安全整数）是否可接受；是否要直接设计成 `bigint`/字符串。
2. `eventKey` TTL：message 7 天、notice/request 3 天、meta 1 天是否合适。
3. outbox 默认容量（建议 10,000 条/账号）与 low 优先级丢弃策略。
4. AstrBot 是否容忍事件里的 `polaris_event_key` 扩展字段（联调确认）。
5. 多账号路由是否统一用 `self_id` + 每账号独立 AstrBot 端口；M1 先单账号。
