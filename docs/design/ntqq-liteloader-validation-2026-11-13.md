# NTQQ + LiteLoaderQQNT 路线验证报告（2026-11-13）

> 验证对象：本机 `D:\qq`，QQ `9.9.33-52230`，Windows 11 x64。
> 授权前提：用户已明确批准在主力机操作、接受重装兜底；登录只用测试号；
> 不自动发消息、不批量操作、不产出可分发的安装包或补丁工具。
>
> **结论先行：这条路线在本机这个 QQ 版本上技术成立。** QQNTPatcher 绕过文件校验后，
> LiteLoader 1.4.1（需要一行 Node 24 兼容补丁）能加载自定义插件；插件能在
> `NodeIQQNTWrapperSession("nt_1")` 上注册消息监听，收到私聊/群文本、图片和语音；
> 图片可用 `downloadRichMedia` 落盘，语音有本地文件路径。自研 loader 上还接了最小
> OneBot v11 WS：私聊/群文本、缓存图片/语音回发、任意新图片/AMR 上传都已端到端验证。
> 代价是每次 QQ 更新要重打校验补丁，LiteLoader 上游已归档，且账号风控风险仍然存在。
>
> 验证完成后，主力机已回滚到原版（6 个关键文件哈希与原始基线一致）；补丁/工具/证据
> 冻结在 `D:\qq-patch-baseline\2026-11-13-9.9.33-52230`。自研 loader 最小 spike 也已
> 实测通过，见 6.2.1。

## 0. 结论表

| 问题 | 结果 |
| --- | --- |
| 文件校验绕过（patch） | **可行**：QQNTPatcher 1.0.4 改写 `QQNT.dll`，修改后的 `package.json` 被接受 |
| 文件校验绕过（dbghelp） | **不可行**：仍提示“文件已经损坏，请重新安装 QQ” |
| 绕过 LiteLoader 直接注入自研 loader | **已实测通过**：自研 loader 加载 QQ 原始 main，主进程 `nt_1` 附着并收到 `recv_msg`；无 LiteLoader |
| OneBot 最小适配 | **可行**：私聊/群文本、缓存图片/语音回发、任意新图片/AMR 上传发送均端到端通过 |
| 私聊/群消息事件 | **可行**：`onRecvMsg` 收到 `chatType=1` 和 `chatType=2` 的文本 |
| 图片媒体 | **可行**：`downloadRichMedia` 后原图落盘（227,194 字节 JPEG） |
| 语音媒体 | **可行（本地文件）**：`pttElement.filePath` 存在（2,685 字节 AMR） |
| 好友事件 | **未验证**：没有触发加好友/删好友操作 |
| 安全中心 | 本次登录/收发期间未观察到提示或强制下线；短时观察不能证明长期安全 |
| Defender | patcher/LiteLoader 未产生新告警；期间有一条与实验无关的下载被告警 |
| 最终建议 | **A 技术成立**；若做产品，建议自研 loader + 独立插件，不依赖已归档的 LiteLoader |

## 1. 环境与基线

| 项 | 值 |
| --- | --- |
| QQ | `9.9.33-52230`（`D:\qq`） |
| Electron | `40.0.0` |
| Chromium | `144.0.7559.60` |
| Node（Electron 内置） | `24.11.1`，ABI `143`，NAPI `10` |
| 应用入口（原始） | `./application.asar/app_launcher/index.js` |
| `application.asar` | `app_launcher/index.js` 为 80 字节密文；`application.json` 保存四文件签名 |
| 备份 | `D:\qq-backup-原始`，1874 个文件，1.239 GB，0 失败 |
| 更新器状态 | 2026-11-11 日志“无需更新”；winget 清单同为 `9.9.33.52230` |

修改前记录的关键 SHA256：

```text
abbed71fc3dfe84fa712a2243041029c4a2e60b25595528522cb92c5758d388a *QQ.exe
2efd59b3334bc3244b64fc4cd29d250704c37f52bbbe9b4cba298431c6c76d53 *QQEX.exe
f6f35b8517da5c38ace8d4b6abad1abed42f61c8e706d23192a22d91c7620e59 *QQNT.dll
a24c8293c9c5e692f5b2e329daaf9642c7fbf6c10795e76df33f5119f178a379 *package.json
```

