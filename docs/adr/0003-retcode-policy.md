# ADR 0003：OneBot retcode 策略

- 状态：Accepted（修订）
- 日期：2026-11-11
- 决策者：项目所有者、维护者

## 背景

OneBot v11 规范只定义 `status` / `retcode` 字段，**没有定义数值表**。社区常见值来自 CQHTTP 文档、go-cqhttp/NapCat 等实现，语义并不统一。此前把 `103` 标成“动作未实现/CQHTTP 惯例”缺乏可核查出处；CQHTTP 3.4 的 `103` 实际是“操作失败/权限或文件系统异常”。

## 决策

Lodestar 只生成**有出处**的 retcode：

| retcode | 含义 | 出处 | Core 行为 |
| --- | --- | --- | --- |
| 0 | 成功 | OneBot v11 规范 | 主动生成 |
| 1 | 异步受理 | OneBot v11 规范 | 预留（尚未实现 async） |
| 100 | 请求参数格式错误（当前路径：params 不是对象） | CQHTTP 3.4 API「响应说明」 | 主动生成 |
| 102 | 数据无效/无权限 | CQHTTP 3.4 API「响应说明」 | 预留 |
| 1400 | WebSocket 对应 HTTP 400 | CQHTTP 3.2 WebSocket API | 预留（当前不生成） |
| 1401 | WebSocket 对应 HTTP 401 | CQHTTP 3.2 WebSocket API | 仅透传/预留（握手期断连，不在动作响应生成） |
| 1403 | WebSocket 对应 HTTP 403 | CQHTTP 3.2 WebSocket API | 仅透传/预留（握手期断连，不在动作响应生成） |
| 1404 | WebSocket 对应 HTTP 404；动作不存在 | CQHTTP 3.2 WebSocket API；NapCat 兼容 | 主动生成（未注册动作） |
| 1500 | Lodestar 内部错误 | Lodestar 自定 | 主动生成（未捕获异常） |
| 1501 | 动作超时 | Lodestar 自定 | 主动生成 |
| 1502 | 适配器不可用 | Lodestar 自定 | 预留 |
| 1503 | 背压/队列满 | Lodestar 自定 | M1.2 主动生成（outbox） |
| 1504 | Lodestar 限流/配额 | Lodestar 自定 | M1.2 主动生成（SendGuard） |
| 1505 | 版本不兼容 | Lodestar 自定 | 预留 |
| 1506 | 适配器鉴权失败 | Lodestar 自定 | 预留 |
| 1507 | 消息记录不存在 | Lodestar 自定 | 预留 |
| 1508 | 发送被 STOP 禁用 | Lodestar 自定 | 主动生成（SendGuard） |

**动作不存在使用 `1404`**，不使用 `103`。CQHTTP 3.4 的 `103` 不用于 Lodestar。

`1401/1403` 在 CQHTTP 中通常不会出现在动作响应里：握手鉴权失败会直接断开连接。Lodestar 在连接层用 `auth_failed` 表达 401/403，不把鉴权失败当作动作 retcode。

出处与日期（均为 commit permalink）：

- OneBot v11：[api/README.md](https://github.com/botuniverse/onebot-11/blob/d4456ee706f9ada9c2dfde56a2bcfc69752600e4/api/README.md)，提交 `d4456ee`，2022-08-12。
- CQHTTP 3.4：[docs/3.4/API.md](https://github.com/kyubotics/coolq-http-api/blob/30bfedec692cd1c383ad7561af80c4744343861f/docs/3.4/API.md)，提交 `30bfede`，2018-01-20。
- CQHTTP 3.2 WebSocket：[docs/3.2/WebSocketAPI.md](https://github.com/kyubotics/coolq-http-api/blob/30bfedec692cd1c383ad7561af80c4744343861f/docs/3.2/WebSocketAPI.md)，提交 `30bfede`，2017-11-15。
- 说明：`kyubotics/coolq-http-api` 是上游仓库 `richardchien/coolq-http-api` 迁移/改名后的地址（GitHub API 返回 `full_name: kyubotics/coolq-http-api`，archived，最后 push 2020-08-02），不是第三方镜像。

## `status: failed` 的行为

- 动作级失败：写回当前 WebSocket，不改变连接状态、不触发重连、不计入断线指标。
- 只有传输层 close/error、心跳 pong 超时、鉴权/握手确定性失败才改变连接状态。
- 上游 adapter 返回的 retcode 原样透传；Core 不把上游错误改写成自己的码。

## AstrBot 侧证据

AstrBot master 提交 `68acac9b1ab92c2ac4cfd811c0898913a1391c8`（2026-11-10）：

- `aiocqhttp` 的 `_handle_api_result` 在 `status == "failed"` 时抛出 `ActionFailed`，不自动重试；`ResultStore.fetch` 只等待相同 `echo.seq` 的响应，超时才抛 `NetworkError`。
- AstrBot 的 [respond/stage.py](https://github.com/AstrBotDevs/AstrBot/blob/68acac9b1ab92c2ac4cfd811c0898913a1391c8/astrbot/core/pipeline/respond/stage.py) 在 `event.send()` 外层捕获 `Exception`，执行 `logger.error("Failed to send the message chain...", exc_info=True)` 后继续；没有重试，也没有关闭/重建 WebSocket 的代码。
- [aiocqhttp_platform_adapter.py](https://github.com/AstrBotDevs/AstrBot/blob/68acac9b1ab92c2ac4cfd811c0898913a1391c8/astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py) 在 `get_msg` / `get_group_file_url` 等路径捕获 `ActionFailed`，记 error 并忽略该消息段。
- 结论：`status=failed` 会为每次失败发送记一条 error + traceback（日志量与动作频率成正比，不会自我放大），但**不会重试、不会改变连接状态、不会造成重连风暴**。

## 后果

- README 维护这张表；新增码必须有出处或明确标为 Lodestar 自定。
- 测试断言：未注册动作返回 1404，且连接保持 `open`。
- 若 AstrBot 改变错误处理、或上游 adapter 强制要求 103，需重新审议。

## 重新审议触发条件

1. AstrBot 对 `status=failed` 引入自动重试或连接重置。
2. OneBot v12/Satori 等新协议定义了稳定数值表。
3. 上游 adapter 的 retcode 语义与 Lodestar 表冲突且无法透传解决。
