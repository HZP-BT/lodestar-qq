# S1 安全限制与测试环境清理 Runbook

> 适用：S1 低量观察、SendGuard 安全壳、NTQQ 自研 loader 的测试环境。
> 本文合并**硬性安全限制**、**停止/回滚条件**和**测试环境清理步骤**。
> 观察流程本身见 [S1-a 14 天低量观察](s1a-14d-observation.md)。

## 1. 硬性安全限制（不可放宽）

| 限制 | 要求 |
| --- | --- |
| 账号 | 只用测试号；**禁止主力号**；禁止批量注册/养号 |
| 范围 | 只在一个白名单测试群；禁止群发营销、加好友引流、批量操作 |
| 触发 | 只回复 @ 测试号的消息；不主动群发 |
| 量级 | ≤20 条/天；同群最小间隔 2s；媒体 ≤1 条/天；静默 00:00–08:00 |
| 验证 | 不绕过验证码、安全验证、风控校验；遇到验证立即停止 |
| 数据 | 不读取/上传登录凭证、通讯录、消息正文到第三方；审计只存元数据 |
| 网络 | Core/loader/health 只绑 `127.0.0.1`；不暴露公网 |
| 分发 | 不产出可分发的 patcher/loader/绕过 DLL；基线仅本机使用 |
| 责任 | 账号被风控/下线/封禁的风险由使用者自担；不承诺“不封号” |
| 变更 | 观察期锁定 QQ 版本；升级/重打补丁必须重新验证并记录 |

## 2. 安全壳（S1-b）

所有发送先过 Core 的 SendGuard，再进 adapter/loader：

```text
AstrBot → Core → SendGuard → upstream adapter → loader → QQ
```

- 默认拒绝：空群白名单、私聊关闭、@ 触发；
- STOP：`data/STOP` 存在时下一次发送立即返回 1508；
- 配额/速率/重复抑制：SQLite 持久化，跨重启保持；
- 熔断：探针 DEGRADED/OFFLINE、连续发送失败 3 次、显式安全信号 → OPEN；
- 审计：只写账号/目标/动作/决策/原因/哈希/长度/retcode/时间；
- 指标：`/metrics` 的 `polaris_send_guard_*`。

## 3. 测试环境组成

| 路径 | 内容 | 清理策略 |
| --- | --- | --- |
| `D:\qq` | 原版 QQ（测试后已恢复） | **保留**，核对哈希 |
| `D:\qq-backup-原始` | 安装目录完整备份 | **保留** |
| `D:\qq-patch-baseline\2026-11-13-9.9.33-52230` | 冻结基线/证据 | **保留**，只读参考 |
| `D:\qq-loader` | 测试 loader、LiteLoader、OneBot 适配、日志、测试媒体 | **删除** |
| `C:\Users\<user>\AppData\Local\Temp\lodestar-qq-verify` | patcher/dbghelp/LiteLoader 下载 | **删除** |
| `E:\daiti\config\upstream.json` | 本地测试配置（含测试号/群） | **删除**，按 runbook 重建 |
| `E:\daiti\data\polaris.db` | dev-mock/test 数据库 | **删除** |
| `LodestarCore` 计划任务 | 当前指向 `dev-mock.mjs` 的测试任务 | **停止并禁用**，不删除 |
| `D:\qq-loader\msg-events.jsonl` | LiteLoader 阶段测试消息正文与 UID | **先截断，再删除** |

## 4. 清理步骤

### 4.1 停止所有测试进程

```powershell
Stop-Process -Name QQ,QQEX -Force -ErrorAction SilentlyContinue
Stop-Process -Id <dev-mock-node-pid> -Force -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName LodestarCore -ErrorAction SilentlyContinue
Disable-ScheduledTask -TaskName LodestarCore -ErrorAction SilentlyContinue
```

如果 `Disable-ScheduledTask` 返回“拒绝访问”，说明该任务注册时要求管理员权限；
请在**管理员 PowerShell** 或任务计划程序里手动禁用，不要用脚本绕过权限。
确认 3001/6199/18080 没有测试进程监听。