说明：本地存在 9.9.35/9.9.36 热更新包，但 `readyVersion` 为空，更新器判断无需更新；
本次没有强行套用，也没有禁用自动更新（这是对原任务前置动作的偏离，见“限制”）。

## 2. V1：文件校验绕过

### 2.1 V1a：QQNTPatcher（成功）

- 工具：`QQNTPatcher.exe`，release `Patcher_v1.0.4`，47,104 字节，
  SHA256 `5c6d0c926cddfe7890d3e3767acd9fc3015e89ca87f1491f2181ffa303fd5ac4`，
  未签名，manifest 含 `requireAdministrator`。
- 只读核对：x64 特征码在 `QQNT.dll + 0x510197`，不在 `QQ.exe`。
- 第一次非提权启动：Windows 返回“请求的操作需要提升”，未执行。
- 以管理员身份启动后，由用户在文件对话框选择
  `D:\qq\versions\9.9.33-52230\QQNT.dll`，结果：
  - `QQNT.dll.bak` SHA256 =
    `f6f35b8517da5c38ace8d4b6abad1abed42f61c8e706d23192a22d91c7620e59`（与基线一致）；
  - 新 `QQNT.dll` SHA256 =
    `aaa546fca6093902d4361aa61616fdccd0d29574e6526323bfa5f5bd62d001b4`；
  - 文件大小不变（214,599,728 字节）。

### 2.2 V1b：dbghelp（失败）

- 工具：`dbghelp_x64.dll`，release `DllHijack_1.1.2`，419,840 字节，未签名。
- 放入 `D:\qq\dbghelp.dll`，并把 `package.json` 的 `main` 指向一个只写标记的 boot 脚本。
- 双击 QQ 后弹出：**“文件已经损坏，请重新安装 QQ”**，`boot.json` 未生成。
- 结论：dbghelp 1.1.2 对 `9.9.33-52230` 无效；该 DLL 已移出到
  `D:\qq-loader\dbghelp_x64.staged.dll`。

### 2.3 V1 启动验证（patcher 后成功）

在 patcher 成功后，保持 `main` 指向 boot 探针，再次启动：

```json
{
  "time": "2026-11-12T17:53:05.640Z",
  "type": "browser",
  "pid": 14168,
  "resourcesPath": "D:\\qq\\versions\\9.9.33-52230\\resources",
  "versions": { "electron": "40.0.0", "node": "24.11.1", "modules": "143" }
}
```

- 没有“文件损坏”提示；
- 多个 `QQ.exe` 进程存在；
- 没有 QQ 应用错误事件；
- 结论：**patcher 绕过成立，自定义 JS 确实在 QQ 的 Electron 主进程执行**。

## 3. V2：LiteLoader 注入与登录

- LiteLoaderQQNT `1.4.1`（MIT）解压到 `D:\qq-loader\LiteLoaderQQNT`；
- 新建 `resources\app\app_launcher\LiteLoader.js`：
  `require(String.raw\`D:/qq-loader/LiteLoaderQQNT\`)`；
- `package.json` 的 `main` 改为 `./app_launcher/LiteLoader.js`；
- 启动 QQ，测试号登录成功，出现正常登录页，无掉线。

### 3.1 Node 24 兼容问题（关键）

加入第一个插件后，LiteLoader 主进程报：

```text
TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string.
Received undefined
at store.js:104
at exports.scanPluginDirectory
```

根因：Node 24 的 `Dirent` 只有 `parentPath`，没有 `path`；LiteLoader 1.4.1 用了
`dirent.path`。对本地安装副本做了一行补丁：

```js
path.join(dirent.parentPath ?? dirent.path, dirent.name, "manifest.json")
```

补丁后插件加载成功，`plugin-loaded.json` 记录：

- LiteLoader `1.4.1`；
- QQ `9.9.33-52230`；
- Electron `40.0.0`、Node `24.11.1`；
- 插件列表：`polaris-probe`。

## 4. V3：事件与媒体

### 4.1 消息 API 可达性

在 LiteLoader 主进程插件中 `require(wrapper.node)` 成功，导出包含：

- `NodeIQQNTWrapperSession`（静态方法 `getNTWrapperSession`）；
- `NodeIKernelMsgService`（原型含 `addKernelMsgListener`、`addKernelMsgNotifyListener`、
  `downloadRichMedia`、`getRichMediaElement`）；
