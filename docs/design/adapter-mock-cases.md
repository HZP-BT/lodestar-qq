# adapter-mock 脚本化用例清单（设计稿）

- 状态：Draft，等待确认
- 日期：2026-11-11
- 依赖：[AdapterInterface 与上行事件契约](adapter-interface.md)
- 说明：本文只定义用例与验收断言，不包含实现代码。确认后再写 `@lodestar/adapter-mock`。

> 注（2026-11-26）：C 组探针用例（MOCK-11 / MOCK-12）与 MOCK-14 watchdog 已随
> [ADR 0008](../adr/0008-remove-probe.md) 移除独立探针而废弃；本文保留其余用例作为历史设计记录。

## 0. 控制面约定

mock 对外提供脚本化控制命令（具体传输在实现时定，HTTP/stdio 均可）：

| 命令 | 语义 |
| --- | --- |
| `emit <fixture>` | 注入一条规范化的 `AdapterEvent` |
| `emit-meta <lifecycle|heartbeat>` | 故意让 adapter 上报 Core 专属 meta，验证被拒绝 |
| `emit-burst <n> <fixture>` | 快速注入 n 条事件，用于背压 |
| `freeze` | 进程存活、`health()` 仍返回 ready，但停止发事件、停止响应探针 |
| `freeze-events` | 只停事件流，动作探针仍可用 |
| `resume-data` | 从 freeze 恢复数据面 |
| `crash` | 模拟 adapter 进程退出 |
| `slow-action <ms>` | 让下一个动作延迟返回，用于超时 |
| `auth-fail` | 模拟上游 401/403 |
| `set-version <qqBuild>` | 改变上报的 QQ build，用于版本矩阵 |
| `drop-next-event` | 丢弃下一条事件，用于 seq gap |
| `replay <eventKey>` | 重放已发送事件，用于幂等测试 |

所有命令必须可重复执行；每个用例开始前由测试脚本重置 mock 与 Core 的 SQLite（独立临时目录）。

## 1. 模拟收发（A 组）

### MOCK-01 私聊文本消息

- 触发：`emit private-text`。
- 期望：
  - Core 生成 `eventKey`、`deliverSeq`、`message_id`（有符号 int32，允许负数）。
  - AstrBot 收到 `post_type=message, message_type=private`，`raw_message` 与 fixture 一致。
  - `message_id` 可通过 `get_msg` 查回同一条消息。
  - **冷启动**：外部 OneBot 后端下，Core 连接后调 `get_login_info`；到首个 `online:true` 的 heartbeat ≤5s。
- 断言：
  - `eventKey` 稳定、非空；`deliverSeq` 从 Core 持久化计数器递增。
  - `message_id` 为安全整数且在 int32 范围；不出现 `>>> 0` 导致的符号翻转。
  - `get_msg(message_id)` 返回原始 `raw_message`。
  - **同账号同会话 5s 内两条完全相同的文本必须都投递到 AstrBot**；两条 `eventKey` 不同（deliverSeq 不同），不能因为内容相同被判 duplicate。
  - 冷启动到首个 `online:true` ≤5s。
- 失败判定：字段丢失、`message_id` 超范围、`get_msg` 找不到、相同文本第二条被去重丢弃、首个 online 超过 5s。

### MOCK-02 群聊 @ / 回复 / 图片

- 触发：`emit group-rich`，包含 at、reply、image 段。
- 期望：
  - AstrBot 收到完整消息段数组；`at` 的 `qq`、`reply` 的 `id`、`image` 的 `url/file` 不丢字段。
  - 引用关系指向已存在的 `message_id`。
- 断言：消息段逐字段比对；引用的 `message_id` 在 `message_ref` 中存在。
- 失败判定：段被降级为纯文本、引用 ID 被改写、图片字段丢失。

### MOCK-03 动作回环：send_group_msg

- 触发：AstrBot 发送 `send_group_msg`（带 `echo`）；mock 返回 `{message_id, ...}`。
- 期望：
  - Core 回传 `status=ok, retcode=0, echo` 精确一致。
  - 返回的 `message_id` 被登记到 `message_ref`，可用于后续 `delete_msg`/`get_msg`。
- 断言：echo 深比较；`message_id` 可查回；连接状态保持 `open`。
- 失败判定：echo 被改写、message_id 未登记、动作后状态抖动。

### MOCK-04 未实现动作与禁止 meta

- 触发：
  - AstrBot 调用未注册动作；
  - `emit-meta lifecycle` / `emit-meta heartbeat`。
