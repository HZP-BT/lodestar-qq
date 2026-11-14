# ADR 0006：SQLite 存储引擎选型

- 状态：Accepted（修订）
- 日期：2026-11-11
- 决策者：项目所有者、维护者

## 背景

事件契约依赖 SQLite：`event_outbox`、`event_dedup`、`message_ref`、配置/审计等。需要在：

- `node:sqlite`：Node 内置，零 native 依赖；API 仍标注 experimental/RC。
- `better-sqlite3`：成熟、快；native addon，但 v13 使用 N-API 并随 npm 包附带平台预编译产物。

之间选择，并明确 CI 如何验证。

## 证据（2026-11-11，本机 Node 26.13.0 / win-x64）

### node:sqlite

- `require('node:sqlite')` 直接可用；`process.versions.modules = 147`；建表/插入/查询通过。
- [Node 26 文档](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/doc/api/sqlite.md)（commit `18b32a3`，2026-10-23）：`node:sqlite` **Stability 1.2 - Release candidate**（v25.7.0 起）；Added in v22.5.0；v23.4.0 / v22.13.0 起不再需要 `--experimental-sqlite`。
- [Node 22 文档](https://github.com/nodejs/node/blob/9774069718d9f80578079d252dddf37ae6fd550d/doc/api/sqlite.md)（commit `9774069`，2025-05-19）：**Stability 1.1 - Active development**；同样在 v22.13.0 起去 flag。
- 我们实际使用的 API 子集：

| API | Added in | 备注 |
| --- | --- | --- |
| `DatabaseSync` | v22.5.0 | Node 26 中 `Database` 是正式名；driver 优先 `Database`，回退 `DatabaseSync` 以兼容 22.16/24 |
| `database.exec` | v22.5.0 | 建表/PRAGMA/事务 |
| `database.prepare` | v22.5.0 | |
| `statement.run/get/all` | v22.5.0 | |
| `database.close` | v22.5.0 | |

- **不使用**：`timeout` 选项（v24.0.0 / v22.16.0）、path 支持 Buffer/URL（v23.10.0 / v22.15.0）、backup/session/aggregate 等较新 API。因此 22.13 技术上可用；但为了避免 22.x 内部漂移，仍把下限抬到 22.16（见下）。

### `Database` 与 `DatabaseSync`

- Node 26.13.0 文档明确：`DatabaseSync` 是 `Database` 的 **deprecated alias**，保留用于向后兼容，见 [DEP0210](https://github.com/nodejs/node/blob/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/doc/api/sqlite.md#L145)（commit `18b32a3`，2026-10-23）。
- Node 22.16.0 / 24.0.0 文档只有 `DatabaseSync`（`new DatabaseSync`），没有 `Database` 正式类名。
- 迁移路径：跨版本 driver 用 `Database ?? DatabaseSync` 选择构造器；Node 26 用 `Database`，22.16/24 用 `DatabaseSync`。影响面仅是构造器命名，同步 API/事务/语句语义不变。
- 当前 `detectNodeSqlite()` 已优先 `Database`，回退 `DatabaseSync`；storage runtime test 为兼容 22.16/24 仍用 `DatabaseSync`。

运行时实证（2026-11-12，Node 26.13.0 / win-x64）：

```text
$ node -p "typeof require('node:sqlite').Database"
function
$ node -p "typeof require('node:sqlite').DatabaseSync"
function
$ node --pending-deprecation -e "const D=require('node:sqlite').Database; new D(':memory:').close()"
Database ok
$ node --pending-deprecation -e "const D=require('node:sqlite').DatabaseSync; new D(':memory:').close()"
DatabaseSync ok
```

文档/C DEP0210 标记 `DatabaseSync` 为 deprecated alias，但当前 26.13.0 运行期在 `--pending-deprecation` 下并未打印 DEP0120/DEP0210；我们仍按文档优先 `Database`，不依赖警告是否出现。

### 运行期可用性

`node:sqlite` 受 Node 编译开关影响：部分发行版/第三方 Node 包可能未编入 SQLite，直接 `require('node:sqlite')` 会抛 `ERR_UNKNOWN_BUILTIN_MODULE`。因此：

- `detectNodeSqlite()` 启动期 feature detect：返回 `available`、`nodeVersion`、`abi`、`execPath`、`error`、`recommendation`；失败时输出“使用官方 Node/官方 Docker 镜像，或切 better-sqlite3 driver”，不把原始内置模块错误丢给用户。
- `main.ts` 启动时调用并记录诊断。
- README 安装章节明确：官方安装包/官方 Docker 镜像可用；发行版包管理器安装的 Node 不保证。
- CI 增加显式探测步骤（见下）。

### better-sqlite3

- `npm view better-sqlite3 dist-tags`：`latest = 13.0.3`；versions 包含 `12.5.0`、`12.6.x`、`13.0.x`。**截至 2026-11-11，13.0.3 是 latest，12.5.0 是更早版本。**
- `npm view better-sqlite3@13.0.3 engines`：`{ node: ">=22" }`；`npm view better-sqlite3@12.5.0 engines`：`20.x || 22.x || 23.x || 24.x || 25.x`。**没有 `>=14.21.1` 这个值**；该信息与当前 registry 不一致。
- `npm pack better-sqlite3@13.0.3` 后 `tar -tzf` 确认包内确实有：
  `package/prebuilds/{darwin-arm64,darwin-x64,linux-arm64,linux-x64,linuxmusl-arm64,linuxmusl-x64,win32-arm64,win32-x64}.node`。
- 本机 Node 26.13.0（win-x64）`npm install better-sqlite3@13.0.3` 后直接可用，建表/插入/查询通过；无需 node-gyp 编译。
- 因此“包内自带 prebuilds/*.node”的 CI 断言对 **13.0.3** 成立；必须 pin 版本，升级时重新验证。若未来版本改为 prebuild-install/ABI 拉取，断言需同步改。

### 原始命令输出（2026-11-10T18:23:08Z，本机 Node 26.13.0 / win-x64）

完整 198 行输出归档：[docs/evidence/better-sqlite3-2026-11-11.txt](evidence/better-sqlite3-2026-11-11.txt)。以下为关键片段：

```text
$ npm view better-sqlite3 dist-tags --json
{
  "latest": "13.0.3"
}

$ npm view better-sqlite3 versions --json | tail -25
  "11.8.1", "11.9.0", "11.9.1", "11.10.0",
  "12.0.0", "12.1.0", "12.1.1", "12.2.0", "12.3.0",
  "12.4.1", "12.4.5", "12.4.6", "12.5.0", "12.6.0",
  "12.6.2", "12.8.0", "12.9.0", "12.10.0", "12.10.1",
  "12.11.1", "13.0.0", "13.0.1", "13.0.2", "13.0.3"

$ npm view better-sqlite3@13.0.3 engines scripts --json
{
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "mocha --exit --slow=75 --timeout=5000",
    "clean": "rm -rf node_modules build prebuilds",
    "download": "bash ./deps/download.sh",
    "benchmark": "node benchmark",
    "build-debug": "node-gyp clean && node-gyp rebuild --debug --force_build=1",
    "build-release": "node-gyp clean && node-gyp rebuild --release --force_build=1"
  }
}

$ tar -tzf better-sqlite3-13.0.3.tgz | grep '^package/prebuilds/' | sort
package/prebuilds/darwin-arm64.node
package/prebuilds/darwin-x64.node
package/prebuilds/linux-arm64.node
package/prebuilds/linux-x64.node
package/prebuilds/linuxmusl-arm64.node
package/prebuilds/linuxmusl-x64.node
package/prebuilds/win32-arm64.node
package/prebuilds/win32-x64.node
```

### 本机粗测（不是生产基准）

环境：Node 26.13.0、win-x64、内存数据库、10,000 行、3 次运行。

| 引擎 | 写入 10k（ms） | 按主键读 10k（ms） |
| --- | --- | --- |
| `node:sqlite` | 5 / 6 / 7 | 9 / 9 / 9 |
| `better-sqlite3@13.0.3` | 10 / 10 / 10 | 7 / 7 / 7 |

结论：两者都在毫秒级；单账号百/千级日消息量下 `node:sqlite` 足够。写入 `node:sqlite` 略快，读取 `better-sqlite3` 略快；差异不影响当前选型。

## 决策

**默认使用 `node:sqlite`**：

1. **刻意回避 native 供应链**：零 native 依赖，消除 Node 26 ABI/预编译矩阵风险；Windows 用户无需构建工具。代价是受 Node 编译开关影响（见“运行期可用性”），因此加 feature detect + 官方二进制建议。
2. 22.16+/24/26 均可用；我们只使用 v22.5.0 起就有的稳定子集。
3. 实测性能足够；不是瓶颈。
4. 封装在 `SqliteDriver` 接口后；业务代码不直接依赖 `node:sqlite`。

风险控制：

- 若 `node:sqlite` API 在支持线内破坏、或性能/功能不满足，切换 `better-sqlite3` 作为 driver；ADR 记录切换原因。
- `better-sqlite3` 作为**兼容性备选**，不在 M1.2 引入运行时依赖；用独立 CI job 持续验证。
- 备选 CI 断言基于 pin 的 `13.0.3` 包内 `prebuilds/`；若包结构变化，先改断言再改 ADR，避免“永假”的 job。

## 引擎版本口径（为什么不是 22.13）

- `engines`：`^22.16.0 || ^24.0.0 || ^26.0.0`。
- 选 22.16 的理由：
  - 22.13 比 22.16 少 `timeout` 选项（v22.16），虽然我们当前不用；
  - 22.13 比 26 低一个成熟度档（22 是 Stability 1.1，26 是 1.2 RC）；
  - 22.16 是 22.x 中更完整的 API 面，减少“最低线恰好测不到 22.x 漂移”的问题。
- CI 同时保留 **22.x 最新版**（主矩阵 `22`）和 **22.16.0 最低版**（`minimum-node` job），覆盖 22.x 内部漂移。
- `storage-runtime` 测试在每条线跑：打开 SQLite、建 `message_ref`、验证主键/唯一索引/负数 int32/重启持久化。

## CI 上怎么验（存储）

1. **node:sqlite（默认，阻塞）**
   - 主矩阵：Node `22`（最新 22.x）/ `24` / `26` × `ubuntu-latest`（linux-x64）、`windows-latest`（win32-x64）。
   - `minimum-node` job：Node **22.16.0**，跑完整 `pnpm verify`。
   - linux-arm64：优先 GitHub `ubuntu-24.04-arm` runner；否则 QEMU：
     `docker run --platform linux/arm64 ... node:26 ...`。
   - 步骤：`pnpm install --frozen-lockfile && pnpm verify`；`storage-runtime` 必须通过。
   - **显式探测**：`node -e "const s=require('node:sqlite'); const D=s.Database??s.DatabaseSync; const db=new D(':memory:'); db.exec('CREATE TABLE t(x)'); db.close(); console.log('node:sqlite ok', process.version, process.versions.modules)"`，在 22.16 最低 job 与 26 job 都跑。
2. **better-sqlite3（备选，非阻塞/nightly）**
   - 安装 **pin 的 `better-sqlite3@13.0.3`**；
   - `npm pack` + `tar -tzf` 断言 `package/prebuilds/<platform>-<arch>.node` 存在；
   - 执行同一套建表/约束/重开测试；
   - 若某平台缺少预编译产物，记录为兼容性缺口，不阻塞默认路线。
3. **供应链**
   - 若未来切换 better-sqlite3，启用 `npm audit`/锁文件校验，并在 release 说明中列出预编译产物哈希。

## 重新审议触发条件

1. `node:sqlite` 在 22.16/24/26 任一线上出现 API 破坏或无法修复的 bug。
2. 单账号吞吐/延迟超过设计目标，SQLite 成为瓶颈。
3. 需要 `node:sqlite` 不提供的功能（如增量 blob、备份 API 的特定行为）。
4. 目标平台无法运行 `node:sqlite`（目前未发现）。
