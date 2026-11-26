# ADR 0005：Adapter 事件契约与投递语义

- 状态：Accepted（修订）
- 日期：2026-11-11
- 决策者：项目所有者、维护者

## 事件来源归属（P0）

| 事件 | 产生方 | 说明 |
| --- | --- | --- |
| `meta_event/lifecycle` | **Core only** | Core 在 WS open/close 时生成；adapter 不得上报 |
| `meta_event/heartbeat` | **Core only** | 内容由 probe 健康状态派生；adapter 不得上报 |
| 其它 `meta_event` | **Core only** | 目前没有其它 meta；未来仍由 Core 统一管理 |
| `message` | Adapter | 私聊/群聊消息归一化后上报 |
| `notice` | Adapter | 群文件、管理员、撤回、戳一戳等 |
| `request` | Adapter | 好友/加群请求 |

`EventSink.publish()` 对 adapter 送来的 `post_type=meta_event`（含 lifecycle/heartbeat）**拒绝**：

```ts
{ accepted: false, reason: 'forbidden_event_source' }
```

同时记 `adapter_forbidden_event_total{type}` 并告警。理由：避免 AstrBot 侧双重在线、heartbeat 冲突与状态抖动。

## 身份、幂等键与顺序（Core 分配）

采用**方案①：sessionId 与顺序都由 Core 分配，adapter 只带事件本身，不带身份**。

### 为什么不是方案②

方案②（adapter 自报 sessionId/seq，Core 校验并拒绝 `event_key_trust_violation`）仍然把身份交给 adapter，且需要额外的信任协议；方案①更简单：Core 在 `publish()` 内分配持久化 `deliverSeq`，adapter 无法影响排序或去重键。方案②不采用。

### deliverSeq

- Core 维护 `account_delivery_seq(account_id PRIMARY KEY, next_deliver_seq)`；每次 `publish()` 在 `BEGIN IMMEDIATE` 内取号并 +1。
- `deliverSeq` 跨 adapter 重启、跨 session **不重置**，是 outbox 的唯一排序键。
- adapter 不提供 sessionId/seq；`publish()` 返回分配的 `deliverSeq` 供日志/诊断。
- adapter 必须 `await publish()` 后再发下一条，保证 Core 的取号顺序与 adapter 读取顺序一致。

### eventKey

- 有 `sourceEventId`（原生消息/事件 ID）：`sha256(accountId + ":source:" + sourceEventId)`。
- 无 `sourceEventId`：`sha256(accountId + ":delivery:" + deliverSeq)`；**不去重内容相同的真人消息**。
- **禁止对 payload 做内容哈希**。同账号同会话两条“好的”/“1”/重复表情包，deliverSeq 不同，eventKey 不同，必须都投递。
- 去重表 `event_dedup`；TTL：message 7 天、notice/request 3 天、meta 1 天。

### adapter 重启重报的量化风险与缓解

- 有 `sourceEventId` 的消息：eventKey 跨重启稳定，重报会被去重；风险≈0（前提是 adapter 提供稳定原生 ID）。
- 无 `sourceEventId` 的事件：eventKey 基于新 `deliverSeq`，**不会跨重启去重**；如果 adapter 重启后重放自己的缓冲，重复量 = adapter 重放缓冲条数 N。
- 缓解（M1.2 契约）：
  1. 消息事件必须提供 `sourceEventId`/`nativeMessageId`；无 ID 的消息按“不可跨重启去重”记录 `event_no_source_id_total`。
  2. adapter `start(sink)` 时提交 `replayManifest`：最近一次已成功 publish 的 `sourceEventId` 列表（建议最近 1000 条）；Core 将其写入 dedup，再开始接收新事件。
  3. 若 adapter 不提供 manifest，72h 测试中允许的重复上界 = N / 总事件数；必须在报告中写明 N 与来源。
- 断言：adapter 重启后重报同一 `sourceEventId`，Core 返回 `duplicate`，AstrBot 只收到一次；无 sourceEventId 的重报允许重复并计入 `event_no_source_id_total`。

### 重排窗口