- `NodeIKernelRichMediaService` 等。

第一次直接调用 `getNTWrapperSession()` 报：

```text
assertion (argc == 1) failed:
NodeIQQNTWrapperSession::getNTWrapperSession needs 1 arguments
```

改为 `getNTWrapperSession("nt_1")` 后成功；`session.getMsgService()` 在第 3 次重试时
可用，随后注册监听器成功。

### 4.2 文本事件（成功）

`onRecvMsg` 捕获到：

- 私聊文本：`chatType=1`，`msgSeq`、`msgId`、`senderUin`、`textElement`；
- 群文本：`chatType=2`，群号/`peerUid`、`msgSeq`、`msgId`、`textElement`；
- 还观察到 `onLineDev`、`onContactUnreadCntUpdate`、`onNtMsgSyncStart` 等回调。

报告不记录测试消息正文、QQ 号或完整 UID；原始事件在本地
`D:\qq-loader\msg-events.jsonl`，包含测试消息内容，建议验证结束后删除。

### 4.3 重复投递（探针伪影）

同一条消息曾被记录两次。原因是探针同时做了“原型方法挂钩 + 主动注册”，并且定时器与
`setTimeout` 各触发了一次附着。已在探针中加入 `if (attached) return;`。这不是 QQ 平台
固有的重复；但产品实现仍应按 `msgId` 去重（与 Core 的 `sourceEventId` 策略一致）。

### 4.4 图片媒体（成功，需内核下载）

图片事件包含：

- `fileName`、`fileSize`、`picWidth/picHeight`、`md5HexStr`；
- `sourcePath`、`originImageUrl`、`fileUuid`、`fileSubId`、`transferStatus`；
- 事件初始 `transferStatus=0`，`sourcePath` 对应文件不存在。

`originImageUrl` 是相对路径，参数只有 `appid`、`fileid`、`spec`，**没有 rkey**。
直接拼腾讯 CDN 返回：

```json
{"retcode":-5503010,"retmsg":"invalid rkey","retryflag":1}
```

调用内核 API：

```js
msgService.downloadRichMedia({
  msgId, elemId, elementId, chatType, peerUid,
  downloadType: 2, thumbSize: 0
});
```

结果：

- `downloadRichMedia` 返回 `undefined`；
- 约 0.5 秒后 `sourcePath` 文件出现；
- 文件 227,194 字节，JPEG 魔数 `ffd8ffe0`。

结论：**9.9.33 上不能靠事件里的 URL 直接取图，但内核下载 API 可以取到原图。**

### 4.5 语音媒体（成功，本地文件）

语音事件 `elementType=4`，`pttElement` 包含：

- `filePath`、`fileSize=2685`、`duration=1`、`formatType=1`、`md5HexStr`；
- `filePath` 对应文件存在，大小 2,685 字节，AMR。

本次语音文件已在本地，未单独测“未下载语音”的 `downloadRichMedia`；图片路径已证明
同一 API 可用，语音建议用相同方式补测。

### 4.6 好友事件

未触发。`NodeIKernelBuddyService` 在 `wrapper.node` 中存在，但本次没有加好友/删好友
操作；好友事件需要单独用测试号补测。

## 5. V4：风控与版本耦合成本

### 5.1 安全中心

- 测试号完成登录、私聊/群消息、图片、语音，期间未报告“非法外挂”提示、强制下线或
  账号被踢；
- 这只是短时、低消息量的观察，**不能证明长期安全**；QQ 安全中心仍可能在未来识别
  patcher/LiteLoader 并下线设备或封禁账号。

### 5.2 Defender

- patcher、dbghelp、LiteLoader 本次未产生新的 Defender 告警；
- 历史告警仍是本仓库 manual-map `injector.exe`；
- 验证期间 Defender 记录了一条**与实验无关**的下载告警：
  `C:\Users\example\Downloads\...crdownload`，来源 `exe2.webgetstore.com`，
  文件名类似“紫罗兰工具箱V3.7.exe”。不是 patcher/LiteLoader 触发的，单独列出避免误归因。
- 注意：patcher/dbghelp 都未签名；换机器或重新构建后可能被拦。

### 5.3 版本耦合

- QQNTPatcher 依赖 `QQNT.dll` 中的特征码；QQ 更新后需要重新确认/重新打补丁。
- LiteLoader 1.4.1 在 Node 24 上需要一行兼容补丁；上游仓库已归档（最后 push
  2026-05-09，最新 release 1.4.1 发布于 2025-12-02）。
