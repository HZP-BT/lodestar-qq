# Contributing to Lodestar

## 开发环境

- Node.js 22.16+ / 24 / 26
- pnpm 10

```bash
pnpm install
pnpm verify
```

`pnpm verify` 会依次执行 lint、format check、typecheck、test、build。提交 PR 前请确保它通过。

## 代码边界

- `@lodestar/core` 必须保持 Apache-2.0、clean-room。不要复制 SnowLuma、NapCat、Lagrange 等项目的代码；它们的许可证与 Lodestar Core 不兼容。
- 可选适配器放在独立 package（必要时独立仓库），并在 README/package.json 中写明许可证。
- 不要提交真实 QQ 号、Token、Cookie、消息内容或未脱敏日志。

## 提交与 PR

- 一个 PR 聚焦一个模块；大改动先开 Issue 讨论。
- 行为变更必须带测试；对外接口变更必须更新 README/ADR。
- 不要在没有说明的情况下引入新的运行时依赖；新增依赖需解释用途和许可证。
- 不要提交 `dist/`、`node_modules/`、`data/`、日志或 `.env`。

## 安全问题

如果你发现账号凭证、Token 或消息数据可能泄露，请不要公开 Issue；先联系维护者并提供最小复现。
