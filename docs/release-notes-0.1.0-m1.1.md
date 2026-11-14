# Lodestar v0.1.0-m1.1

发布日期：2026-11-15  
维护者：HZP-BT

Lodestar 是一个 **Apache-2.0 的 OneBot v11 运行时**，面向“附着真实 NTQQ 客户端 +
工程化保活”的场景。它把协议会话、可靠性、独立数据面探针、SendGuard 风险控制、
审计/指标和本地 Web 控制面板放在 Core 里，客户端适配器与 Core 解耦。

## 下载

- `lodestar-portable-0.1.0-m1.1-windows-x64.zip`
- SHA256：`086a90d24cbc664e43fd4f7ceb7cef0cf9bcb72aae0f84b118b56b6d9ad42005`
- 适用：Windows 10/11 x64；QQ `9.9.37-54395`；AstrBot（默认 `D:\AstrBot`）

便携包自带 `node.exe`、预构建 Core/WebUI、OneBot loader 和 `ws` 依赖，
**不需要安装 Node 或 pnpm**。

## 新用户快速开始

1. 解压 zip 到普通目录，例如 `E:\Lodestar-Portable`；
2. 完全退出 QQ；
3. 双击 `Lodestar-Setup.cmd`，在 UAC 中允许管理员权限；
4. 等待 QQ 重新启动，**在 QQ 窗口登录测试号**；loader 需要登录后才能附着；
5. loader 监听 3001 后，Core 会启动并打开 http://127.0.0.1:18081，
   管理 token 在 setup 窗口打印（也可在 `config/upstream.json` 的 `admin.token` 查看）。

详细步骤、非默认路径、SendGuard 配置、故障排查和回滚见包内 `README.md`，或仓库的
[便携版新用户指南](https://github.com/HZP-BT/lodestar-qq/blob/main/docs/portable-quickstart.md)。

## 这个版本包含

- **便携 external 包**：bundled Node、Core、WebUI、loader、ws/image-size；
- **一键安装**：自动读取 AstrBot aiocqhttp 配置、识别测试号、UAC 打 9.9.37 补丁、
  安装 loader、启动 QQ，并等待登录后启动 Core；
- **SendGuard 默认值**：私聊开启（白名单空=允许所有私聊）、静默时段关闭、
  atOnly 关闭；群白名单空=拒绝所有群；
- **控制面板**：总览、协议端配置、SendGuard、审计、指标、系统页；
  管理密码轮换、终止 Core、深色/浅色主题；
- **loader**：文本/图片/语音、缓存媒体回发、原生 QQ `at` 元素映射、
  `get_group_member_info` / `get_stranger_info` / `get_group_info`；
- **可观测性**：独立探针、DEGRADED/OFFLINE 熔断、审计只记元数据、Prometheus 指标；
- **发布工程**：便携包构建脚本、手动 Portable package workflow、
  新用户指南与回滚说明。

## SendGuard 默认配置

| 配置 | 默认 |
| --- | --- |
| 群白名单 | 空（拒绝所有群；测试群需手动加入） |
| 私聊开关 | 开启 |
| 私聊白名单 | 空（允许所有私聊；填写后仅允许列表） |
| atOnly | 关闭 |
| 静默时段 | 关闭 |
| 日配额 / 群配额 | 200 / 80 |
| 同群最小间隔 | 2000 ms |
| 重复抑制窗口 | 60000 ms |
| 连续失败阈值 | 3（打开熔断，人工 reset） |

群回复需要在群里 **@ 测试号** 或使用 AstrBot 的唤醒前缀（默认 `/`），并把群号加入
群白名单。面板审计可以看到每次发送的 `reason`（`whitelist` / `not_at` / `quota` 等）。

## 已知限制

- 只支持冻结的 QQ `9.9.37-54395`；补丁是按版本和哈希写死的，QQ 升级后会拒绝执行；
- 只验证了 Windows x64、单账号、测试号、本地回环；
- AstrBot 的反向 WS API 客户端存在重启顺序问题：Core/AstrBot 重启时如果旧连接未清理，
  可能出现 `ApiNotAvailable`；按“停 Core → 停 AstrBot → 启动 AstrBot → 启动 Core”
  的顺序恢复；
- 群回复依赖 AstrBot 的唤醒/@ 逻辑；Lodestar 只负责 OneBot 运行时和发送风控；
- 语音转写需要 AstrBot 侧配置 STT/ffmpeg，Lodestar 只转发本地文件。

## 安全与合规

- 面板只监听 `127.0.0.1`，使用本地 token；不要做公网反向代理；
- 注入/补丁是第三方方案，与腾讯/QQ 无隶属或授权关系；账号被风控、踢下线或封禁的
  风险由使用者自担；
- 只使用测试号；不要批量注册、群发营销、加好友引流、绕过验证码/安全验证/风控；
- 不要公开 `config/upstream.json`、`data/`、`D:\qq-loader` 或管理 token；
- 升级/回滚前先备份 `D:\qq\polaris-backup`；安装器每次会写入该目录。

## 许可证

- Lodestar 自有代码：Apache-2.0；
- 便携包内的 `node.exe`：Node.js 许可证（见包内 `NODE-LICENSE.txt`）；
- AstrBot、QQ 不随包分发，分别遵循其自身许可证/用户协议。

## 反馈

请附：`D:\qq-loader\install.log`、最新的 `D:\qq-loader\self-loader-*.jsonl`、AstrBot
报错时间和面板审计 reason。不要附带账号密码、token 或消息正文。
