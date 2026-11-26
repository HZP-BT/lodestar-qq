# Web 控制面板

> 定位：本地状态面板 + 协议配置，不提供发送入口，不新增收发/媒体功能，不改 QQ/loader。
> 面板只监听 `127.0.0.1`，使用本地 token；不做公网部署、多用户登录、移动端适配。

## 1. 边界

- **只读 + 受控写**：查看状态与指标；修改协议配置、管理密码；终止 Core。
- **不提供发送框**：所有发送仍只走 AstrBot → Core → loader；面板不是旁路。
- **本地**：默认 `http://127.0.0.1:18081`；非 loopback host 会被 AdminServer 拒绝。
- **认证**：所有 `/api/*` 需要 `Authorization: Bearer <token>` 或 `X-Admin-Token`。
  token 优先来自 `LODESTAR_ADMIN_TOKEN`；external 一键脚本生成后保存在
  `config/upstream.json` 的 `admin.token`，demo 保存在 `data/demo/admin-token`，
  启动窗口都会打印。
- **管理审计**：面板自身的敏感操作（改密码、重启、终止、协议配置）写入 `admin_audit`，
  只记元数据，不记 token 或正文。

## 2. 页面

- **总览**：连接状态、loader 状态、OneBot 连接、运行状态（ONLINE/UNKNOWN/OFFLINE）、
  账号哈希与队列长度；异常时提供“尝试重启核心服务”。
- **协议端配置**：面板端口、上游 OneBot WS 端口/token、AstrBot 反向 WS 地址/token；
  保存后平滑重启 Core 连接（面板不断线）；可测试 AstrBot 连接。
- **指标**：`/api/metrics` 的健康、就绪、OneBot 连接与队列长度，附原始指标文本。
- **系统**：轮换管理密码（持久化，旧 token 立即失效）、终止 Core 进程（输入 `TERMINATE`）。
- **三步引导**：本地配置 → 账号登录 → 连接 AstrBot。

## 3. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 脱敏状态：loader、OneBot、health、队列；账号只给哈希 |
| GET | `/api/protocol` | 当前协议配置；token 只报是否已设置 |
| PUT | `/api/protocol` | 修改端口/地址/token；写回 `config/upstream.json` |
| POST | `/api/protocol/test` | 测试 AstrBot 反向 WS 可达性 |
| POST | `/api/restart` | 平滑重启 Core 连接（runtime 支持时） |
| PUT | `/api/admin/password` | body `{"newPassword":"...","confirm":"CHANGE"}` |
| POST | `/api/shutdown` | body `{"confirm":"TERMINATE"}`，终止 Core |
| GET | `/api/metrics` | Prometheus 文本 |
| GET | `/api/admin-audit` | 最近 50 条管理操作（元数据） |

## 4. 安全

- 面板只监听 `127.0.0.1`；容器内可用 `LODESTAR_ADMIN_ALLOW_NON_LOOPBACK=1`，但宿主机必须只发布到回环。
- token 至少 12 位；修改后旧 token 立即 401。
- 不把 `config/upstream.json` 提交到仓库；已在 `.gitignore`。
- 面板不做“发一条消息”的输入；不要添加绕过 AstrBot 的发送入口。
