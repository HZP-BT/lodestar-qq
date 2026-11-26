# Lodestar Linux 部署指南

> 适用：Linux x64 · 定位：把 Lodestar 作为 **OneBot v11 网关**运行在 Linux 上。
>
> Windows 版的自研 loader（附着真实 NTQQ）是 Windows 专属能力，Linux 上没有。
> Linux 版走网关模式：`OneBot 上游（NapCat / LagoneBot / LLOneBot 等）← Lodestar Core ← AstrBot`。
> 对外行为与 Windows 版一致：AstrBot 通过反向 WS 连 Lodestar，发送动作原样转发给上游，不做白名单/配额/限流。

## 1. 运行拓扑

```text
AstrBot ── reverse WS (6199/ws) ──► Lodestar Core ── WS client (3001) ──► OneBot 上游 ──► Linux QQNT
                                          │
                                          └─ 面板 127.0.0.1:18081 · 健康 127.0.0.1:18080
```

- 上游需要一个 **OneBot v11 WebSocket 服务端**（不是反向 WS），端口以实际上游为准，常见 `3001`；
- AstrBot 侧新建 OneBot v11（aiocqhttp）适配器，反向 WS 端口默认 `6199`；
- NapCat 在 Linux 上有官方支持；LagoneBot 等也可作为上游。Lodestar 不打包、不修改这些上游。

## 2. 前置条件

- Docker Engine 24+ 与 Compose 插件（推荐），或 Node.js ≥ 22.16（tar 包方式）；
- 一个运行中的 OneBot v11 上游，且已登录测试 QQ 号；
- AstrBot 已安装并启用 aiocqhttp 反向 WS；
- 只使用测试号。

## 3. 方式一：Docker Compose（推荐）

仓库根目录已经提供 `Dockerfile.linux` 和 `docker-compose.linux.yml`。

```bash
git clone https://github.com/HZP-BT/lodestar-qq.git
cd lodestar-qq
cp config/upstream.example.json config/upstream.json
# 编辑 config/upstream.json：selfId、上游地址、AstrBot 地址、admin.token
docker compose -f docker-compose.linux.yml up -d --build
```

`config/upstream.json` 最小示例：

```json
{
  "selfId": 123456789,
  "upstream": {
    "url": "ws://127.0.0.1:3001/",
    "token": "上游 WS token（没有就留空）"
  },
  "astrbot": {
    "url": "ws://127.0.0.1:6199/ws",
    "token": "AstrBot 的 OneBot v11 token（没有就留空）"
  },
  "health": { "host": "127.0.0.1", "port": 18080 },
  "admin": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 18081,
    "webRoot": "packages/web/dist",
    "token": "至少 12 位的本地管理 token"
  },
  "databasePath": "data/polaris.db"
}
```

说明：

- Compose 使用 `network_mode: host`，所以 `127.0.0.1:3001`（上游）和 `127.0.0.1:6199`（AstrBot）指宿主机回环；
  面板也只监听宿主机 `127.0.0.1:18081`。如果上游或 AstrBot 跑在 bridge 网络的容器里，把地址改成
  宿主机 IP 或它们的容器地址。
- `./config`、`./data`、`./logs` 挂载到容器内；管理 token 与数据库都留在宿主目录。
- 镜像构建会执行 `pnpm build` 并 esbuild 打包成单个 `lodestar.cjs`，运行镜像只含 Node 和这个 bundle。

常用命令：

```bash
docker compose -f docker-compose.linux.yml logs -f lodestar-core
docker compose -f docker-compose.linux.yml restart lodestar-core
docker compose -f docker-compose.linux.yml down
```

打开 `http://127.0.0.1:18081`，输入 `admin.token`。健康检查：`http://127.0.0.1:18080/readyz`。

## 4. 方式二：tar 包 + systemd

在开发机（Linux 或 WSL）上构建：

```bash
pnpm install
bash scripts/release/package-linux.sh
# 产物：lodestar-<version>-linux-x64.tar.gz
```

目标机：

```bash
sudo mkdir -p /opt/lodestar
sudo tar -xzf lodestar-*-linux-x64.tar.gz -C /opt/lodestar --strip-components=1
cd /opt/lodestar
cp config/upstream.example.json config/upstream.json   # 编辑 selfId / 地址 / token / webRoot
node lodestar.cjs
```

tar 包里的示例配置已经把 `admin.webRoot` 设为 `web`，不要改回源码路径。

注册为服务：

```bash
sudo cp lodestar.service.example /etc/systemd/system/lodestar.service
sudo systemctl daemon-reload
sudo systemctl enable --now lodestar
systemctl status lodestar
journalctl -u lodestar -f
```

## 5. 面板

- 总览：Loader/上游、OneBot 连接、运行状态（ONLINE / UNKNOWN / OFFLINE）、账号与队列；
- 协议端配置：面板端口、上游 WS、AstrBot 反向 WS 地址/token；保存后平滑重启连接；
- 指标：健康、就绪、连接与队列；
- 系统：修改管理密码、终止 Core 进程。

面板只监听 `127.0.0.1`；不要把 `18081` 暴露到公网。

## 6. 排障

| 现象 | 检查 |
| --- | --- |
| `/readyz` 503 | Core 未连上 AstrBot（health=OFFLINE），或上游未连接/未登录（UNKNOWN） |
| 面板能开，但消息不发 | 上游 OneBot WS 是否可达；AstrBot 是否真的产生了发送动作 |
| `ApiNotAvailable` | AstrBot 反向 WS 注册竞态：停 Core → 完全停 AstrBot → 启动 AstrBot → 启动 Core |
| `node:sqlite` 不可用 | 使用官方 Node 二进制或官方 Docker 镜像 |
| 容器里连不上 127.0.0.1:6199 | 上游/AstrBot 在 bridge 容器中；改用宿主机 IP 或统一 host 网络 |
| 端口被占用 | 18080/18081 只允许一个 Core；先停旧的实例或容器 |

## 7. 更新与卸载

Docker：

```bash
git pull
docker compose -f docker-compose.linux.yml up -d --build
```

保留 `config/` 与 `data/` 即可保留配置和事件库。

卸载：

```bash
docker compose -f docker-compose.linux.yml down
# 需要彻底清理时再删除 ./config、./data、./logs
```

systemd 方式：停止并禁用服务，删除 `/opt/lodestar`；AstrBot 与上游按各自方式处理。

## 8. 安全与合规

- 面板只监听 `127.0.0.1`，使用本地 token；不要做公网反向代理；
- 不要提交或外发 `config/upstream.json`、`data/` 或 token；
- 上游注入/补丁路线属于第三方方案，与腾讯/QQ 无隶属或授权关系；
- 只使用测试号；账号被风控、踢下线或封禁的风险由使用者自担；
- Lodestar 自有代码 Apache-2.0；上游与 AstrBot 按各自许可证分发。
