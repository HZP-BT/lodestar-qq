# S0 结案与 S1 边界（2026-11-13）

> 定位：A 路线可行性验证已收束，不再重新论证路线，不讨论改选 B。
> 本文只回答三件事：S0 证明了什么、S1 先做什么、哪些能力必须留在 backlog。
>
> S0 证据：commit `413d745`、`06c6898`、`0d4c8eb`、`f61f79c`、`3f09544`；
> 报告 `docs/design/ntqq-liteloader-validation-2026-11-13.md` 第 6.2.2 节；
> 冻结基线 `D:\qq-patch-baseline\2026-11-13-9.9.33-52230`。

> 注（2026-11-27）：本文中的 SendGuard / 白名单 / 配额 / STOP 哨兵设计已于
> [ADR 0009](../adr/0009-remove-send-guard.md) 移除；相关章节保留为历史设计记录。

## 1. S0 结案：已证明 / 未证明

### 1.1 已证明（有端到端证据）

| 能力 | S0 结果 | 证据 |
| --- | --- | --- |
| 代码自主的 loader | 自定义 `package.json` 入口加载 QQ 原始 main；不依赖 LiteLoader | `self-loader-2480.jsonl`、`self-loader-29568.jsonl` |
| 主进程会话附着 | `getNTWrapperSession("nt_1")` → `getMsgService()` 成功 | `attached` 日志 |
| 私聊文本收发 | 收到私聊文本；`send_private_msg` 端到端，另一账号实际收到 | `onebot-29568.jsonl` |
| 群文本收发 | `send_group_msg` 文本，群内实际收到 | `onebot-26628.jsonl` |
| 缓存图片/语音回发 | 收到图片/语音后缓存元素并回发；群内显示/播放正常 | `group-media/onebot-26628.jsonl` |
| 任意新图片上传 | 本地 JPEG → `getRichMediaFilePathForGuild` → 复制 → `sendMsg`；227,194 字节、864×1920、`result=0`，群内显示正常 | `upload-media/onebot-7496.jsonl` |
| 任意新 AMR 上传 | 本地 AMR 2,685 字节、duration=1 → 上传 → `sendMsg result=0`，群内播放正常 | `upload-media/onebot-7496.jsonl` |
| OneBot 契约基础面 | WS 3001、`message` 事件、`get_login_info/get_status/get_version_info`、`send_private_msg/send_group_msg/send_msg` | 适配器日志 |
| 环境可回滚 | 6 个关键文件 SHA256 与测试前一致；QQ 已恢复原版 | 各轮 rollback 记录 |

**精确表述：S0 证明的是“代码自主的最小协议端能收发并接上 OneBot 契约”。**
它不是“完整的 OneBot 实现”，也不是“生产可用的 NTQQ 后端”。

### 1.2 未证明（不得写成能力）

| 未证明项 | 现状 | 影响 |
| --- | --- | --- |
| 长期风控安全 | 只有短时、测试号、低量观察；没有 14 天/30 天数据 | 不能承诺“不封号/不冻结” |
| 跨 QQ 版本可维护 | 只验证 `9.9.33-52230`；patcher、`nt_1`、事件字段都可能随更新变化 | 每次升级都要重验 |
| 其他语音格式 | 只验证 AMR；silk/mp3/ogg 未测 | 语音发送不是通用能力 |
| 私聊图片/语音 | group 媒体已验；private 媒体未单独验 | 私聊媒体仍在 backlog |
| 好友/群通知 | `onRecvSysMsg` 等有回调，但未映射为 OneBot notice | 事件面不完整 |
| 撤回、`get_msg`、合并转发 | kernel 有方法，但未实现/未验证 | backlog |
| 多账号 | 只验证 `nt_1` 单会话 | 多账号未证明 |
| Linux/macOS | 未测 | 平台边界未证明 |
| 持续负载/长稳 | 没有 24h/72h/14d 连续运行数据 | 稳定性未证明 |
| 自动更新锁定 | 验证时未禁用；更新器当时判断无需更新 | 观察期必须先锁版本 |

## 2. 硬结论：本项目的价值不是功能数量

**本项目价值 = 附着真实 QQ + outbox + 本地面板。**

- 不是“功能对标 LuckyLilliaBot”；
- 不是“再做一个 LLOneBot”；
- 原生 loader 只是附着手段，不是产品卖点；
- 任何 backlog 功能只有能改善**可靠性、可控性、可运维性、部署**时才进入主线；
- 功能数量不构成竞争力，风控可控性和故障可解释性才构成。

LuckyLilliaBot 仍在维护（v8.3.2，GPL-2.0），功能面更全。Lodestar 不追功能数量，
也不复制其代码；差异化只放在上述五个能力上。

## 3. S1 边界：只做“安全壳 + 观察”，不做功能堆叠

### 3.1 S1 在范围内

