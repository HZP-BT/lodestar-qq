# ADR 0002：Core 与适配器的许可证边界

- 状态：Accepted
- 日期：2026-11-11
- 决策者：项目所有者、维护者

## 背景

QQ 协议端生态的许可证差异很大：

- SnowLuma：源码可见**非商业**许可，原生附加组件专有；
- NapCat：限制性许可，非商业，禁止公开发布修改版；
- LLOneBot / LuckyLilliaBot：GPL-2.0；
- LiteLoaderQQNT：MIT，但已归档；
- Lagrange.Core：未声明许可证；
- AstrBot：AGPL-3.0。

Lodestar 要成为真正可长期使用的 OSI 开源项目，Core 不能被这些许可证污染。

## 决策

1. **`@lodestar/core` 及本项目自有代码使用 Apache-2.0。**
2. **适配器与 Core 严格隔离**：
   - 每个适配器独立 package，必要时独立仓库、独立发布；
   - 适配器通过版本化的进程间协议与 Core 通信，不把适配器代码链接进 Core；
   - 适配器的许可证在其 README/package.json 中单独声明。
3. **不打包、不修改分发 SnowLuma、NapCat 等限制性许可证项目。**
   - 用户若要使用它们，需自行安装并遵守其许可证；
   - Lodestar 只通过 OneBot/适配器协议对接，不复制其代码或二进制。
4. **GPL 适配器**（例如基于 LLOneBot 的可选适配器）必须保持 GPL-2.0，并作为独立进程/独立仓库分发；Core 不链接 GPL 代码。
5. **MIT 代码**（例如参考 LiteLoaderQQNT）保留 MIT 声明；不把归档项目作为生产依赖。

## 商用边界

- Core 的 Apache-2.0 允许商业使用、修改与再分发，需保留版权与许可声明，并提供免责声明。
- 适配器可能附加限制（GPL 的 copyleft、第三方的非商业条款等）；商用前必须逐个核对。
- 使用者必须自行遵守 QQ 用户协议、平台规则和当地法律；Lodestar 不提供账号安全担保。

## 后果

- Core 可以独立发展，不受单一后端许可证或 QQ 版本绑定。
- 适配器作者需要自行承担其许可证合规责任。
- 文档必须明确“Bring Your Own Backend”以及各后端的许可证差异。
