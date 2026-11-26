# ADR 0008：移除独立探针，运行状态改由连接与登录态推导

- 状态：Accepted
- 日期：2026-11-26
- 决策者：项目所有者、维护者
- 取代：ADR 0004 中的 `healthState` 五态与探针部分、ADR 0007 中的探针熔断条款

## 背景

Lodestar 的目标是替代 NapCat / SnowLuma 这类 QQ 端 OneBot 后端：附着真实 NTQQ，
把 OneBot v11 接口交给 AstrBot。早期设计把“独立探针”当成差异化能力：Core 每 15s
主动调用 `get_login_info`，结合入站 cursor 停滞时间推导
`ONLINE/IDLE/DEGRADED/OFFLINE`，并由独立 worker Watchdog 在事件循环阻塞时 SIGKILL
进程。

项目所有者确认这不是项目想要的形态：探针与“工程化保活”叙事偏离了“把 AstrBot 接上”
的初衷，也带来多余的定时动作流量和状态复杂度。

## 决策

1. 删除 `Probe`（动作探针、入站停滞判定、五态状态机）与 `Watchdog`。
2. 运行状态只剩三态，且全部是推导值，没有独立判定来源：
   - `OFFLINE`：OneBot 反向 WS 未连接；
   - `UNKNOWN`：已连接，但适配器尚未确认登录（或 `health()` 读取失败）；
   - `ONLINE`：已连接且适配器上报 `LOGGED_IN`。
3. Core 每 5s 读取一次 `adapter.health()`，只为刷新 `loginState`，不发送任何动作。
4. heartbeat：`online = good = (连接打开 && loginState === LOGGED_IN)`；
   移除 `healthProvider`。
5. `/readyz` 仅在 conn=open、login=`LOGGED_IN` 且 health=`ONLINE` 时返回 200；
   `/healthz` 仍然只表示进程存活。
6. 指标 `polaris_health_state` 保留名字（兼容已有仪表盘），取值收敛为
   `UNKNOWN | ONLINE | OFFLINE`。
7. SendGuard 移除 `probe_unhealthy` 拦截与探针熔断；熔断只由连续发送失败和显式
   安全信号打开，`data/STOP` 哨兵与配额/频控不变。

## 影响

- 不再主动检出“进程活着但数据面已死”；这类故障只能通过断线、发送失败或
  AstrBot 侧行为暴露。这是有意的取舍：用更少的活动部件换取更简单的行为。
- 适配器仍可上报 `dataPlane`、`inboundCursor` 等字段，Core 在面板和状态接口里
  展示它们，但不据此改变健康判定。
- 测试删除 probe/watchdog 用例；heartbeat 用例改由 `loginProvider` 驱动。
- 用户可见文档（README、安装指南）与新面板一起更新；ADR 0001–0007 作为历史记录保留。
