# Lodestar（Windows x64）安装与启动指南

> 版本：0.1.0-m1.2 · 适用：Windows 10/11 x64 · 目标 QQ：`9.9.37-54395`
>
> Lodestar 是一个 **Apache-2.0 的 OneBot v11 实现**，用来替代 NapCat、SnowLuma 这类 QQ 端
> 后端：附着真实 NTQQ 客户端，把 OneBot v11 接口交给 AstrBot。安装包自带运行所需的 Node、
> Core、WebUI 和 QQ loader，**不需要安装 Node 或 pnpm**，双击一次 `Lodestar-Setup.cmd`
> 就会完成全部安装并启动。
>
> 本项目与腾讯/QQ 无隶属或授权关系。注入/补丁路线属于第三方方案，可能触发账号风控、
> 踢下线或封禁；请只使用测试号，并自行承担风险。

## 1. 这个包适合谁

适合：

- Windows 10/11 x64；
- 已安装 QQ `9.9.37-54395`（安装器会自动查找安装目录，常见 `D:\qq`）；
- 已安装 AstrBot（安装器会自动查找安装目录，常见 `D:\AstrBot`），并启用 OneBot v11 /
  aiocqhttp 适配器；
- 想让 AstrBot 通过 Lodestar 连接真实 QQ，且本机不需要预装 Node/pnpm；
- 只做个人或小规模、低频率的合法用途。

不适合：

- 没有安装 QQ 或 AstrBot 的机器；
- 想让 Lodestar 自己提供 AI 能力（Lodestar 不是 LLM 客户端，AI 回复由 AstrBot 负责）；
- 群发营销、批量加好友、绕过验证码/风控、多账号养号；
- 不想承担 QQ 账号风险的生产环境。

## 2. 包内有什么

```text
Lodestar/
├─ Lodestar-Setup.cmd        ← 双击这个
├─ bootstrap-external.ps1    ← 安装/启动逻辑
├─ node.exe                  ← 自带的 Node.js 24
├─ lodestar-external.cjs     ← 预构建的 Core + OneBot 上游适配器
├─ web/                      ← 本地控制面板静态文件
├─ config/                   ← 配置模板；首次运行生成 upstream.json
├─ data/                     ← SQLite、审计、STOP 等运行时数据
├─ node_modules/ws/          ← loader 使用的 WebSocket 依赖
└─ spike/ntqq-loader/        ← 本机 loader 安装/补丁脚本
   ├─ install-native.ps1
   ├─ patch-qqnt.ps1
   └─ src/                   ← loader + OneBot 服务源码
```

`node.exe` 来自官方 Node.js 24，按其许可证分发；Lodestar 自有代码为 Apache-2.0。
AstrBot 和 QQ 不随包分发，需要你自行安装。

## 3. 前置条件

### 3.1 QQ

- 必须是 **9.9.37-54395**。补丁只对这个版本的 `QQNT.dll` 有效，其他版本会直接拒绝。
- 安装器会自动查找 QQ 目录：注册表 `Tencent\QQNT` 的 `Install`、卸载项
  `DisplayIcon/UninstallString`、正在运行的 `QQ.exe`、常见路径和固定盘浅层扫描。
- 默认安装目录 `D:\qq`。如果不在默认目录，自动查找失败时用 `-QQRoot` 指定（见第 8 节）。
- 关闭 QQ 的系统自动更新，避免升级后补丁失效。
- 只登录测试号；不要用主力号做首次验证。

### 3.2 AstrBot

- 安装器会自动查找 AstrBot：正在运行的 `astrbot-desktop-tauri.exe`、卸载项、常见路径和
  固定盘浅层扫描。常见路径包括 `D:\AstrBot`、`C:\Program Files\AstrBot`、
  `%LOCALAPPDATA%\Programs\AstrBot` 等。
