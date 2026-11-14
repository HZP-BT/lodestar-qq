# Lodestar v0.1.0-m1.2

发布日期：2026-11-15  
维护者：HZP-BT

Lodestar 是一个 **Apache-2.0 的 OneBot v11 运行时**，面向“附着真实 NTQQ 客户端 +
工程化保活”的场景。它把协议会话、可靠性、独立数据面探针、SendGuard 风险控制、
审计/指标和本地 Web 控制面板放在 Core 里，客户端适配器与 Core 解耦。

## 下载

- `lodestar-portable-0.1.0-m1.2-windows-x64.zip`
- SHA256：`8f57658089382a12b57d83d53224bf407b38f318cc2004e6d20f0c0f3817ab2f`
- 适用：Windows 10/11 x64；QQ `9.9.37-54395`；AstrBot

便携包自带 `node.exe`、预构建 Core/WebUI、OneBot loader 和 `ws` 依赖，
**不需要安装 Node 或 pnpm**。

## 这个版本的重点

- **自动查找 QQ 安装目录**：不再要求 QQ 必须在 `D:\qq`。安装器会检查
  `Tencent\QQNT` 注册表、QQ 卸载项、正在运行的 `QQ.exe`、常见路径和固定盘浅层扫描；
  找到多个安装时优先选择含 `9.9.37-54395` 的那一份。
- **自动查找 AstrBot**：检查正在运行的 `astrbot-desktop-tauri.exe`、卸载项和常见路径；
  找不到时才需要 `-AstrBotRoot`。
- 自动查找失败时仍可用 `-QQRoot` / `-AstrBotRoot` 显式指定；路径含空格也能正确传参。
- 只使用 `versions\9.9.37-54395` 这一份 QQ；如果机器上有更新的版本，会明确拒绝而不是
  误打补丁。
- 保留登录提示与 300 秒等待、loader `ws` 暂存、at 元素映射、SendGuard 默认值等
  m1.1 的修复。

## 新用户快速开始

1. 解压 zip 到普通目录，例如 `E:\Lodestar-Portable`；
2. 完全退出 QQ；
3. 双击 `Lodestar-Setup.cmd`，在 UAC 中允许管理员权限；
4. 等待 QQ 重新启动，**在 QQ 窗口登录测试号**；loader 需要登录后才能附着；
5. loader 监听 3001 后，Core 会启动并打开 http://127.0.0.1:18081，
   管理 token 在 setup 窗口打印（也可在 `config/upstream.json` 的 `admin.token` 查看）。

详细步骤、非默认路径、SendGuard 配置、故障排查和回滚见包内 `README.md`，或仓库的
[便携版新用户指南](https://github.com/HZP-BT/lodestar-qq/blob/main/docs/portable-quickstart.md)。

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
群白名单。面板审计可以看到每次发送的 `reason`。

## 已知限制

- 只支持冻结的 QQ `9.9.37-54395`；补丁按版本和哈希写死，QQ 升级后会拒绝执行；
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
