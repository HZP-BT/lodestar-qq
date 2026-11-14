# Web 控制面板（S1-b 产品外壳）

> 定位：把现有的 Core/SendGuard 能力可视化，不新增收发/媒体功能，不改 QQ/loader。
> 面板只监听 `127.0.0.1`，使用本地 token；不做公网部署、多用户登录、移动端适配。

## 1. 边界

- **只读 + 受控写**：状态、审计、指标、SendGuard 配置、STOP/resume/reset。
- **不提供发送框**：所有发送仍只走 OneBot/AstrBot → Core → SendGuard → adapter 链路，
  避免面板成为绕过 SendGuard 的旁路。
- **本地**：默认 `http://127.0.0.1:18081`；非 loopback host 会被 AdminServer 拒绝。
- **认证**：所有 `/api/*` 需要 `Authorization: Bearer <token>` 或 `X-Admin-Token`。
  token 优先来自 `LODESTAR_ADMIN_TOKEN`；external 一键脚本生成后保存在
  `config/upstream.json` 的 `admin.token`，demo 保存在 `data/demo/admin-token`，
  启动窗口都会打印。
- **审计脱敏**：`/api/audit` 只返回目标哈希、动作、决策、原因、长度、内容哈希、
  retcode、时间；不返回正文、明文 UID/群号或账号 ID。

## 2. 启动

```bash
pnpm install
pnpm build
LODESTAR_ADMIN_TOKEN=replace-with-a-local-random-token node scripts/upstream.mjs
```

Windows PowerShell：

```powershell
$env:LODESTAR_ADMIN_TOKEN = "replace-with-a-local-random-token"
node scripts\upstream.mjs
```

打开 `http://127.0.0.1:18081`，在面板输入同一个 token。

### mock 一键体验

```bash
pnpm install
pnpm demo
```

不需要 QQ、patcher 或 OneBot 上游。脚本会启动 MockAdapter、内置 mock AstrBot 和面板，
并在终端打印 `Panel` 与持久化 token；源码 demo 的 token 写入 `data/demo/admin-token`。
默认端口为 `18080/18081/18090`，mock AstrBot 为 `6199`；端口被占用时会自动顺延。
Docker 用户可用 `docker compose up -d`，查看 `docker compose logs polaris-core` 获取同一组
地址和 token（容器内 token 在 `/app/data/admin-token`）。

`config/upstream.json` 可选：

```json
{
  "admin": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 18081,
    "configPath": "config/send-guard.json",
    "webRoot": "packages/web/dist"
  }
}
```

`config/send-guard.json` 是面板 PUT 的热加载文件（gitignored）。模板见
`config/send-guard.example.json`。未生成时使用 Core 启动参数/默认值。

## 3. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | loader 进程/登录/数据面、OneBot 连接态、探针、账号哈希、pending/replayable |
| GET | `/api/protocol` | Panel/OneBot 上游/AstrBot 反向 WS 地址与端口；token 只返回是否已配置 |
| PUT | `/api/protocol` | 保存 Panel 端口、OneBot 端口/token、AstrBot URL/token；返回 `restartRequired` |
| POST | `/api/protocol/test` | 用 ws/wss 测试 AstrBot/上游连接；不返回 token |
| POST | `/api/restart` | 平滑重启 Core 的 adapter/反向 WS/探针；admin 面板保持在线 |
| PUT | `/api/admin/password` | body `{"newPassword":"...","confirm":"CHANGE"}`；更新管理密码并持久化 |
| POST | `/api/shutdown` | body `{"confirm":"TERMINATE"}`；响应后终止当前 Core 进程 |
| GET | `/api/sendguard` | 熔断状态、配额用量/上限、白名单、静默时段、当前配置 |
| POST | `/api/sendguard/stop` | body `{"confirm":"STOP"}`；写 `data/STOP`，下一次发送 1508 |
| POST | `/api/sendguard/resume` | body `{"confirm":"RESUME"}`；删除 STOP |
| POST | `/api/sendguard/reset` | body `{"confirm":"RESET"}`；人工 reset 熔断 |
| PUT | `/api/sendguard/config` | 改配额/速率/间隔/静默/白名单；写 `config/send-guard.json` 并热加载 |
| GET | `/api/audit?limit=&offset=&decision=&action=` | 分页审计元数据；目标/账号哈希 |
| GET | `/api/admin-audit` | 最近管理写操作审计（谁/何时/改了什么，不含正文） |
| GET | `/api/metrics` | Prometheus 文本，与 `/metrics` 同源 |