- 自动查找失败时，用 `-AstrBotRoot` 指定（见第 8 节）。
- 在 AstrBot 中新建/启用 **OneBot v11（aiocqhttp）** 适配器：
  - 反向 WS 主机：`0.0.0.0`
  - 反向 WS 端口：`6199`
  - Token：可留空；如设置，Lodestar 会自动读取。
- AstrBot 的 `cmd_config.json` 默认在 `%USERPROFILE%\.astrbot\data\cmd_config.json`。
  安装器会读取其中的 aiocqhttp 端口和 token，不需要手动抄写。
- AstrBot 里的模型/人格/插件由你自行配置；Lodestar 不参与 LLM 调用。

### 3.3 权限

- 打 QQ 补丁和写 `D:\qq` 需要管理员权限；首次运行会弹 UAC。
- 面板和 Core 只监听 `127.0.0.1`，不要在公网暴露 `18081`。

## 4. 首次运行

1. 把 zip 解压到普通目录（不要解压到 `C:\Program Files` 或需要管理员写入的目录，
   例如 `E:\Lodestar`）。
2. 完全退出 QQ（托盘右键退出），避免文件被占用。
3. 双击 `Lodestar-Setup.cmd`。
4. 在 UAC 中允许管理员权限。
5. 脚本会：
   - 检测 QQ 版本；
   - 备份原始 `QQNT.dll` / `package.json` 到 `D:\qq\polaris-backup\<版本>-<时间>`；
   - 给 `QQNT.dll` 打 5 字节补丁（仅 9.9.37）；
   - 把 loader 安装到 `QQ\versions\<版本>\resources\app\app_launcher`；
   - 启动 AstrBot（如果未运行），等待 6199；
   - 启动 QQ。
6. **在 QQ 窗口登录测试号**。loader 需要登录后才能拿到 NTQQ 消息服务；脚本会等待
   最多 300 秒，并提示你登录。首次登录必须由人完成，无法自动跳过。
7. loader 监听 `127.0.0.1:3001` 后，脚本用包内 `node.exe` 启动 Core，打开
   `http://127.0.0.1:18081`，并在窗口里打印管理 token。
8. 用该 token 登录面板。

之后再次双击 `Lodestar-Setup.cmd` 就是纯启动：不再打补丁、不再询问，QQ 记住账号后
直接进入可用状态。

首次运行会生成：

```text
config/upstream.json      # 地址、QQ 号、管理 token
config/send-guard.json    # SendGuard 配置（首次保存后出现）
data/polaris.db           # 配额、熔断、审计
```

管理 token 也保存在 `config/upstream.json` 的 `admin.token`。如果窗口关掉了，
可以打开这个文件查看；不要把该文件提交或发到公开渠道。

## 5. 面板

打开 `http://127.0.0.1:18081`，输入管理 token。面板包含：

- **总览**：loader/OneBot/运行状态/熔断状态、今日配额、白名单摘要；
- **协议端配置**：面板端口、上游 WS、AstrBot 反向 WS 地址/token；保存后平滑重启 Core；
- **SendGuard**：群/私聊白名单、@ 触发、静默时段、配额、频控、急停/恢复/reset；
- **审计**：发送决策、原因、目标/账号哈希、retcode；不返回正文或明文 UID；
- **指标**：allowed/denied 趋势；
- **系统**：修改管理密码、终止 Core 进程；
- **主题**：右上角切换深色/浅色，选择保存在本机。

面板不提供“发消息”输入框，发送仍然只走 AstrBot → Core → SendGuard → loader。

## 6. SendGuard 默认值与常用配置