- `deliverSeq` 由 Core 在 `publish()` 时分配；adapter 必须按顺序 await publish，因此正常情况下无需重排。
- 若 adapter 并发调用导致乱序，Core 允许最多 **200ms** 的重排窗口，配置硬上限 **500ms**；重排缓冲最多 **256** 条。
- 超时/溢出立即放行后续事件并记 `event_seq_gap`；**禁止任何无界缓冲**。
- 跨 adapter 重启时，旧 session 的 `deliverSeq` 仍小于新 session 的 `deliverSeq`，重放按 `deliverSeq` 排序，不会出现“旧 session 50 排到新 session 1 之后”。
- MOCK-01 断言：同账号同会话 5s 内两条完全相同文本，eventKey 不同，且两条都到达 AstrBot。

## message_id（有符号 int32）

- 原生 ID 在 `[-2147483648, 2147483647]` 内直接使用，保留符号，禁止 `>>> 0`。
- 超范围/缺失时分配合成负数：
  - `candidate = -1 - (counter % 2147483647)`；
  - 计数器持久化；冲突探测下一个；
  - 分配与插入在同一 `BEGIN IMMEDIATE` 事务内。
- DB 硬约束：
  - `PRIMARY KEY (account_id, message_id)`；
  - `CREATE UNIQUE INDEX ... ON message_ref(account_id, native_message_id) WHERE native_message_id IS NOT NULL`；
  - 冲突插入必须抛错，由分配器重试。
- 重启后 `message_ref` 与 counter 保留；同一 `eventKey` 不得分配第二个 ID。
- `get_msg` 未命中返回 `1507 MESSAGE_NOT_FOUND`。
- 测试断言：`PRAGMA index_list('message_ref')` 含 unique 索引；重复插入抛错；重启后负数 ID 可查回（MOCK-06 + storage runtime test）。

## 投递确认边界与 at-least-once

OneBot v11 事件没有应用层 ACK。Lodestar 能观测到的边界是：

- `ws.send` 回调成功 = 本地/内核接受，**不等于 AstrBot 已消费**。
- 因此语义是 **at-least-once**，不是 exactly-once。

outbox 状态：

| 状态 | 含义 | 重连时 |
| --- | --- | --- |
| pending | 已落盘、未发送 | 重放 |
| sending | 已发起 send、未收到回调 | 重放（可能重复） |
| sent | send 回调成功 | 不重放 |
| failed | 重试耗尽 | 保留并告警，不静默丢弃 |

- 崩溃窗口内 `sending` 事件会重放，可能产生重复；这是明示取舍。
- **默认不发送非标准字段**：不附加 `polaris_event_key`。若消费者明确支持扩展字段，可作为 opt-in；不把“消费者忽略未知字段”作为默认依赖。

### 可度量的重复/重放指标

“重复投递率 ≤0.1%”在当前设计下几乎恒为 0（发送前去重、`sent` 不重放），不能作为退化检测。改为：

| 指标 | 定义 | 实现模块 |
| --- | --- | --- |
| `outbox_replay_total` | 重连后重放的事件条数 | Core outbox |
| `outbox_replay_ratio` | replayed / total events（1h/72h） | Core outbox |
| `outbox_sending_stale_seconds` | `sending` 状态行的最大滞留时长 | Core outbox |
| `crash_replay_total` | 进程重启后从 `sending` 重放的条数 | Core outbox |
| `outbox_replay_duplicate_total` | 重放后本地标记为可能重复的条数（保守计数） | Core outbox |
| `duplicate_message_rate_e2e` | 同一 `message_id` 在 AstrBot 侧出现多次的比例 | 联调测试/日志分析（不在 Core） |

- 目标：`outbox_sending_stale_seconds` 有硬上限（默认 60s）；`crash_replay_total` 可解释；`duplicate_message_rate_e2e` 在 72h 联调中 ≤0.1%。
- 该口径明确区分“Core 能观测的重放”与“AstrBot 实际消费的重复”；后者不在 Core 内伪造。

## 数据保留与回收

没有 TTL 的表会无限增长，必须设上限：

