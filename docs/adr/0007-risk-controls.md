# ADR 0007：风险缓释开关（频控 / 白名单 / @ 触发 / STOP）

- 状态：Superseded（2026-11-27 由 [ADR 0009](0009-remove-send-guard.md) 取代；SendGuard 已从代码中移除）
- 日期：2026-11-11
- 决策者：项目所有者、维护者

## 背景

Lodestar 不做官方 Bot API 退路，账号风险只能靠“行为正常化 + 最小频控 + 可一键停用”兜底。这些不是 M3 的锦上添花，必须在 **M1.2** 交付，否则不做主力号冒烟。

## 拦截点

所有出站发送动作在 **Core 的 SendGuard** 拦截，位置在：

```text
AstrBot action
  → OneBot 参数校验（100/1404）
  → SendGuard（STOP / 白名单 / @ 触发 / 配额 / 限频 / 随机延迟）
  → outbox / adapter.execute()
  → adapter / QQ
```

- SendGuard 是**唯一**发送入口；adapter 不得绕过 Core 直接发送。
- 只对发送类动作生效：`send_private_msg`、`send_group_msg`、`send_msg`、`upload_*`、`set_*`、`delete_*` 等；只读动作不受配额限制。
- 拦截发生在 outbox 之前，避免被拦截的消息落盘再重放。

## STOP 哨兵

- 文件：`data/STOP`。
- 轮询者：Core 进程内 5s timer；每次发送检查前还会**同步** `existsSync(STOP)`。
- 生效：下一次发送动作立即返回 `1508 SEND_DISABLED`，不依赖 timer 是否已跑；
  timer 只维护状态/指标。若主事件循环被阻塞，发送本身也无法执行，由独立
  watchdog 负责进程级 SIGKILL，不是 STOP 的替代。
- 已入 outbox 的消息暂停发送，不删除；恢复时人工删除 STOP 并重启/恢复。
- `stop-core.ps1` 写 STOP 并停止进程；未来 WebUI 提供“一键停用”按钮。
- 指标：`polaris_send_disabled` 0/1。

## 群白名单

- 默认 **空** = 拒绝所有群发送，直到用户显式配置白名单；这是保守默认。
- 白名单外消息在 SendGuard 丢弃，不进入 adapter；返回 `1504 RATE_LIMITED`（或按配置返回 `1503`），并记：
  - `polaris_send_guard_denied_total{reason="whitelist"}`（账号/群号在审计行里）
  - 结构化日志字段：`account_id`、`group_id`、`action`、`reason`；**不记录消息正文**。
- 私聊默认开启；私聊白名单为空表示允许所有私聊，填写白名单后仅允许列表中的 QQ。

## @ 触发

- 默认 `at_only=false`。开启后，群发送要求出站消息包含对机器人自身的 `at` 段；
  当前实现按出站消息判断，AstrBot 的普通群回复通常不含该段，因此会拦下群回复。
  需要“只有被 @ 才回复”时，应在 AstrBot 侧配置唤醒前缀/@ 触发，或在 Core 侧补齐入站判断。
- 被忽略的消息记 `polaris_send_guard_denied_total{reason="not_at"}`，不记录正文。
- 白名单群 + @ 触发可组合使用；群白名单为空时仍拒绝所有群。

## 配额与限频

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| `daily_quota` | 200 条/账号/天 | 按发送动作计数，跨群累计 |
| `per_group_daily_quota` | 80 条/群/天 | 可选；默认 80 |
| `min_interval_ms` | 2000ms | 同群最小间隔 |
| `random_delay_ms` | 0–1500ms | 发送前抖动 |
| `duplicate_window_ms` | 60000ms | 同目标同内容抑制窗口 |
| `send_failure_threshold` | 3 | 连续发送失败触发熔断 |
| `audit_retention_days` | 30 | 审计元数据保留期 |
| `quiet_hours` | 关闭（`null`） | 静默时段不发送；可在面板开启 |
| `max_retries` | 0（发送类） | 发送类不自动重试 |

