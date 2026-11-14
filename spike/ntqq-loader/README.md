# NTQQ 自研 loader 最小 spike

> 本目录只放**自研 loader 的源码和机制说明**，不包含 QQ 补丁、patcher、绕过 DLL 或一键安装包。
> 安装/回滚脚本只在本机冻结基线里，按报告中的手工步骤执行。
>
> 目标：验证不依赖 LiteLoaderQQNT 时，自定义 `package.json` 入口能否加载 QQ 原始 main，
> 并在主进程直接附着 `NodeIQQNTWrapperSession("nt_1")` 的消息服务。

## 当前状态

**最小 spike 已实测通过（2026-11-13，QQ `9.9.33-52230`）。**

主进程 `2480` 的 `self-loader-2480.jsonl` 顺序为：

```text
loader_start → wrapper_loaded → attach_enabled → original_require
→ original_returned → attach_wait_service ×2 → attached (attempts=3)
→ onNtMsgSyncEnd / onLineDev / ... → recv_msg
```

`recv_msg` 记录了一条私聊文本的 `msgId`、`chatType=1`、`msgSeq` 和元素摘要。
QQEX 子进程 `14612` 只记录 `attach_skip (not-main)`，没有误附着。
全程没有加载 LiteLoaderQQNT。测试结束后 QQ 已回滚到原版，6 个关键文件哈希与原始
基线一致；证据冻结在
`D:\qq-patch-baseline\2026-11-13-9.9.33-52230\probe\self-loader\`。
自研 loader 上的 OneBot 最小适配也已验证私聊/群文本、缓存图片/语音回发，以及
任意新图片/AMR 文件的上传发送，见下文。

### 尚未验证

- 没有实现 LiteLoader 那种 `BrowserWindow` hook 和 preload 注入；本次只验证了
  “加载原始 main + 主进程消息附着”这条最小骨架；
- OneBot 最小适配已实测：私聊/群文本、缓存图片和语音回发、任意新图片/AMR 上传发送
  均端到端通过；其他语音格式（silk/mp3）、好友事件、群管理、长稳和风控周期都未做；
- 依赖冻结基线里的 patched `QQNT.dll`；QQ 更新后需要重新验证特征码/会话/字段；
- 只在 Windows x64、单账号上验证。

## 它做什么

```text
QQ.exe
  └─ resources/app/package.json main → app_launcher/polaris-loader.js
       ├─ 写 self-loader-<pid>.jsonl（版本/资源路径；每进程独立）
       ├─ require(resources/app/wrapper.node)
       ├─ 主进程轮询 NodeIQQNTWrapperSession.getNTWrapperSession("nt_1")
       │    └─ getMsgService()
       │         ├─ addKernelMsgListener → OneBot message 事件
       │         └─ sendMsg ← send_private_msg / send_group_msg / send_msg
       ├─ 启动 OneBot WS（127.0.0.1:3001）
       └─ require(resources/app/application.asar/app_launcher/index.js)
            └─ 让 QQ 自己的主进程代码继续启动登录/窗口
