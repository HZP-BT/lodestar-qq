# ADR 0009：移除 SendGuard

- 状态：Accepted
- 日期：2026-11-27
- 决策者：项目所有者、维护者
- 取代：ADR 0007（风险缓释开关）；ADR 0003 中 1504/1508 的 Core 生成说明；ADR 0005 中 STOP 哨兵部分

## 背景

Lodestar 的定位是替代 NapCat / SnowLuma：附着真实 NTQQ，把 OneBot v11 交给 AstrBot。
早期版本在 Core 里建了一层 SendGuard，对 `send_*` / `upload_*` 动作做白名单、@ 触发、
日配额、最小间隔、静默时段、重复抑制、熔断和审计，默认「群白名单为空 = 拒绝所有群」，
并带有 `data/STOP` 急停哨兵。

项目所有者确认不需要这层功能：它让 Lodestar 与 NapCat 的行为不一致（AstrBot 在 NapCat
上能发的东西，在 Lodestar 上可能被静默拦截），增加理解成本和排障面，而风险控制本应由
使用方式和 AstrBot 侧配置负责。

## 决策

1. 删除 `SendGuard` 与 `SendGuardStore`；动作路由不再在调用 adapter 之前做发送检查。
2. 删除 `data/STOP` 哨兵与面板上的 STOP/RESUME/RESET、发送审计页。
3. 删除 `config/send-guard.json` 及其示例；安装脚本不再写 `sendGuard` 配置或环境变量。
4. 数据库 schema 移除 `send_quota` / `send_rate` / `send_circuit` / `send_audit` 表
   （schema 版本 4）；已有数据库中的旧表不主动删除，也不再读写。
5. 保留 `admin_audit`：面板自身的敏感操作（改密码、重启、终止、协议配置）仍只记元数据。
6. retcode 定义不变（1504/1508 保留为预留/透传码），Core 不再主动生成它们。

## 影响

- AstrBot 的动作原样转发给 loader；是否发送、发多少、发给谁，全部由 AstrBot 决定。
- 面板保留：总览、协议端配置、指标、系统、三步引导；审计页与 SendGuard 页移除。
- 风险边界变化：不再有内置限流、白名单或急停；发现异常时只能停止 Core 进程
  （面板系统页或直接结束进程），或在 AstrBot 侧停用适配器。
- 文档同步更新：README、安装指南、面板设计；ADR 0007 作为历史记录保留并标注已取代。