- `getNTWrapperSession("nt_1")`、`NodeIKernelMsgService` 方法名和事件字段是当前版本的
  实测结果；QQ 更新可能改变。
- 每次 QQ 升级的适配工作量至少包括：重打校验补丁、验证 LiteLoader/自研 loader、
  验证 `nt_1` 会话、验证消息/媒体字段、回归发送与风控。

## 6. 最终建议

### 6.1 按你的判定规则：A 成立

在本机 `9.9.33-52230` 上，**“NTQQ + 插件注入”路线技术成立**：校验可绕过、主进程可执行
自定义代码、消息/群/图片/语音事件可达。因此可以进入“全新项目替代 LuckyLilliaBot/
LLOneBot”的可行性阶段。

### 6.2 但产物形态建议是“自研 loader + 独立插件”，不是依赖 LiteLoader

理由：

- LiteLoader 1.4.1 已归档，且在 Node 24 上需要本地补丁；
- 我们已经证明自定义 `main` 能在主进程执行（V1），也证明了
  `wrapper.node`/`NodeIKernelMsgService` 可直接附着（V3）；
- 自研 loader 的最小骨架只需加载 QQ 原始入口并附着会话；本次已证明**不 hook Electron
  也能启动并收消息**。需要 UI/preload 插件时再补 `BrowserWindow` hook。这比维护一个
  归档的第三方 loader 更可控。

自研 loader 的最小架构：

1. 安装/升级时用 patcher 处理 `QQNT.dll`（或用户自行提供合法的绕过方式）；
2. 把 `resources/app/package.json` 的 `main` 指向我们的 loader；
3. loader 先加载 QQ 原始入口；需要窗口/preload 注入时再 hook Electron；
4. 在主进程用 `NodeIQQNTWrapperSession.getNTWrapperSession("nt_1")` 取
   `getMsgService()`，注册 `addKernelMsgListener` / `addKernelMsgNotifyListener`；
5. 事件按 `msgId` 去重；图片/语音用 `downloadRichMedia` 或本地 `filePath`；
6. 把事件转成 OneBot 11，接入 Lodestar Core 的 EventSink/Outbox/SendGuard。

### 6.2.1 自研 loader 最小 spike（已验证）

源码：`spike/ntqq-loader/src/polaris-loader.js`。它不依赖 LiteLoader，做三件事：

1. 写 `self-loader-<pid>.jsonl`；
2. `require(application.asar/app_launcher/index.js)` 加载 QQ 原始 main；
3. 主进程（`QQ.exe`，无 `--type=`）轮询 `getNTWrapperSession("nt_1")`，注册消息监听。

实测（2026-11-13）：

- 主进程 `2480`（`D:\qq\QQ.exe`）日志顺序：
  `loader_start → wrapper_loaded → attach_enabled → original_require →
  original_returned → attach_wait_service ×2 → attached (attempts=3) → ... →
  recv_msg`；
- `recv_msg`：`chatType=1`、`msgId`、`msgSeq` 和元素摘要（文本长度 2）；
- QQEX 子进程 `14612` 只记录 `attach_skip (not-main)`，没有误附着；
- QQ 正常登录，全程没有 LiteLoader；
- 测试后已回滚，证据在
  `D:\qq-patch-baseline\2026-11-13-9.9.33-52230\probe\self-loader\`。

结论：**自研 loader 的最小骨架成立**。它目前只负责“启动 QQ + 附着消息”；发送、媒体上传、
好友事件、UI 插件、窗口/preload hook 都还没做。

### 6.2.2 自研 loader 上的最小 OneBot 适配（已验证文本、缓存媒体、任意图片/AMR 上传）

源码：`spike/ntqq-loader/src/onebot.js`。它和 loader 跑在同一个 QQ 主进程里，
在 `ws://127.0.0.1:3001` 提供最小 OneBot v11 服务：

- 事件：`message`（私聊/群），元素映射为 text / image(file,url) / record(file) /
  face / reply；
- 动作：`get_login_info`、`get_status`、`get_version_info`、
  `send_private_msg`、`send_group_msg`、`send_msg`；
