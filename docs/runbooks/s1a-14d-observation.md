# S1-a：14 天低量风控观察 Runbook

> 注（2026-11-27）：SendGuard / STOP 哨兵已于 [ADR 0009](../adr/0009-remove-send-guard.md) 移除；
> 本文中的 SendGuard 步骤保留为历史记录，当前版本请以“停止 Core 进程”作为停用手段。

> 目标：在 SendGuard 安全壳下，用测试号连续观察 14 天，记录是否出现下线/封禁/安全
> 提示，以及 `nt_1` 会话和事件字段是否漂移。**这是观察，不是安全证明。**
>
> 硬性安全限制与清理步骤见 [S1 安全限制与测试环境清理](s1-safety-and-cleanup.md)。
>
> 前置：S1-b 已实现（SendGuard 单点、持久化配额、审计、熔断）；QQ 已按冻结基线
> `9.9.33-52230` 部署；只用测试号和一个测试群。

## 1. 拓扑

```text
另一个测试账号
   │  @ 测试号 / 测试群消息
   ▼
测试 QQ（patched QQNT.dll + 自研 loader，ws://127.0.0.1:3001）
   ▲  OneBot WS
   │
Lodestar Core（scripts/upstream.mjs，SendGuard 在此）
   ▲  OneBot reverse WS 6199
   │
AstrBot（只连 Core，不直连 loader）
```

要点：AstrBot 不直接连 loader；所有 send 动作先过 Core 的 SendGuard。

## 2. 观察前检查

- [ ] QQ 版本锁定 `9.9.33-52230`；`QQNT.dll` 哈希与基线一致；自动更新已处理。
- [ ] 测试号登录；测试群仅一个；测试号只在该群。
- [ ] `config/upstream.json` 存在（已 gitignore），`selfId` 为测试号，`upstream.url`
      指向 loader 3001，`health.host=127.0.0.1`；AstrBot token 已填。
- [ ] SendGuard 配置为保守值（示例）：

```json
{
  "groupWhitelist": [<测试群号>],
  "privateEnabled": false,
  "atOnly": true,
  "dailyQuota": 20,
  "perGroupDailyQuota": 20,
  "minIntervalMs": 2000,
  "randomDelayMs": 1000,
  "duplicateWindowMs": 60000,
  "sendFailureThreshold": 3,
  "auditRetentionDays": 14,
  "quietHours": { "startHour": 0, "endHour": 8 },
  "stopFile": "data/STOP"
}
```

- [ ] Core 启动后 `/readyz` 为 200；`/metrics` 有 `polaris_send_guard_circuit{state="CLOSED"} 1`。
- [ ] 手动 @ 测试号发一条消息，确认回复成功且审计有记录。
- [ ] 写入 `data/STOP`，确认下一次发送返回 1508；删除 STOP。

## 3. 每日记录（建议每天 2 次）

| 项 | 来源 | 记录 |
| --- | --- | --- |
| QQ 在线/掉线 | QQ 进程 + 登录窗口 | 次数、时间 |
| 运行状态 | `/metrics` `polaris_health_state` | ONLINE/OFFLINE/UNKNOWN 时间线 |
| `nt_1` 附着 | `self-loader-*.jsonl` | 成功/失败次数、失败原因 |
| Core 客户端 | `/metrics` `polaris_client_up` | 0/1 |
| 收发计数 | AstrBot/群 + 审计 | 发送成功/失败/拒绝 |
| SendGuard | `/metrics` | circuit、allowed、denied reasons、audit |
| 审计 | SQLite `send_audit` | 是否只有元数据、无正文 |
| 媒体 | 群内实际显示 | 图片/语音是否正常（如使用） |
| 安全信号 | QQ 安全中心 | 提示/强制下线/验证码 |
| 版本/哈希 | 文件 | QQ 版本、`QQNT.dll` 哈希、loader 哈希 |
| 事件 schema | 消息字段键集合 | 与 D0 指纹比较 |
| 资源 | 任务管理器/ps | QQ/Core RSS、崩溃/重启 |

### 3.1 审计查询

SQLite 表 `send_audit`（Core 的 `data/polaris.db`）。只允许检查元数据：

```sql
SELECT created_at, action, target_type, target_id, decision, reason, retcode
FROM send_audit
ORDER BY id DESC
LIMIT 20;
```

不要导出 `message_hash` 之外的正文；本项目也不存正文。

### 3.2 事件 schema 指纹

每天记录一次消息事件的字段键集合（例如 `msgId/msgSeq/chatType/peerUid/senderUin/
elements[].elementType`）并计算哈希。与 D0 不一致时停止，重新验证 loader/字段映射。

## 4. 每日操作

1. 检查 QQ 是否在线、Core `/readyz` 是否 200。
2. 记录 `/metrics` 关键值。
3. 只做 1–3 次低量测试：另一个测试账号 @ 测试号，确认回复。
4. 不主动加好友、不群发、不批量、不营销。
5. 记录安全中心是否有提示；有任何异常先停发送，不先重启/重试。

## 5. 立即停止条件（任一触发）

- QQ 安全中心出现“非法外挂/风险”提示；
- 被强制下线、账号被限制、需要验证码/安全验证；
- 被踢后无法正常登录；
- QQ 崩溃循环、`nt_1` 持续不可附着；
- 事件 schema 指纹变化或关键字段缺失；
- 连续发送失败达到阈值（默认 3）；
- QQ 版本或 `QQNT.dll` 哈希变化；
- 任何无法解释的风控信号。

停止顺序：

1. 写 `data/STOP`；
2. 停止 Core；
3. 保留日志/审计/`/metrics` 快照；
4. 回滚 QQ 到原版（基线 `originals/`）；
5. 记录时间线和触发条件；
6. 不自动恢复，人工评估后再决定。

## 6. 14 天判定

只有同时满足以下条件，才能写“**未观察到风控信号**”：

- 14 天内有连续在线记录；
- 没有触发停止条件；
- 收发在配额内，失败率可解释；
- 审计只有元数据；
- 连接/`nt_1` 没有持续不可用；
- 版本/哈希未漂移。

不能写成“安全”“不会封号”。观察期结束后仍需人工评估是否继续。

## 7. 回滚

```powershell
# 先停止 Core 和 QQ
Copy-Item -LiteralPath "D:\qq-patch-baseline\2026-11-13-9.9.33-52230\originals\QQNT.dll" -Destination "D:\qq\versions\9.9.33-52230\QQNT.dll" -Force
```

```powershell
Copy-Item -LiteralPath "D:\qq-patch-baseline\2026-11-13-9.9.33-52230\originals\package.json" -Destination "D:\qq\versions\9.9.33-52230\resources\app\package.json" -Force
```

移走 `app_launcher` 入口；确认 `D:\qq\dbghelp.dll` 不存在；删除 `data/STOP` 后重新启动
原版 QQ。