```

OneBot 适配只绑定 `127.0.0.1`，消息事件广播给已连接的客户端；发送支持文本、本地图片/
AMR 文件上传、缓存图片/语音回发（`data.file="latest"` 或 md5）。默认不设 token，
正式使用请配置 `accessToken`。

## 为什么可能不需要 LiteLoader

LiteLoader 的关键步骤是：

1. hook `require('electron')` 的 `BrowserWindow`，注入自定义 preload；
2. 加载插件；
3. `require` QQ 原始的 `application.asar/app_launcher/index.js`。

最小 spike 先只做第 3 步和消息附着。如果 QQ 能正常启动并登录，说明自研 loader 的骨架成立；
如果 QQ 空白/崩溃，再补第 1 步的 Electron 窗口 hook。这样能把变量降到最低。

## OneBot 最小适配

配置：`D:\qq-loader\onebot-config.json`

```json
{
  "selfId": 123456789,
  "host": "127.0.0.1",
  "port": 3001,
  "accessToken": "",
  "nickname": "polaris-test"
}
```

已实现：

- 连接时发 `meta_event.lifecycle`，每 30s 发 `heartbeat`；
- 消息事件：`post_type=message`，私聊 `message_type=private`、群 `group`；
  `message` 段包含 text / image(file/url) / record(file) / face / reply；
- 动作：`get_login_info`、`get_status`、`get_version_info`、
  `send_private_msg`、`send_group_msg`、`send_msg`；
- 发送支持非空文本、本地图片/AMR 上传（`data.file` 为绝对路径）、缓存图片/语音回发
  （`latest` 或 md5）；图片/语音先经 `getRichMediaFilePathForGuild` 落盘，再随
  `sendMsg` 发送；Windows 路径建议写成 `D:/...`，避免 JSON/终端转义吃掉反斜杠；
  私聊发送需要先收到该好友的一条消息以缓存 `u_...` peerUid；
  群发送直接用群号作为 peerUid；
- `message_id` 是适配器分配的负数计数器，不是 QQ 原生 msgId；仅用于本轮会话。

实测（2026-11-13，测试号）：

- WS 连接成功，收到私聊/群文本、群图片和群语音事件；
- `get_login_info` 返回 `user_id=123456789`、`nickname=polaris-test`；
- `send_private_msg` 返回 `status=ok`、`retcode=0`，QQ 原生 `sendMsg` 返回
  `{result:0, errMsg:""}`；另一个账号实际收到；
- `send_group_msg` 文本/图片/语音三条都返回 `status=ok`，QQ `sendMsg` 均为
  `{result:0}`，测试群实际收到三条消息；
- 新文件上传：`new-image.jpg`（227,194 字节，864×1920，md5 `f4460b…a739`）上传后
  `sendMsg` 返回 `result:0`，测试群图片正常显示；
- 新文件上传：`new-voice.amr`（2,685 字节，duration=1，md5 `862609…dfb8c`）上传后
  `sendMsg` 返回 `result:0`，测试群语音正常播放；
- 证据：`D:\qq-patch-baseline\2026-11-13-9.9.33-52230\probe\onebot-adapter\group-media\`
  与 `...\upload-media\`。

未实现：其他语音格式（silk/mp3）的转码上传、合并转发、好友/群通知、撤回、
`get_msg`、多账号、token 之外的鉴权。

## 文件

- `src/polaris-loader.js`：最小 loader/启动与附着；
- `src/onebot.js`：最小 OneBot v11 WS 服务（事件 + 文本发送）；
- `src/image-size.js`：图片尺寸解析（随 loader 一起安装，避免 QQ 目录依赖 node_modules）；

安装时会把仓库的 `node_modules/ws` 和 `src/image-size.js` 一起复制到 `app_launcher`，
不再依赖 `D:\qq-loader\onebot\node_modules`。
- `patch-qqnt.ps1`：仅针对已冻结 QQ 版本的 5 字节本地 patcher，原始/目标哈希都写死；
- `install-native.ps1`：本机 native 安装向导，自动检测 QQ 版本、备份、等待 patcher、
  安装 loader 并启动 QQ。

## 自动安装脚本（本机）

`install-native.ps1` 需要管理员权限；patcher 由用户自备，不会随仓库分发。

9.9.37-54395 已验证出一条自动路径：`patch-qqnt.ps1` 只把
`0x510D08` 的 `e853dde601`（一次 call）替换为 `b801000000`（返回值 1），
并且同时校验原版 SHA256 `cead5c2d…` 和结果 SHA256 `bf8c1aa8…`。这不是通用
特征扫描 patcher；未知 QQ 版本会直接拒绝，必须重新 diff 并加入白名单。

```powershell
# 只检查，不改文件
powershell -ExecutionPolicy Bypass -File spike\ntqq-loader\install-native.ps1 -DryRun -AutoPatch

# 管理员 PowerShell：自动 patch + 安装 loader + 启动 QQ，不需要 GUI patcher
powershell -ExecutionPolicy Bypass -File spike\ntqq-loader\install-native.ps1 `
  -AutoPatch -LoaderDir "D:\qq-loader\staged\app_launcher" -SelfId "123456789"
```

没有 `-AutoPatch` 时仍可走用户自备的 GUI patcher；patcher 只导入
`GetOpenFileNameW`，没有 CLI，需要在窗口里手动选择 `QQNT.dll`。

脚本会把原始 `QQNT.dll` 和 `package.json` 备份到 `D:\qq\polaris-backup\<version>-<time>`。
如果 patcher 失败或 QQ 提示文件损坏，从该目录回滚。它不会启动 Core；QQ 登录后由
`node scripts/upstream.mjs` 或 `Lodestar-Setup.cmd` 启动 Core。

## 限制

- 只针对 `9.9.33-52230` 和 `9.9.37-54395` 验证；`nt_1`、`wrapper.node` 导出和事件字段
  都可能随 QQ 更新变化；
- 依赖 patcher 绕过文件校验；patcher 未签名、每次 QQ 更新都要重新确认；
- 仅测试号、本地使用；不构成可分发安装包或补丁工具；
- 账号风险由使用者自担。