首次生成的配置：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `groupWhitelist` | 空 | **空 = 拒绝所有群**；测试群必须显式加入 |
| `privateEnabled` | 开启 | 私聊总开关 |
| `privateWhitelist` | 空 | **空 = 允许所有私聊**；填写后只允许列表中的 QQ |
| `atOnly` | 关闭 | 开启后只允许带 `at` 的群发送；当前实现按出站消息判断 |
| `quietHours` | 关闭 | 可在面板开启静默时段 |
| 日配额 / 群配额 | 200 / 80 | 按账号/群/天 |
| 同群最小间隔 | 2000 ms | 防止高频 |
| 重复窗口 | 60000 ms | 同目标同内容抑制 |
| 失败阈值 | 3 | 连续失败打开熔断，只允许人工 reset |

### 6.1 让私聊工作

- 打开“允许私聊发送”；
- 白名单留空 = 所有私聊都允许；填入 QQ 号 = 只允许这些 QQ；
- 关闭总开关 = 拒绝所有私聊。

### 6.2 让群回复工作

1. 在 SendGuard 的“群白名单”里加入测试群号（逗号分隔）；
2. 在群里 **@ 测试号**，或使用 AstrBot 的唤醒前缀（默认 `/`）；
3. 如果 `atOnly` 开启，出站消息必须包含 `at` 段；AstrBot 的普通群回复通常不含，
   因此建议保持关闭，或把 `atOnly` 作为额外约束使用；
4. 如果群里没有 @ 也没有 `/`，AstrBot 不会生成回复，SendGuard 也不会收到发送动作。

### 6.3 急停

- 面板 SendGuard → 危险操作 → 输入 `STOP`：立即写 `data/STOP`，下一次发送返回 1508；
- 输入 `RESUME` 恢复；`RESET` 清除熔断；
- 也可以直接退出 Core；下次启动前检查 `data/STOP` 是否存在。

## 7. 常见问题

### 7.1 QQ 提示“文件已经损坏，请重新安装 QQ”

- 不要直接双击未打补丁的 QQ。`Lodestar-Setup.cmd` 会先打补丁再启动 QQ；
- 补丁后 `QQNT.dll` 应为 `BF8C1AA8…`，`resources\app\app_launcher` 应存在；
- 如果 setup 失败又想恢复原版 QQ，见第 9 节回滚。

### 7.2 卡在“等待 loader 监听 3001”

- 确认 QQ 已登录测试号。loader 需要登录后的 NTQQ 消息服务；
- 查看最新的 `D:\qq-loader\self-loader-*.jsonl`：
  - `attach_wait_service` 表示还在等登录；
  - `attached` / `onebot_started` 表示已成功；
  - `onebot_error` 会给出具体缺模块/异常；
- 完全退出 QQ，重新运行 `Lodestar-Setup.cmd`，在这次弹出的 QQ 窗口里马上登录；
- 脚本会等待 300 秒；如果仍失败，把 `self-loader-*.jsonl` 和
  `D:\qq-loader\install.log` 一起保留。

### 7.3 AstrBot 报 `ApiNotAvailable`

这是 AstrBot 侧反向 WS 的 API 客户端不可用，不是 SendGuard 白名单。常见于
Core/AstrBot 重启顺序不对或旧连接未清理。按这个顺序恢复：

1. 面板系统 → 终止 Core（或关闭 Core 窗口）；
2. 完全退出 AstrBot（包括后台 Python 进程）；
3. 启动 AstrBot，等待 6199；
4. 重新运行 `Lodestar-Setup.cmd`（或启动 Core）。

不要在 Core 已连接时重启 AstrBot，否则可能留下旧 bot 对象。

### 7.4 群消息没有回复

- 群是否在 `groupWhitelist`；
- 是否 @ 了测试号或使用了 `/` 唤醒前缀；
- `atOnly` 是否开启（出站消息无 at 会被拦）；
- 面板审计里看最新一条群发送的 `reason`（`whitelist` / `not_at` / `quota`）。

### 7.5 面板打不开 / 端口被占用

- 18080/18081 只能有一个 Core；
- 关闭之前启动的 Core/演示，或重启机器；
- 面板只监听 `127.0.0.1`，不要用公网 IP 访问。

### 7.6 管理 token 丢了

