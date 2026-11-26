# M1 验收子项：一条命令启动与可观测

“一条命令启动”不等到 M1 最后才验证。每个模块都留下可执行的启动/验收子项，状态随里程碑回填。

## M1.1 仓库骨架 + core 反向 WS 客户端（已完成）

- 安装/开发启动：
  - `pnpm install`
  - `pnpm --filter @lodestar/core dev`
- 验证：
  - `pnpm verify`（lint / format / typecheck / test / build）
  - mock AstrBot 冒烟：Token 头、`X-Self-ID`、`X-Client-Role`、echo 回传、未注册动作 1404。
  - `node:sqlite` runtime contract：主键/唯一索引/有符号 int32/重开持久化。
- 状态：✅ 已完成（M1.1 + A 组第一步 + B/C + Core↔mock，共 74 个测试 + 进程级冒烟）。

## M1.2 adapter-mock + B/C（已完成核心部分）

- 启动：
  - `pnpm --filter @lodestar/adapter-mock test`
  - `pnpm --filter @lodestar/adapter-mock build`
- 验收：
  - **Core 侧已完成**：`EventSink.publish`、`EventStore` schema、A1–A6、`OutboxDispatcher` 测试；
  - **`@lodestar/adapter-mock` 已完成**：MockAdapter 的 emit/freeze/freezeEvents/crash/canary/authFail/slowAction 与动作桩；HTTP 控制面已实现；
  - **Core↔mock 联调**：`CoreRuntime` 把 Adapter→EventSink→Outbox→ReverseWsClient 串起来，E2E 测试通过控制面 emit/freeze/resume 并到达 AstrBot mock。
- 状态：✅ 核心部分完成（72 个测试）。

## M1.3 probe（独立探针）——已取消

> 2026-11-26：独立探针与 Watchdog 已按 [ADR 0008](adr/0008-remove-probe.md) 移除。
> 运行状态改由 OneBot 连接和适配器上报的登录态推导，本节验收项不再适用。

## M1.4 Docker Compose + healthcheck

- 启动：
  - `docker compose up -d`
- 验收：
  - `docker compose ps` 显示 healthy（healthcheck 用 `/readyz`，不是 `/healthz`）；
  - healthcheck：`interval: 30s`、`timeout: 5s`、`start_period: 60s`、`retries: 3`；
  - `restart: unless-stopped` 只处理退出；healthcheck unhealthy 不自动重启；
  - `curl http://127.0.0.1:18080/healthz` 返回 200（进程存活；离线/鉴权失败也是 200）；
  - `curl http://127.0.0.1:18080/readyz` 仅在 AstrBot 连接且 QQ 已登录（health ONLINE）时返回 200；OFFLINE/auth_failed 返回 503；
  - 冷启动到“适配器已连接”≤60s；
  - 容器重启后 SQLite 状态可恢复。
- 状态：🚧 配置与本地 dev-mock 已验证；本环境无 Docker CLI，`docker compose up -d` 需在你的机器上执行确认。

## M1.5 Windows 启动脚本

- 启动：
  - `powershell -ExecutionPolicy Bypass -File scripts/windows/install.ps1 -SelfId ... -Token ... -GroupId ...`
  - `powershell -ExecutionPolicy Bypass -File scripts/windows/start.ps1`
  - `powershell -ExecutionPolicy Bypass -File scripts/windows/stop.ps1`
  - `powershell -ExecutionPolicy Bypass -File scripts/windows/uninstall.ps1`
- 验收：
  - 注册为 Windows 计划任务 `LodestarCore`（登录时启动，失败重启）；
  - 日志目录、数据目录、配置校验有明确输出；
  - 不要求用户手工设置一堆环境变量（`config/polaris.json` 为主，`.env.example` 仅备选）；
  - `stop.ps1` 停止任务/进程；
  - `-DevMock` 可把任务入口临时指向 `scripts/dev-mock.mjs`，`install.log` 记录 `MODE=dev-mock`；dev-mock 占用 18080/18090，与真实后端互斥；
  - `-Entrypoint <path>` 可显式覆盖入口，优先级高于 `config.entrypoint`。
- 状态：🚧 脚本与配置模板已交付；本环境不自动注册计划任务（避免改动你的系统），需你运行 `install.ps1` 验收。

## Node 版本口径

- 支持：Node 22.16+ / 24 / 26（LTS 线）；22.16 覆盖我们依赖的 22.x API 面，且比 22.13 更接近当前 22.x。
- `engines`：`^22.16.0 || ^24.0.0 || ^26.0.0`。
- CI：主矩阵 22（最新 22.x）/ 24 / 26；另有 `minimum-node` job 固定 22.16.0，跑完整 `pnpm verify`。
- M1.1 没有运行时 native addon；`node:sqlite` 为内置模块；`esbuild` 仅开发期使用。Node 26.13 下测试与构建已通过。
