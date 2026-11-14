# Spike 证据（2026-11-12）

本文件记录当时观察到的输出，不做事后美化。终端输出来自本次会话；`evidence/` 下的
`probe-qq-2026-11-12.txt` 是脚本直接重定向的原始文件。

## 1. 工具链

```text
zig: C:\Users\example\AppData\Local\Microsoft\WinGet\Packages\zig.zig_Microsoft.Winget.Source_8wekyb3d8bbwe\zig-x86_64-windows-0.17.1\zig.exe
0.17.1
```

首次 `zig cc` 曾报 `sub-compilation of libzigc failed ... unable to load "Module.zig": Unexpected`；
用短缓存目录成功编译一次后，默认缓存也恢复正常。未定位根因，暂按一次性缓存/杀软干扰记录。

## 2. 构建产物

当前源码构建：

```text
injector.exe      223744
payload.dll         3072   (-nostdlib, 仅导入 kernel32；无 .tls/.reloc)
target.exe        220160
```

首次功能运行时用的是更早的 `payload.dll`（218,112 字节，带 UCRT/TLS 导入）。之后已把
payload 改为 `-nostdlib` 版本并用 `zig objdump` 核对，但该版本因注入器被 Defender 拦截
而**没有实际运行过**。PDB 与其他中间产物不纳入证据。

## 3. 首次运行（功能通过）

```text
starting benign target...
target pid: 6032
running manual-map injector...
injected at 0000017F71D20000, waiting for pipe...
pipe message: polaris-spike-payload-attached
```

判定：

- 注入器成功在 target 内分配并映射 PE；
- `payload_main` 在 target 进程内执行；
- 负载通过 `\\.\pipe\polaris-spike` 把固定字符串送回注入器。

**当时的缺口**：脚本随后在读取 `$injectorProcess.ExitCode` 时得到空值并抛错，因此没有打印
`PASS` 行，也没有执行“target 仍存活”的断言。已改用 `System.Diagnostics.Process`。

## 3a. 修正 runner 后的完整通过

`run-spike.ps1` 改为直接使用 `System.Diagnostics.Process` + 异步读取输出后：

```text
starting benign target...
target pid: 20992
running manual-map injector...
injected at 000001CBF1100000, waiting for pipe...
pipe message: polaris-spike-payload-attached
PASS: payload executed inside target and signaled via named pipe
runner exit=0
```

随后连续 3 次运行，均为 `PASS`、`exit=0`：

```text
injected at 00000147D19B0000 ... PASS
injected at 0000022581240000 ... PASS
injected at 00000172E3410000 ... PASS
```

累计：`-nostdlib` payload 执行 5 次，4 次通过完整断言（退出码 0 + 管道消息 + target 存活）。
没有做长稳、并发或 Electron target 测试。

## 4. Defender 拦截（间歇）

两次重新构建后立即运行时被拦截：

```text
Start-Process : 无法成功完成操作，因为文件包含病毒或潜在的垃圾软件。
...
+ $injectorProcess = Start-Process -FilePath $injector `
```

Defender 记录：

```text
ThreatName    : Trojan:Win32/Bearfoos.A!ml
SeverityID    : 5
Resources     : {file:_E:\daiti\spike\ntqq-inject\build\injector.exe}
ActionSuccess : True
ThreatStatusID: 1
```

之后同一个 `injector.exe` 又可以执行（见 3a），期间未添加排除项。结论：

- 功能上 manual map 成立；
- Defender 的拦截取决于扫描状态，不能把“能跑”当作稳定属性；
- 在未明确处理排除项/签名/替代装载路径前，不继续 QQ S1。

## 5. QQ 只读探测

见 [evidence/probe-qq-2026-11-12.txt](evidence/probe-qq-2026-11-12.txt)。关键值：

```text
Install = D:\qq
version = 9.9.33.52230
launcher: D:\qq\QQ.exe (1,717,800 bytes, x64)
Folder: 9.9.33-52230
QQNT: 214,599,728 bytes, x64
Main: ./application.asar/app_launcher/index.js
processes: 无 QQ 进程
```

未对 QQ 执行任何注入、读写或 hook。