### 4.2 先处理 PII

`msg-events.jsonl` 含测试消息正文/UID，**先截断再删除**：

```powershell
Set-Content -LiteralPath "D:\qq-loader\msg-events.jsonl" -Value "" -Encoding UTF8
Remove-Item -LiteralPath "D:\qq-loader\msg-events.jsonl" -Force
```

`data/polaris.db` 可能含测试事件，直接删除前先确认没有 Core/dev-mock 在运行。

### 4.3 删除 test 配置与日志

```powershell
Remove-Item -LiteralPath "E:\daiti\config\upstream.json" -Force
Remove-Item -LiteralPath "E:\daiti\data\polaris.db" -Force
Remove-Item -LiteralPath "E:\daiti\data\STOP" -Force -ErrorAction SilentlyContinue
```

### 4.4 删除 loader、LiteLoader、OneBot 与测试媒体

```powershell
Remove-Item -LiteralPath "D:\qq-loader" -Recurse -Force
Remove-Item -LiteralPath "C:\Users\example\AppData\Local\Temp\lodestar-qq-verify" -Recurse -Force
```

如果系统拒绝删除，改为移到隔离目录并确认不再被任何进程加载；不要用脚本绕过安全策略。

### 4.5 校验 QQ 原版

```powershell
Get-FileHash "D:\qq\versions\9.9.33-52230\QQNT.dll" -Algorithm SHA256
Get-FileHash "D:\qq\versions\9.9.33-52230\resources\app\package.json" -Algorithm SHA256
```

期望：

```text
QQNT.dll        f6f35b8517da5c38ace8d4b6abad1abed42f61c8e706d23192a22d91c7620e59
package.json    a24c8293c9c5e692f5b2e329daaf9642c7fbf6c10795e76df33f5119f178a379
```

并确认：

- `resources\app\app_launcher` 不存在；
- `D:\qq\dbghelp.dll` 不存在；
- `QQNT.dll.bak` 不在 QQ 目录；
- QQ 未运行。

### 4.6 保留项

- `D:\qq-backup-原始`：完整回滚点；
- `D:\qq-patch-baseline\2026-11-13-9.9.33-52230`：冻结基线/证据；
- `E:\daiti\config\polaris.json`：用户已有配置（如保留 dev-mock 需重新启用任务）。

## 5. 清理后检查清单

- [ ] 无 `QQ.exe`/`QQEX.exe`/测试 `node` 进程；
- [ ] 3001/6199/18080 无测试监听；
- [ ] `D:\qq-loader` 已删除；
- [ ] `%TEMP%\lodestar-qq-verify` 已删除；
- [ ] `config/upstream.json`、`data/polaris.db` 已删除（或确认保留原因）；
- [ ] `msg-events.jsonl` 已截断/删除；
- [ ] QQ 两关键哈希与基线一致；`app_launcher`/`dbghelp`/`.bak` 不存在；
- [ ] `LodestarCore` 任务已停止并禁用；
- [ ] AstrBot token 若曾在测试配置/日志中出现，已轮换；
- [ ] 基线/备份仍在。

## 6. 重新进入 S1-a 观察

1. 按 [S1-a 14 天低量观察](s1a-14d-observation.md) 重建 `config/upstream.json`；
2. 用冻结基线重新 staging QQ（patched `QQNT.dll` + loader）；
3. 启动 AstrBot/Core，确认 `/readyz` 和 SendGuard 指标；
4. 测试号登录、单群 @ 测试；
5. 才开始 14 天记录。

## 7. 事故处理

- 安全中心提示、强制下线、账号限制 → 写 `data/STOP`，停 Core/QQ，记录时间线，回滚；
- 连续发送失败/探针 DEGRADED → SendGuard 熔断，人工 `resetCircuit()` 前先查原因；
- 版本/哈希漂移 → 停止观察，重新验证 patcher/loader/`nt_1`/事件 schema；
- 任何不确定的风控信号 → 先停，不先重启/重试。