写操作（stop/resume/reset/config）会写 `admin_audit`；`details` 只含动作/字段/配置摘要，
不写 token、不写消息正文。

## 4. 前端

`packages/web/`，零框架（原生 TypeScript + DOM），构建产物 `dist/` 由 AdminServer 静态服务：

- **总览**：醒目显示“后端核心服务未连接/登录成功/发送熔断已开启”，不再展示
  `ECONNREFUSED` 等底层连接错误；异常时提供“尝试重启核心服务”按钮与 loading 反馈；
  loader / OneBot / 探针 / 熔断状态灯；今日配额进度；白名单摘要；
- **协议端配置**：Panel HTTP 端口、OneBot 上游 WS 端口/token、AstrBot 反向 WS 地址/token；
  “测试 AstrBot 连接”；保存后自动调用 `/api/restart`，用带进度条的模态框展示平滑重连，
  面板保持可用；Panel 端口变更仍需手动重启整个进程；
- **SendGuard**：配额、群/私聊白名单、@ 触发、静默时段、重复窗口、失败阈值、审计保留；
  急停/恢复/reset 统一收纳在页面底部“危险操作”区；
- **审计**：默认每 2s 自动刷新（可关闭）、按决策/动作筛选、上一页/下一页分页；
  列只有元数据；
- **指标**：带 Y 轴刻度/网格线、X 轴时间标尺的 allowed/denied 趋势图；鼠标悬停显示
  对应时间点的具体数值；
- **初始化向导**：首次进入/手动点击“引导”弹出三步（本地配置、账号登录、连接大脑），
  账号登录步骤只检测状态，不代替用户启动 QQ。首次登录不再自动弹出阻塞式向导，
  总览会显示可关闭的引导入口。
- **系统**：修改本地管理密码；危险区可终止当前 Core 进程，需要输入 `TERMINATE`。
- **主题**：右上角提供深色/浅色切换，选择保存在本机。
- **演示模式**：mock demo 的顶栏和总览显示“演示模式（Mock）”，并说明状态来自内置
  mock 后端，避免把模拟的登录态/连接态当成真实 QQ/AstrBot。

右上角只显示连接状态图标（未连接/登录成功/服务异常），不再有全局红色急停按钮。
所有危险操作使用“输入 STOP/RESUME/RESET”的二次确认弹窗。轮询刷新只更新数据，
不会重新播放页面入场动画。

## 5. 安全限制

- 面板不是公网后台；不要用反向代理把 `18081` 暴露到公网。
- 容器 demo 通过 `LODESTAR_ADMIN_ALLOW_NON_LOOPBACK=1` 在容器内绑定 `0.0.0.0`；
  Compose 必须只发布到宿主机 `127.0.0.1`，不要改成公网监听。
- 不要关闭 token 或把 token 写进前端源码；前端 token 只保存在 `sessionStorage`。
  源码 mock demo 的持久化 token 在 `data/demo/admin-token`（已 gitignore），不要提交或公开。
- 不把 `config/send-guard.json` 提交到仓库；已在 `.gitignore`。
- 面板不做“发一条消息”的输入；不要添加绕过 SendGuard 的发送入口。
- 写操作审计不存正文；如果未来需要更细的管理员身份，另做多用户设计，不在本阶段。

## 6. 验证

- `pnpm verify` 覆盖 lint/format/typecheck/test/build；
- `packages/core/tests/admin-server.test.ts` 覆盖 token、状态脱敏、配置持久化、
  STOP/resume/reset、审计分页/脱敏、指标、平滑重启；
- `pnpm --filter @lodestar/web build` 生成 `packages/web/dist`，由 `scripts/upstream.mjs`
  的 AdminServer 提供。

## 7. 未做

公网部署、多用户/RBAC、移动端适配、面板内发送、媒体预览、WebSocket 实时推送
（当前总览/指标 5s 轮询，审计 2s 轮询）。这些不影响“本地管控与观测”的最小产品壳。
