# NTQQ 注入 spike（M3 预研）

这是 **隔离的实验目录**，用于验证 Lodestar 原生 NTQQ 注入后端的两块基础能力：

1. 对任意 x64 进程做 PE manual map（在目标进程内分配镜像、重定位、解析导入、远程线程执行）；
2. 负载在目标进程内通过命名管道向注入器回报“已附着”。

它**不是**可交付后端，也**不会**修改 QQ 安装目录、登录状态、消息、凭证或网络流量。

> 当前结论：良性 target 上的 manual map + 命名管道回报已**连续 5 次执行成功**，其中 4 次
> 由 `run-spike.ps1` 完成完整断言（退出码 0、管道消息、target 仍存活）。Windows Defender
> 在两次重建后曾立即拦截注入器，未添加任何排除项，之后又能正常运行——行为不稳定，不能
> 当作已解决。**尚未对 QQ 做过任何注入尝试。** 详见 [EVIDENCE.md](EVIDENCE.md)。

## 当前环境（2026-11-12 只读探测）

| 项 | 值 |
| --- | --- |
| OS | Windows 11 Pro 10.0.26300 x64 |
| QQ 安装 | `D:\qq`（注册表 `HKLM\SOFTWARE\WOW6432Node\Tencent\QQNT`） |
| QQ 版本 | `9.9.33.52230` |
| 版本目录 | `D:\qq\versions\9.9.33-52230` |
| 启动器 | `D:\qq\QQ.exe`，1,717,800 字节，PE x64 |
| 客户端主 DLL | `QQNT.dll`，214,599,728 字节，PE x64 |
| Electron 入口 | `resources\app\package.json` → `./application.asar/app_launcher/index.js` |
| 工具链 | Zig 0.17.1（`zig cc -target x86_64-windows-gnu`），无需 MSVC |

完整探测输出见 [evidence/probe-qq-2026-11-12.txt](evidence/probe-qq-2026-11-12.txt)。
探测脚本 [probe-qq.ps1](probe-qq.ps1) 只读注册表、文件头和进程列表。

## 设计

```text
target.exe (64s Sleep)
   ▲ CreateRemoteThread(entry = image_base + AddressOfEntryPoint)
   │
injector.exe
   ├─ 读取 payload.dll，校验 MZ/PE64
   ├─ calloc SizeOfImage，拷贝 headers/sections
   ├─ 应用 .reloc（DIR64/HIGHLOW）
   ├─ 解析 import，按名字/序号写 IAT
   ├─ VirtualAllocEx(PAGE_EXECUTE_READWRITE) + WriteProcessMemory
   ├─ 创建命名管道 \\.\pipe\polaris-spike
   └─ 等待管道消息
          ▲
payload.dll（自定义入口 payload_main，无 CRT 初始化）
   └─ CreateFileA("\\.\pipe\polaris-spike") → WriteFile("polaris-spike-payload-attached")
```

关键点：

- 负载入口是 `payload_main(void* image_base)`，通过 `-Wl,--entry,payload_main` 覆盖默认
  `DllMainCRTStartup`；用 `-nostdlib` 构建，避免 CRT 初始化。
- 负载只导入 `kernel32.dll` 的 `CreateFileA` / `WriteFile` / `CloseHandle` / `Sleep`；
  当前产物 3,072 字节，无 `.tls`、无 `.reloc`，已用 `zig objdump --imports` 核对。
- 注入器先把镜像在本地拼好（含重定位与 IAT），再一次性写入远端；负载不依赖目标进程里
  UCRT 的加载状态。
- 命名管道既是“执行成功”的证据，也是后续控制通道的最小雏形。

## 构建与运行

```powershell
cd spike\ntqq-inject
powershell -ExecutionPolicy Bypass -File build.ps1
powershell -ExecutionPolicy Bypass -File run-spike.ps1
```

`build.ps1` 自动寻找 winget 安装的 Zig；也可用 `-Zig <path>` 指定。产物在 `build/`，已被
`.gitignore` 忽略。

`run-spike.ps1` 会启动 `target.exe`、记录 PID、运行注入器、断言管道消息，并在结束时杀掉
target。它只应针对这个良性 target 运行。

## 已验证 / 未验证

已验证：