- 单一发送出口（SendGuard）；
- 白名单/@ 触发/日配额/最小间隔/静默时段/STOP；
- 持久化配额（重启不重置）；
- 审计日志（只记元数据，不记正文）；
- 风控信号熔断（连续发送失败、安全提示）；
- 探针/health/metrics 与发送决策联动；
- 低量观察 runbook、每日记录模板、立即停止条件；
- 版本锁定与回滚流程。

### 3.2 S1 不在范围内（全部 backlog）

- 语音格式转码（silk/mp3→AMR）；
- 合并转发、撤回、`get_msg`；
- 好友事件、群通知、请求事件；
- 多账号、多实例；
- Linux/macOS；
- UI/插件市场/主题；
- 任意新功能对标。

S1 的成功标准不是“功能更多”，而是：**默认拒绝、可审计、可熔断、可停止、可回滚。**

## 4. S1-a：风控长稳观察方案

### 4.1 目的

在**受控低量**下观察测试号连续在线 N 天，记录是否出现下线/封禁/安全提示，以及
`nt_1` 会话、事件字段是否漂移。它是观察，不是安全证明。

### 4.2 参数

- 账号：仅测试号；不使用主力号；
- 群：仅一个测试群；测试号只在该群；
- 周期：14 天（先过 72h 门槛，再 7d、14d 检查点）；
- 发送：仅 @ 触发回复；≤20 条/天；同群最小间隔 2s；媒体 ≤1 条/天；
- 不主动加好友、不批量、不群发、不营销；
- 版本：锁定 `9.9.33-52230`；观察期不允许 QQ 自动更新。

### 4.3 每日记录

| 项 | 记录方式 |
| --- | --- |
| 在线时长/掉线次数 | QQ 进程 + 登录状态 + 探针 |
| 运行状态 | ONLINE/OFFLINE/UNKNOWN 时间线 |
| `nt_1` 附着 | 成功/失败次数、失败原因 |
| 事件 schema | 每天计算一次消息字段指纹（键集合哈希），与 D0 对比 |
| 收发计数 | 发送/接收成功、失败、重试 |
| 媒体 | 图片/语音下载/上传成功数 |
| 安全信号 | 安全中心提示、强制下线、验证码、账号限制 |
| 资源 | QQ/Core RSS、崩溃/重启 |
| 版本 | QQ 版本、`QQNT.dll` 哈希、loader 哈希 |

### 4.4 爆炸半径控制

- 测试号 + 单群 + 白名单；
- 默认拒绝所有非白名单目标；
- 每日配额 + 最小间隔 + 静默时段；
- `data/STOP` 哨兵，≤5s 停止发送；
- 媒体上传 ≤1/天；
- 任何异常先停发送，不先重启/重试。

### 4.5 立即停止条件（任一触发即停）

- QQ 安全中心出现“非法外挂/风险”提示；
- 被强制下线、账号被限制、需要验证码/安全验证；
- 账号被踢下线后无法正常登录；
- QQ 崩溃循环、`nt_1` 持续不可附着；
- 事件 schema 指纹变化、消息字段缺失；
- 连续发送失败超过阈值（建议 3 次）；
- QQ 版本或 `QQNT.dll` 哈希变化；
- 出现任何无法解释的风控信号。

停止后：停发送 → 保留日志 → 回滚 QQ 到原版 → 记录时间线 → 不自动恢复。

### 4.6 结论口径

14 天无异常只能表述为“**未观察到风控信号**”，不能写成“安全/不会封号”。

## 5. S1-b：SendGuard 产品化设计

### 5.1 目标

把 spike 里每个 OneBot send 动作直接调用 `sendMsg` 的裸出口，收敛为**唯一发送入口**：

```text
AstrBot → Lodestar Core → SendGuard → OneBot upstream adapter → loader → QQ
```

loader 的 WS 只允许 Core 连接（localhost + token），不直接暴露给 AstrBot。

### 5.2 决策顺序（默认拒绝）

1. `data/STOP` 存在 → 拒绝（1508）；
2. 熔断器 OPEN → 拒绝（1502/1504）；
3. 目标不在白名单 → 拒绝（1504）；
4. 非 @ 触发 / 非回复 → 拒绝（1504）；
5. 静默时段 → 拒绝（1504）；
6. 日配额耗尽 → 拒绝（1504）；
7. 同群最小间隔未到 → 拒绝（1504）；
8. 重复内容/重复目标 → 抑制；
9. 全部通过 → 允许，写审计，调用唯一 send 出口。

### 5.3 持久化

- SQLite 表：`send_quota`（account/group/date/count）、`send_audit`、`send_state`；
- 重启不重置日配额；
- 审计只存：时间、账号、目标类型/哈希、动作、决策、原因、消息长度/内容哈希、
  `message_id`；不存正文；
- 保留期可配置，默认 30 天。

### 5.4 熔断

- 触发：连续发送失败、适配器断开、安全信号；
- 状态：CLOSED → OPEN → HALF_OPEN；
- OPEN 时拒绝所有发送，保留接收；
- 只能人工 reset，自动恢复需单独 ADR；
- 指标：`polaris_send_guard_state`、`polaris_send_denied_total{reason}`。