- 配额耗尽：返回 **`1504 RATE_LIMITED`**，消息不进入 outbox；metric `polaris_send_guard_denied_total{reason="quota"}`。
- 队列满：返回 **`1503 BACKPRESSURE`**，adapter 停止读取；不丢 pending。
- STOP：返回 **`1508 SEND_DISABLED`**。
- 24h 主力号冒烟脚本建议把 `daily_quota` 降到 96、`min_interval_ms` 提到 15 分钟；默认值不是冒烟值。

## Compose healthcheck 与重启策略

- healthcheck 使用 `/readyz`（不是 `/healthz`）：
  - `interval: 30s`
  - `timeout: 5s`
  - `start_period: 60s`
  - `retries: 3`
- `restart: unless-stopped` 只处理容器退出，**healthcheck 只把容器标为 unhealthy，不触发自动重启**。
- 离线时 `/readyz` 503，但容器不会被重启；这是有意的：重启真实 QQ 进程会丢登录态、可能触发扫码/风控，代价远大于等待恢复。
- 若未来要“unhealthy 自动重启”，必须先写 ADR，说明对 QQ 进程/登录态的影响，并默认关闭。

## 可观测字段

被拦截时只记录元数据，不记录正文：

```json
{
  "account_id": 123,
  "group_id": 456,
  "action": "send_group_msg",
  "reason": "whitelist|not_at|quota|rate_limit|stop|backpressure",
  "retcode": 1504,
  "at": "2026-11-11T..."
}
```

指标：

- `polaris_send_guard_circuit{state="CLOSED|OPEN"}`
- `polaris_send_guard_allowed_total`
- `polaris_send_guard_denied_total{reason}`
- `polaris_send_guard_audit_total`
- `polaris_send_disabled`

## M1.2 交付项

- SendGuard 在 `packages/core/src/send-guard.ts`（或等价模块）；
- STOP watchdog 每 5s 轮询；
- 白名单/@ 触发/配额/限频默认值；
- 单元测试 + MOCK-09 STOP/配额/白名单断言；
- README 风险与默认值说明；
- `start-core.ps1` 设置 `LODESTAR_DAILY_QUOTA`/`LODESTAR_AT_ONLY`/`LODESTAR_GROUP_WHITELIST`，M1.2 adapter 读取并传递给 SendGuard。

## S1-b 产品化（2026-11-13）

SendGuard 从 spike 的内存计数器升级为产品化单点：

- **唯一出口**：所有 `send_*` / `upload_*` 动作先过 SendGuard，再进入 adapter；
  loader/上游 adapter 不直接暴露给 AstrBot。
- **持久化**：SQLite `send_quota`、`send_rate`、`send_circuit`、`send_audit`；
  日配额和速率跨重启保持。
- **决策顺序**：STOP → circuit OPEN → 白名单 →
  @ 触发 → 静默时段 → 日配额/群配额 → 最小间隔 → 重复内容 → 允许。
- **熔断**：连续发送失败达到阈值、显式安全信号都会
  打开 circuit；OPEN 时拒绝发送但保留接收；只允许人工 `resetCircuit()`。
- **审计**：只写元数据（account、action、target、decision、reason、消息哈希/长度、
  retcode、时间），不写正文；默认保留 30 天。
- **指标**：
  - `polaris_send_guard_circuit{state="CLOSED|OPEN"}`
  - `polaris_send_guard_allowed_total`
  - `polaris_send_guard_denied_total{reason}`
  - `polaris_send_guard_audit_total`
- **默认值**：群白名单空（拒绝所有群）、私聊开启（白名单空=允许所有私聊）、
  @ 触发关闭、日配额 200、群配额 80、同群最小间隔 2s、重复窗口 60s、失败阈值 3、
  静默时段关闭。
- **测试**：配额/熔断持久化、审计不落正文、探针熔断、连续失败熔断、
  重复抑制、STOP、ActionRouter 拦截顺序。

## M4 WebUI/审计的 schema 严格性

- 我们自己的 config/audit schema 使用 **zod strict**，拒绝未知字段；
- SQLite 行带 `schema_version`；读取时校验，失败明确报错并保留原始行，不静默强转；
- 审计日志不存消息正文，只存元数据 + 哈希；迁移脚本必须可回滚。

## 重新审议触发条件

1. 默认值导致正常使用被过度拦截；
2. 需要按插件/命令级配额；
3. 平台规则变化要求更强的频控。
