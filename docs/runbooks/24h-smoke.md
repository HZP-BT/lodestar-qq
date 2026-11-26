# 24h 主力号冒烟 Runbook

> 注（2026-11-27）：SendGuard / STOP 哨兵已于 [ADR 0009](../adr/0009-remove-send-guard.md) 移除；
> 本文中的 SendGuard 设置与 `data/STOP` 步骤保留为历史记录，当前版本请以“停止 Core 进程并退出 QQ”作为停用手段。（M2）

## 目标

用主力号跑一次 24h 最小风险冒烟，验证：

- 登录态能保持；
- 断线能被发现并自动重连；
- 消息收发正常，P95 延迟与内存曲线可接受；
- 一键停用可用。

**这不是压力测试，也不是“零封号”证明。** 能接受账号风险才执行；否则继续用 mock/回环。

## 前置条件

- M2 的 adapter 与 probe 已完成；`pnpm build` 通过。
- 只加入一个白名单测试群；只在被 @ 时回复。
- 关闭主动群发、加好友、营销、定时推送。
- 日额度：≤96 条；建议 ≤1 条/15 分钟。
- 静默时段：00:00–08:00 不发送。
- 准备一个可随时停止的终端/桌面。

## 启动

```powershell
cd E:\daiti
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 `
  -SelfId "123456789" `
  -Token "your-token" `
  -GroupId "987654321" `
  -DailyQuota 96 `
  -Start
```

脚本会：

- 生成/更新 `config/polaris.json`；
- 设置 `sendGuard.dailyQuota=96`、`atOnly=true`、群白名单（由 **Core SendGuard** 读取，与后端无关）；
- 注册并启动计划任务 `LodestarCore`；
- 日志写入 `logs/`，PID 写入 `logs/polaris-core.pid`。

## 监控

- 日志：`logs/core.out.log`、`logs/core.err.log`。
- 指标（M1.4 后）：`/healthz`、`/readyz`、`/metrics`。
- 记录：在线时长、非人工掉线次数、自动恢复次数、消息成功/失败、重复率、P95、RSS 曲线。

## 立即停止（一键停用）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\stop.ps1
```

脚本会：

- 写入 `data/STOP` 哨兵（Core watchdog 每 5s 轮询，SendGuard 停止发送）；
- 停止 PID 文件对应的进程；
- 删除 PID 文件。

如果进程无响应：

```powershell
Stop-Process -Id (Get-Content logs\polaris-core.pid) -Force
```

## 立即停止的条件

出现任一情况，立刻执行一键停用，不要“再观察一下”：

- QQ 弹出安全验证、异地登录、设备验证；
- 被踢下线且重新登录需要验证码；
- 同一群连续发送失败或频率限制；
- 连接进入 OFFLINE 且重启 adapter 后仍不恢复；
- 内存持续上涨（例如 1h 内 RSS 增长 >30%）。

## 停止后的取证

保留：

- `logs/` 全部日志；
- `data/` 下的 SQLite（脱敏后）；
- `/metrics` 快照；
- 掉线时间点、QQ 客户端提示截图。

## 风险声明

**主力号仍可能被风控、踢下线、临时或永久封禁。Lodestar 只能降低概率，不能归零；风险由使用者自担。** 不要用主力号做高频/群发/压力测试。