- 期望：
  - 动作：`status=failed, retcode=1404`，`message` 含动作名；连接保持 `open`。
  - meta：`publish` 返回 `forbidden_event_source`，记 `adapter_forbidden_event_total` 并告警；AstrBot 只看到 Core 自己生成的 lifecycle/heartbeat，不出现双份。
- 断言：不触发重连、不进入 waiting/auth_failed；不产生事件重复；meta 拒绝次数 = 2。
- 失败判定：静默丢弃、返回 0、连接状态变化、adapter meta 被转发。

### MOCK-05 动作超时

- 触发：`slow-action 5000`，Core `actionTimeoutMs=100`。
- 期望：`status=failed, retcode=1501`；连接保持 `open`；超时后 semaphore 释放，后续动作可继续。
- 断言：超时响应带原 echo；随后再发一个正常动作能成功。
- 失败判定：连接被关闭、后续动作被永久阻塞、无超时响应。

### MOCK-06 message_id 归一化与稳定性

- 触发：依次注入：
  - 原生 ID 为负数（如 `-123456`）；
  - 原生 ID 超出 int32（如 `99999999999`）；
  - 缺少原生 ID；
  - 同一消息在 adapter 重启后重放。
- 期望：
  - 负数原样保留；
  - 超范围/缺失分配合成负数 ID；
  - 重启后同一 `eventKey` 不重复分配；`get_msg` 仍可查回。
- 断言：
  - ID 在 `[-2147483648, 2147483647]`；
  - `PRAGMA index_list('message_ref')` 含 `(account_id, message_id)` 主键与 `(account_id, native_message_id)` unique 索引；
  - 重复插入同一 `(account_id, message_id)` 或同一 native ID 必须抛错；
  - 重启后负数/合成 ID 可查回；重放不产生第二条消息；
  - **adapter 重启重报同一 `sourceEventId` → duplicate，AstrBot 只收到一次**；
  - **无 `sourceEventId` 的重报允许重复**，计入 `event_no_source_id_total`；报告写明重放缓冲 N 与重复上界；
  - `replayManifest` 覆盖最近 1000 条 sourceEventId 时，重启后的重报被去重。
- 失败判定：符号翻转、ID 冲突覆盖旧消息、重启后查不到、缺少 DB 约束、有 sourceEventId 仍重复投递。

## 2. 断连（B 组）

### MOCK-07 AstrBot WS 意外断开并恢复

- 触发：Core 与 AstrBot 的 WS 被强制关闭（1006）。
- 期望：
  - Core 进入 `waiting`，按指数退避重连（有抖动）。
  - 断开期间 message/notice/request 进入 outbox，返回 `queued`。
  - 重连后按 `deliverSeq` 顺序重放；AstrBot 收到事件，重复率受控。
- 断言：
  - 重连次数、退避序列符合配置；
  - outbox 深度先升后降；
  - 重放事件的 `eventKey` 与原始一致；
  - `event_replay_total`、`reconnect_total` 有记录；
  - `outbox_replay_total` / `outbox_replay_ratio`、`outbox_sending_stale_seconds`（≤60s）、`crash_replay_total` 有记录；
  - **跨 session 重放不乱序**：旧 session 的 deliverSeq=50 与新 session 的 deliverSeq=51 按 50→51 重放，不出现旧 50 排到新 1 之后；
  - 端到端重复率不在这里伪造：AstrBot 侧按 `message_id` 统计的 `duplicate_message_rate_e2e` 在 72h 联调用例中单独验证。
- 失败判定：事件丢失、顺序颠倒、重连风暴、端到端重复率（AstrBot 侧 message_id）>0.1%。

### MOCK-08 AstrBot 长时间离线（30s）

- 触发：断开 AstrBot 30s，期间注入 100 条普通消息。
- 期望：
  - 消息全部入 outbox（`queued`）；
  - 恢复后消息按 `deliverSeq` 顺序重放；
  - heartbeat 不由 adapter 产生（MOCK-04 已断言 adapter meta 被拒），因此没有“心跳占 outbox”。
- 断言：消息数 = 100；outbox 最终清空；无 adapter meta 入库。
- 失败判定：消息丢失、恢复后顺序错乱、adapter meta 被接收。

### MOCK-09 背压与队列上限

- 触发：`emit-burst 20000 normal`，AstrBot 消费速度被人为限制。
- 期望：
  - outbox 达到上限后，`publish` 返回 `backpressure` + `retryAfterMs`；
  - mock 暂停读取（不继续堆内存）；
  - message 不静默丢弃；low 优先级可丢弃并打点。