| 表 | 保留策略 | 清理节奏 | 上限/账号 |
| --- | --- | --- | --- |
| `event_dedup` | message 7d / notice,request 3d / meta 1d | 每 5 分钟 | 1,000,000 行 |
| `event_outbox` | `sent` 24h；`failed` 7d；`pending` 永不自动删 | 每小时 | 10,000 行；超限先删最旧 `sent`，绝不删 `pending` |
| `message_ref` | 30d | 每天 | 100,000 行；若被 pending outbox 引用则保留 |

- `PRAGMA auto_vacuum=INCREMENTAL`；每天 `PRAGMA incremental_vacuum`，避免频繁全量 `VACUUM`。
- 数据目录预算 1GB；70%/90% 告警。清理失败只告警，不阻塞收发。
- 清理策略在 `Storage` 模块实现；`event_outbox`/`message_ref` 的清理必须有“不删 pending/被引用行”的测试。

## 背压

- 先落盘 outbox，再发送。
- 有界队列；message/notice/request 绝不静默丢弃；只有 low 优先级 meta/heartbeat 允许丢弃或合并。
- `publish` 返回 `delivered` / `queued` / `duplicate` / `backpressure` / `not_connected` / `shutting_down` / `forbidden_event_source`。
- adapter 必须 `await publish()`；收到 backpressure 时暂停读取上游，禁止无界堆内存。
- **pending 全量超限**：达到 10,000 且没有可删的 `sent` 时，`publish()` 返回 `{accepted:false, reason:'backpressure', retcode:1503}`；adapter 必须停止读取上游；**绝不静默丢弃、绝不删除 pending**。
- （2026-11-27：STOP 哨兵与 1508 停止语义已由 [ADR 0009](0009-remove-send-guard.md) 移除；MOCK-09 只保留背压/队列断言。）
- MOCK-09 断言：队列不超上限、normal 不丢、纯 pending 超限返回 1503、RSS 不随注入线性增长。

## 后果

- adapter-mock 必须使用同一 `AdapterEvent`/`PublishResult` 契约，不允许旁路。
- Core 不生成 message/notice/request；adapter 不生成 meta。
- 新增事件类型必须先更新本 ADR 的归属表。

## 附录：契约 DDL（A 组落地）

以下是 A 组要落成的原始 SQL，当前尚未实现；实现时必须以本文为准，并用测试断言主键/唯一索引/清理行为。

```sql
CREATE TABLE account_delivery_seq (
  account_id INTEGER PRIMARY KEY,
  next_deliver_seq INTEGER NOT NULL
);

CREATE TABLE event_dedup (
  event_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX event_dedup_expiry ON event_dedup(expires_at);

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

## 附录：A 组断言清单（不含实现）

| # | 断言 | 说明 |
| --- | --- | --- |
| A1 | 去重命中且不杀内容相同的真人消息 | 同账号同会话 5s 内两条“好的”都到达 AstrBot；eventKey 不同；仅同 deliverSeq/同 sourceEventId 命中 duplicate |
| A2 | DB 主键与两条唯一索引存在 | `message_ref` 主键 `(account_id, message_id)`；unique `(account_id, native_message_id)`；`event_outbox` unique `(account_id, deliver_seq)`；另有 `event_dedup_expiry`、`message_ref_expiry` 索引 |
| A3 | publish() 入口拒收 adapter 的 meta | lifecycle/heartbeat 返回 `forbidden_event_source`，metric `adapter_forbidden_event_total` 增加，AstrBot 只看到 Core 的 meta |
| A4 | pending 超限返回 1503 | 10,000 条纯 pending、无可删 sent 时，publish 返回 `backpressure` + 1503；adapter 暂停读取；不删 pending、不静默丢消息 |
| A5 | 清理不删 pending/被引用行 | 清理 `sent`/过期 dedup/message_ref 时，pending outbox 与仍被 pending 引用的 message_ref 保留；测试断言行数 |
| A6 | 跨 session 重放不乱序 | 旧 adapter session 的 deliverSeq=50 与新 session 的 deliverSeq=51 按 deliverSeq 重放；不会出现旧 50 排到新 1 之后（无 session seq 排序） |