- 发送支持非空文本、本地图片/AMR 文件、缓存图片/语音回发；
- 新文件上传流程：`getRichMediaFilePathForGuild` 取媒体落盘路径 → 复制文件 →
  `sendMsg` 带 `picElement/pttElement`；图片用 md5/尺寸，语音用 AMR + duration；
- 缓存回发用 `data.file="latest"` 或 md5；收到时若本地文件不存在会调用
  `downloadRichMedia`；
- 私聊需要先收到该好友消息以缓存 `u_...` peerUid；群发送直接用群号作为 peerUid；
- `message_id` 是适配器分配的负数计数器，不是 QQ 原生 msgId。

实测（2026-11-13）：

```text
get_login_info → { user_id: 123456789, nickname: "polaris-test" }
send_private_msg → { status: "ok", retcode: 0, data: { message_id: -2 } }
QQ sendMsg → { result: 0, errMsg: "" }          # 私聊文本
send_group_msg (text)   → ok，elementTypes=[1]，result=0
send_group_msg (cached image)  → ok，elementTypes=[2]，result=0
send_group_msg (cached record) → ok，elementTypes=[4]，result=0
send_group_msg (new image)  → media_upload 227,194 bytes / 864×1920 / result=0
send_group_msg (new AMR)    → media_upload 2,685 bytes / duration=1 / result=0
```

另一个账号收到了私聊文本；测试群实际收到了群文本、缓存图片、缓存语音，以及新上传的
图片和语音；图片正常显示、语音正常播放。证据在：