- 断言：
  - `event_outbox_depth` 不超过配置上限；
  - `event_drop_total{priority="low"}` 增加；
  - `event_drop_total{priority="normal"}` 为 0（除非明确配置允许）；
  - 进程 RSS 不随注入线性增长；
  - 重排缓冲不超过 256 条；禁止任何无界缓冲；
  - **纯 pending 超限**：10,000 条 pending、无可删 sent 时，publish 返回 `backpressure` + `1503`，不删 pending、不静默丢事件；
  - **STOP** 已随 SendGuard 移除（ADR 0009），不再断言 1508；
  - **清理不删 pending/被引用行**：清理 sent/过期 dedup/message_ref 时，pending outbox 与仍被 pending 引用的 message_ref 保留。
- 失败判定：OOM、消息静默丢失、背压不传导、缓冲无限增长、pending 被删。

### MOCK-10 鉴权失败不重试风暴

- 触发：AstrBot 反向 WS 对握手返回 401（或 403）。
- 期望：
  - Core 进入 `auth_failed`，**不自动重连**；
  - 日志包含 statusCode、脱敏 URL、是否配置 token、修复提示；
  - 修复 token 后 `setAccessToken()` + `resume()` 只发起一次新尝试；仍失败则回到 `auth_failed`；
  - `resume()` 在 `open` 等其他状态必须抛 `INVALID_STATE`，且不关闭现有连接。
- 断言：
  - 等待 300ms 内握手尝试次数 = 1；
  - 真实 401 时序下 resume 快速返回（<500ms，不空等 1s 关闭超时），尝试次数 = 2，且 100ms 内不再增加；
  - `resume()` 在 open 态抛错且 socket 仍 open；
  - 无 `reconnect_total` 增长。
- 失败判定：快速重试刷对端、resume 产生双连接、open 态 resume 人为断线、状态抖动、日志无诊断信息。

## 3. 静默假死（C 组）

### MOCK-11 进程活着、数据面停摆

- 触发：`freeze`（adapter 进程不退出，`health()` 仍 ready，但不再发事件、不再响应探针）。
- 期望：
  - Core 独立探针在 ≤90s 内从 ONLINE → DEGRADED → OFFLINE；
  - 恢复阶梯：重连 WS（无效）→ 重启 adapter → 若恢复则回到 HEALTHY；
  - 若重启后仍无数据，告警并停止发送，不静默假在线。
- 断言：
  - 探针失败次数/耗时达标；
  - `data_plane_seq` 停滞被记录；
  - 重启动作只发生一次，不进入重启风暴；
  - heartbeat 随状态变化（只断言标准字段，不依赖扩展字段）：
    - LOGGED_IN + ONLINE → `{online:true, good:true}`；
    - LOGGED_IN + IDLE → `{online:true, good:true}`；
    - LOGGED_IN + DEGRADED → `{online:true, good:false}`；
    - LOGGED_IN + OFFLINE → `{online:true, good:false}`（账号仍登录，数据面死）；
    - LOGGED_OUT → `{online:false, good:由 healthState 决定}`；
    - 任何 heartbeat 都不得出现硬编码的 `good:true`（DEGRADED/OFFLINE 时必须为 false）；
    - heartbeat 不得带 `polaris_state` 等非标准字段；
  - **空闲 6h**：模拟连续 6 小时零入站、动作探针健康 → IDLE，不产生 DEGRADED/OFFLINE，`/readyz` 200，容器不被标 unhealthy；
  - AstrBot 侧收到告警/状态事件（或 WebUI 告警）。
- 失败判定：进程存活被误判为健康、无限重启、假在线继续接收动作、heartbeat 内容与 probe 状态不一致、空闲误判 DEGRADED。

### MOCK-12 只断事件、动作仍可用

- 触发：`freeze-events`：事件流停止，但 `execute('get_login_info')` 仍正常返回。
- 期望：探针区分“事件面静默”和“动作面可用”；状态进入 DEGRADED，而不是直接 DEAD；策略可配置（告警/重启）。
- 断言：`inboundCursor` 停滞、主动探针成功；恢复后状态回 ONLINE；**白名单不包含 canary 群时，canary 仍通过过滤前 `inboundCursor`/`inboundNonceSeen` 证明入站面健康**。
- 失败判定：单一信号误判、或完全忽略事件面静默、或 canary 被群白名单过滤掉导致健康度恒差。