### 5.5 集成点

- Core 的 OneBot action router：所有 send 动作先过 SendGuard；
- `/metrics`：允许/拒绝/熔断/配额；
- `/readyz`：SendGuard OPEN 时仍可 ready（接收正常），但发送指标告警；
- 配置：`config/send-guard.json`，默认最保守。

### 5.6 S1-b 验收

- 默认拒绝所有群；
- 白名单测试群 + @ 触发 + 日配额 20 + 最小间隔 2s 生效；
- 配额跨重启保持；
- `data/STOP` ≤5s 生效；
- 审计无正文；
- 单元/集成/混沌测试通过（mock adapter，不需要改 QQ）。

### 5.7 实现状态（2026-11-13）

S1-b 已实现并通过 `pnpm verify`：

- `packages/core/src/send-guard.ts`：单一出口、策略顺序、熔断、审计、持久化接口；
- `packages/core/src/storage/send-guard-store.ts`：SQLite 配额/速率/熔断/审计；
- `packages/core/src/storage/schema.ts`：`send_quota` / `send_rate` / `send_circuit` /
  `send_audit`；
- `packages/core/src/runtime/core-runtime.ts`：接入存储、探针健康、发送成功/失败；
- `/metrics`：`polaris_send_guard_circuit`、`polaris_send_guard_allowed_total`、
  `polaris_send_guard_denied_total{reason}`、`polaris_send_guard_audit_total`、
  `polaris_send_disabled`；
- 测试：配额/熔断跨重启、审计只记元数据、探针熔断、失败熔断、重复抑制、STOP、
  ActionRouter 顺序；
- S1-a runbook：`docs/runbooks/s1a-14d-observation.md`；
- 提交：`9b7494f`（S1-b 产品化）。

## 6. 先做哪个：建议 S1-b

**建议先 S1-b（SendGuard），再 S1-a（14 天长稳观察）。**

理由：

1. S1-a 需要一个安全壳；否则观察期本身就在裸发送；
2. S1-b 可以在 Core + mock 上完成，不需要再次修改 QQ，风险最低；
3. S1-b 是差异化能力，直接决定“不是又一个 LLOneBot”；
4. S1-a 是时间型验证，放在 S1-b 之后可以用 guard 的 STOP/熔断保护测试号。

最终由你拍板：先 S1-a 还是先 S1-b。

## 7. Backlog（不进入 S1 关键路径）

| 项 | 实现要点 | 依赖的 kernel API 是否已在 S0 验证 |
| --- | --- | --- |
| 语音转码 silk/mp3→AMR | 用 `silk-wasm` + ffmpeg 现成件转码，再走已验证的 `getRichMediaFilePathForGuild` + `sendMsg` | 上传 API 已验证（AMR）；silk 路径未验证 |
| 其他图片格式 PNG/GIF/WebP | `image-size` 取尺寸，按 PicType 映射；上传路径同 JPEG | JPEG 已验证；其他格式未验证 |
| 合并转发 | `multiForwardMsgWithComment` / `buildMultiForwardMsg` | API 存在，未端到端验证 |
| 撤回 | `recallMsg` / `deleteRecallMsg` | API 存在，未验证 |
| get_msg | `getMsgsByMsgId` / `getSingleMsg` | API 存在，未验证 |
| 好友事件 | `NodeIKernelBuddyService` + 监听器 | 服务存在，监听未验证 |
| 群通知/请求事件 | `onRecvSysMsg` 等回调映射 OneBot notice | 有回调，未映射/未验证 |
| 私聊媒体发送 | 与群媒体相同，但 peerUid 来自私聊缓存 | 群媒体已验证；私聊未验证 |
| 多账号 | 多个 `getNTWrapperSession(<session>)` / 多实例 | 仅 `nt_1` 验证 |
| Linux/macOS | 不同 QQ 构建、不同 patcher/loader 路径 | 未验证 |
| 强制更新重验 | patcher 特征码、QQNT 哈希、loader 入口、`nt_1`、事件 schema | 流程项，非 API |
| 任意语音格式上传 | 转码后仍走 `getRichMediaFilePathForGuild` | AMR 已验证；其他格式未验证 |

这些条目**不进入 S1 关键路径**，也不自研编解码；优先复用成熟件。只有当它们直接改善
可靠性/可控性/部署时才重新评估优先级。

## 8. 已拍板与执行状态

- 已拍板：先 S1-b（SendGuard），再 S1-a（14 天观察）。
- S1-b 已实现并通过 `pnpm verify`（见 5.7）。
- S1-a runbook 已准备：`docs/runbooks/s1a-14d-observation.md`。
- 14 天观察尚未启动；启动前需要按 runbook 完成版本锁定、测试号/测试群和
  SendGuard 保守配置。
- 在观察开始前不新增收发/媒体功能点，不修改 QQ。