- `D:\qq-patch-baseline\2026-11-13-9.9.33-52230\probe\onebot-adapter\group-media\`
- `D:\qq-patch-baseline\2026-11-13-9.9.33-52230\probe\onebot-adapter\upload-media\`

未实现：其他语音格式（silk/mp3）的转码上传、合并转发、好友/群通知、撤回、
`get_msg`、多账号。

### 6.3 代价与风控面

### 6.3 代价与风控面

- **版本维护**：每次 QQ 更新都要重新验证 patcher、loader、会话名、事件字段；
- **合规/账号**：绕过文件校验 + 注入属于非官方修改，QQ 安全中心可能下线/封号；
- **供应链**：patcher 未签名；dbghelp 来源不可审计且本版本无效；LiteLoader 上游归档；
- **分发**：不应把 patcher/绕过 DLL 打进安装包；最多提供“用户自备”的说明；
- **平台**：本次只验证 Windows x64；macOS/Linux 未测。

### 6.4 如果目标是“可发布的开源产品”

A 可以作为**可选/实验后端**，但不建议作为默认安装链。默认仍建议 B（有头客户端 +
外部控制/自动化）或 OneBot 上游适配器；A 的差异化应放在探针、outbox、SendGuard、
部署和可观测，而不是“能绕过校验”。

### 6.5 与 LLOneBot 的关系

`LLOneBot/LLOneBot` 现已重定向到 `LuckyLilliaDev/LuckyLilliaBot`，仍在维护
（v8.3.2，2026-10-12，GPL-2.0）。如果它在本机也能工作，“替代它”需要明确差异化；
且 GPL-2.0 代码不能复制进 Apache-2.0 的 Lodestar，只能独立实现或做机制验证。

## 7. 当前机器状态与冻结基线

**已回滚到原版**（2026-11-13 最终状态）：

- QQ 未运行；
- `QQ.exe`、`QQEX.exe`、`QQNT.dll`、`package.json`、`application.json`、
  `application.asar` 六个关键哈希全部与测试前基线一致；
- `resources\app\app_launcher\` 已移走（原版没有这个目录）；
- patcher 留下的 `QQNT.dll.bak` 已移入基线 `probe/QQNT.dll.patcher-backup`；
- `D:\qq\dbghelp.dll` 不存在；
- LiteLoaderQQNT 不在 QQ 目录内；
- 完整备份仍在 `D:\qq-backup-原始`。

冻结基线：`D:\qq-patch-baseline\2026-11-13-9.9.33-52230\`

- `originals/`：原版 `QQNT.dll`、`package.json`；
- `patched/`：patcher 后的 `QQNT.dll`、LiteLoader 版 `package.json`；
- `tools/`：`QQNTPatcher.exe`、`dbghelp_x64.dll`（失败样本）；
- `liteloader/`：LiteLoader 1.4.1 zip、Node 24 补丁后的 `store.js`；
- `probe/`：boot/plugin/wrapper 探针、LiteLoader 插件、`app_launcher-test`；
- `probe/self-loader/`：自研 loader 源码、主/子进程日志、冻结的 package.json；
- `probe/onebot-adapter/`：OneBot 适配源码、WS 日志、配置和测试 package.json；
- `probe/onebot-adapter/group-media/`：群文本/图片/语音发送证据与源码；
- `probe/onebot-adapter/upload-media/`：任意新图片/AMR 上传发送证据；
- `MANIFEST.md`：哈希、复现/回滚步骤、风险说明。

未纳入基线：`D:\qq-loader\msg-events.jsonl`（包含测试号消息内容与 UID）；验证已结束，
建议删除。

### 7.1 再次实验/回滚

再次实验时（仅测试号）：

1. 关闭 QQ；
2. 把 `patched/QQNT.dll` 复制回 `D:\qq\versions\9.9.33-52230\QQNT.dll`；
3. 按自研 loader spike 的步骤放入 `app_launcher/polaris-loader.js` 并修改
   `package.json` 的 `main`；
4. 启动 QQ，登录测试号，检查 `self-loader-<pid>.jsonl`；
5. 实验完成后，复制 `originals/QQNT.dll` 和 `originals/package.json` 回原位，
   移走 `app_launcher`。

回滚命令：

```powershell
Copy-Item -LiteralPath "D:\qq-patch-baseline\2026-11-13-9.9.33-52230\originals\QQNT.dll" -Destination "D:\qq\versions\9.9.33-52230\QQNT.dll" -Force
```

```powershell
Copy-Item -LiteralPath "D:\qq-patch-baseline\2026-11-13-9.9.33-52230\originals\package.json" -Destination "D:\qq\versions\9.9.33-52230\resources\app\package.json" -Force
```

## 8. 证据文件（本机）

- `D:\qq-patch-baseline\2026-11-13-9.9.33-52230\`：冻结基线，含 `MANIFEST.md`
- `D:\qq-patch-baseline\2026-11-13-9.9.33-52230\probe\self-loader\`：
  自研 loader 源码、`self-loader-2480.jsonl`（主进程）、
  `self-loader-14612.jsonl`（QQEX 子进程）、`first-run.jsonl`
- `D:\qq-patch-baseline\2026-11-13-9.9.33-52230\probe\onebot-adapter\`：
  OneBot 适配源码、`onebot-29568.jsonl`、`self-loader-29568.jsonl`、配置
- `D:\qq-patch-baseline\2026-11-13-9.9.33-52230\probe\onebot-adapter\group-media\`：
  群文本/图片/语音发送的 `onebot-26628.jsonl`、`self-loader-26628.jsonl` 和源码
- `D:\qq-patch-baseline\2026-11-13-9.9.33-52230\probe\onebot-adapter\upload-media\`：
  任意新图片/AMR 上传的 `onebot-7496.jsonl`、`self-loader-7496.jsonl` 和源码
- `D:\qq-loader\boot.json`：V1 boot 探针
- `D:\qq-loader\plugin-loaded.json`：LiteLoader/插件加载
- `D:\qq-loader\wrapper-probe.json`：`wrapper.node` 导出
- `D:\qq-loader\msg-probe.json`：附着状态
- `D:\qq-loader\msg-events.jsonl`：消息/媒体事件（含测试内容，勿公开）
- `C:\Users\example\AppData\Local\Temp\lodestar-qq-verify\`：patcher/dbghelp/LiteLoader zip
- `D:\qq-backup-原始`：完整回滚点

## 9. 限制

- 单机、单 QQ 版本、测试号、短时验证；没有长稳/风控周期测试；
- 好友事件未触发；语音“未下载”场景未单独测；群管理/发送动作未测；
- 自研 loader 验证了“加载原始 main + 主进程 `nt_1` 附着 + 收消息 + 私聊/群文本 +
  缓存媒体回发 + 任意新图片/AMR 上传”；其他语音格式转码、好友事件、窗口/preload
  hook 和长稳尚未测；
- 自动更新未禁用（更新器当前判断无需更新）；验证结束后 QQ 已回滚；
- 没有证明“不会封号”；相反，非官方修改本身就有明确风险；
- 没有产出可分发的 patcher/loader 安装包；本文只记录验证机制。