- 良性 x64 target 上 manual map 成功，负载确实在目标进程内执行并向注入器回报；
- 当前的 `-nostdlib` payload（3,072 字节，仅导入 kernel32，无 `.tls/.reloc`）累计执行 5 次，
  其中 4 次通过 `run-spike.ps1` 的完整断言：注入器退出码 0、收到管道消息、target 仍存活；
- 首个完整断言运行的输出：

  ```text
  injected at 000001CBF1100000, waiting for pipe...
  pipe message: polaris-spike-payload-attached
  PASS: payload executed inside target and signaled via named pipe
  ```

- 构建链在无 MSVC 的机器上可复现（Zig 0.17.1）；
- PE 机器类型、QQ 安装路径与版本可只读探测。

未验证 / 已知缺口：

- **稳定性**：只在本机连续跑了 5 次，没有长稳、并发、不同 target（Electron/多线程/带
  CFG 的进程）测试；
- **Defender 行为不稳定**：两次重建后立即运行时被拦截，未加排除项，之后同一文件又能运行。
  不能假设在别的机器或重新构建后仍可执行；发布形态必须正面解决（见下）。
- 只处理了 DIR64/HIGHLOW 重定位、普通 import；未处理 TLS callback、异常目录、CFG、
  delay-load import、forwarded export、section 权限、卸载（unload）、x86/Wow64。
- 远端内存是 `PAGE_EXECUTE_READWRITE`，不是按 section 权限拆分；生产实现必须收紧。
- 成功路径 / 失败路径的句柄与远端内存释放只做了基本处理，未做故障注入测试。
- 未注入 QQ，未验证 QQ 版本兼容性、登录状态、消息收发或任何 hook。

## Defender 拦截

两次重新构建后立即运行时，Defender 阻止了执行并记录：

```text
ThreatName : Trojan:Win32/Bearfoos.A!ml
Resources  : {file:_E:\daiti\spike\ntqq-inject\build\injector.exe}
ActionSuccess : True
```

之后同一个文件又可以运行，未添加任何排除项；这说明“能不能跑”取决于扫描/缓存状态，而不是
代码本身变安全了。这是 manual map / 远程线程类工具的常见启发式误报，也是这条路线必须正面
处理的工程问题：

- 本地 spike 如果再次被拦截，需要用户**显式**把 `spike\ntqq-inject\build` 加入 Defender
  排除项（管理员权限），或在一台专用测试机上运行；
- 发布形态不能要求普通用户关闭杀软。可选方向：代码签名 + 白名单申报、改为 QQ 自身的
  Electron addon/插件装载路径、或把注入器拆成独立可选组件并明确告知风险。
- 不建议、也不会用混淆/加壳去“绕过”杀软；这不是本项目要解决的问题。

## 下一步（尚未执行）

**S1：良性附着 QQ**

- 启动已登录的 QQ，确认目标进程（启动器 `QQ.exe` 还是 `versions\...\QQ.exe`）；
- 仅注入“写管道 + 立即返回”的负载，不 hook、不读写内存、不碰网络；
- 验收：QQ 不崩溃、不闪退、能正常收发一条测试消息；注入器收到管道消息；
- 失败即停止，不进入 S2。

**S2：最小观测点**

- 只读定位一个稳定入口（如登录态或消息回调），先做“观测/计数”，不做修改；
- 版本指纹不匹配时拒绝加载，而不是猜测偏移；
- 任何写操作都需要单独的 ADR 与回滚方案。

在此之前，需要先决定 Defender 排除项或替代装载路径；否则 S1 无法可靠复跑。
装载路径的单独评估见 [docs/design/ntqq-loading-path.md](../../docs/design/ntqq-loading-path.md)：
QQNT 没有官方插件 API，LiteLoader 路线需要绕过文件完整性校验，NapCat 路线是启动注入。

## 安全与合规边界

- 仅用于本机、本人账号、经授权的兼容性研究；不用于批量注册、群发营销、加好友引流。
- 不绕过验证码、安全验证、风控或任何账号保护机制。
- 不读取/上传登录凭证、消息内容或通讯录；本 spike 的负载只写一个固定字符串。
- 注入第三方客户端可能违反其用户协议，并可能导致账号被风控、踢下线或封禁；风险由使用者
  自担。Lodestar 不提供“绝不封号”的保证。
- 不要把这个目录的产物分发给不明确知情的用户。