### MOCK-13 seq 缺口与重放

- 触发：`drop-next-event` 制造 seq gap；随后 `replay` 同一事件。
- 期望：
  - 重排窗口内等待缺失 `deliverSeq`，超时后记录 `event_seq_gap` 并继续；
  - 重排窗口默认 200ms、硬上限 500ms；缓冲上限 256 条；超时/溢出立即放行，**禁止无界等待/缓冲**；
  - `replay` 命中 `eventKey` → `duplicate`，不重复推给 AstrBot。
- 断言：AstrBot 只收到一次；指标 `event_seq_gap`、`event_dedup_total` 增加；等待时间不超过 500ms。
- 失败判定：重复推送、永久卡住等待 gap、缓冲无限增长、无指标。

### MOCK-14 探针与 Core 事件循环隔离

- 触发：让 Core 的事件处理循环人为阻塞（例如注入一个长同步任务），同时 adapter 健康。
- 期望：独立 watchdog 仍能检测 Core 假死并重启；探针不依赖 Core 的事件循环。
- 断言：Core 重启后 AstrBot 重连；事件不丢（outbox）；watchdog 日志可查。
- 失败判定：Core 卡死时探针也停止、无人重启。

## 4. 横切用例（D 组，M1.2 可先留桩）

### MOCK-15 版本不兼容

- 触发：`set-version 0` 或已知坏 build。
- 期望：Core 进入 `version_incompatible`；拒绝注入/启动；给出可操作提示；不反复重试。
- 断言：状态、错误码 1505、日志/告警存在。

### MOCK-16 多账号路由（M3）

- 触发：两个 mock 账号同时上报；AstrBot 分别调用动作。
- 期望：事件按 `accountId` 隔离；动作按 `self_id` 路由；message_id 不跨账号冲突。
- 断言：无交叉投递、无 message_ref 覆盖。

### MOCK-17 优雅停机

- 触发：`SIGTERM` / `stop()`。
- 期望：停止接收新事件；outbox 持久化；WS 正常关闭；重启后恢复。
- 断言：退出码 0；SQLite 完整；无半写事件。

## 5. 用例执行方式（建议）

- 每个用例独立临时目录 + 独立 SQLite。
- 测试脚本按 `MOCK-xx` 顺序执行，失败即停并保留日志/DB/指标快照。
- 输出一份 `reports/mock-<timestamp>.json`：
  - 用例 ID、通过/失败、耗时；
  - 关键指标（reconnect、outbox depth、dedup、seq gap、probe latency）；
  - 失败时的最后 200 行结构化日志。
- CI 先跑 A 组 + B 组的 mock 子集；C 组（假死/探针）需要真实定时器，放夜间或手动触发。

## 6. 当前实现状态（B/C 组）

| 用例 | 状态 | 证据 |
| --- | --- | --- |
| MOCK-07 断连重放 | Core 侧已完成 | `outbox-dispatcher.test.ts` |
| MOCK-08 长时间离线 | Core 侧已完成 | 100 条消息重放测试 |
| MOCK-09 背压/STOP | 背压部分已完成；STOP 已废弃（ADR 0009） | `event-sink.test.ts` |
| MOCK-10 鉴权失败 | Core 侧已完成 | `reverse-ws-client.test.ts` |
| MOCK-11 数据面停摆 | 已废弃（ADR 0008 移除探针） | — |
| MOCK-12 只断事件/canary | 已废弃（ADR 0008 移除探针） | — |
| MOCK-13 deliverSeq/去重 | Core 侧已完成 | `event-sink.test.ts`、`outbox-dispatcher.test.ts` |
| MOCK-14 Core 卡死 watchdog | 已废弃（ADR 0008 移除 Watchdog） | — |

`@lodestar/adapter-mock` 包已实现 MockAdapter（emit/freeze/freezeEvents/crash/canary/authFail/slowAction/动作桩）与 HTTP 控制面（`MockControlServer`），并有单元测试；`CoreRuntime` 的 E2E 测试覆盖“控制面 emit → Core → AstrBot mock”和 freeze/resume。尚未做的是独立 OS 进程的真实 adapter（mock 与 Core 在同一测试进程内）。

## 7. 待确认

1. `freeze` 的判定阈值（90s）是否沿用设计目标；是否允许按配置缩短用于测试。
2. `freeze-events` 场景下，默认策略是告警还是自动重启 adapter。
3. 背压时 normal 消息是否允许丢弃（当前设计：不允许，只允许 low）。
4. 测试报告格式与存放目录。