- 打开 `config/upstream.json` 的 `admin.token`；
- 或者在面板系统页修改密码（需要先登录）；
- 删除 `config/upstream.json` 会生成新 token，但也会丢失旧配置。

## 8. 非默认路径

安装器会自动查找 QQ 和 AstrBot，通常不需要手动指定。如果自动查找失败，或者机器上有多份
安装，用 PowerShell 显式指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\bootstrap-external.ps1 `
  -QQRoot "E:\Tencent\QQ" `
  -AstrBotRoot "E:\AstrBot"
```

`Lodestar-Setup.cmd` 是不带参数、自动查找路径的快捷入口；自动查找失败时再保存上面这条
命令。

## 9. 升级、回滚与卸载

### 9.1 升级 Lodestar

- 保留 `config/` 和 `data/`，用新版安装包覆盖程序文件；
- 关闭 Core/AstrBot 后再替换；
- 新版如果改变配置 schema，会按默认值补齐/拒绝未知字段。

### 9.2 回滚 QQ

安装脚本每次都会备份到：

```text
D:\qq\polaris-backup\<版本>-<时间>\
  QQNT.dll
  package.json
```

回滚：

1. 完全退出 QQ；
2. 把备份的 `QQNT.dll` 和 `package.json` 复制回
   `D:\qq\versions\<版本>\resources\app\` 与 `QQ\versions\<版本>\`；
3. 删除 `resources\app\app_launcher`；
4. 删除 `D:\qq-loader`；
5. 启动 QQ。

如果备份目录也丢了，请使用 QQ 官方安装/修复程序恢复原版 `QQNT.dll` 和
`package.json`；不要手动伪造 `package.json`，否则会触发完整性校验并提示文件损坏。

### 9.3 卸载 Lodestar

- 面板系统 → 终止 Core，或关闭 Core 窗口；
- 完全退出 AstrBot 和 QQ；
- 按 9.2 回滚 QQ；
- 删除 `D:\qq-loader`；
- 删除安装目录（会同时删除 `data/` 和本地 `config/`）；
- AstrBot 的数据/配置不动，按 AstrBot 自己的方式卸载。

## 10. 安全与合规

- 面板只监听 `127.0.0.1`，使用本地 token；不要做公网反向代理；
- 不要把 `config/upstream.json`、`data/`、`D:\qq-loader` 或本指南中的 token 发到公开渠道；
- loader/patcher 会修改 QQ 客户端文件，属于第三方方案，与腾讯/QQ 无隶属或授权关系；
- 只使用测试号；不要批量注册、群发营销、加好友引流、绕过验证码/安全验证/风控；
- 账号被风控、踢下线或封禁的风险由使用者自担；
- Lodestar 自有代码 Apache-2.0；`node.exe` 按 Node.js 许可证分发；AstrBot/QQ 不随包分发。

## 11. 文件与端口

| 项目 | 默认 |
| --- | --- |
| 面板 | `http://127.0.0.1:18081` |
| 健康检查 | `http://127.0.0.1:18080/healthz` |
| 就绪检查 | `http://127.0.0.1:18080/readyz` |
| loader OneBot WS | `ws://127.0.0.1:3001/` |
| AstrBot 反向 WS | `ws://127.0.0.1:6199/ws` |
| 管理 token | `config/upstream.json` → `admin.token` |
| 运行数据 | `data/polaris.db`、`data/STOP` |
| loader 日志 | `D:\qq-loader\self-loader-*.jsonl` |
| 安装日志 | `D:\qq-loader\install.log` |

## 12. 版本与支持

- 当前版本：`0.1.0-m1.2`
- 目标 QQ：`9.9.37-54395`（补丁只对这个版本有效）
- 问题反馈请附：`install.log`、最新的 `self-loader-*.jsonl`、AstrBot 报错时间和
  面板审计中的 reason；不要附带账号密码、token 或消息正文。
