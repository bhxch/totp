# TOTP 验证码工具

纯前端 TOTP 验证码管理：浏览器插件（Chrome/Edge/Firefox）+ Tauri 桌面程序。

- 设计文档：`docs/plans/2026-09-13-totp-tool-design.md`
- 实施计划：`docs/plans/`（按里程碑分计划）

## 开发

```bash
pnpm install
pnpm test          # 全部单测
pnpm typecheck     # 类型检查
pnpm --filter @totp/extension build   # 插件产物 .output/chrome-mv3
```

## 结构

- `packages/core` — 纯 TS 核心：base32/HOTP/TOTP/Steam/URI/模型/存储抽象
- `packages/ui` — Vue 3 共享组件
- `apps/extension` — WXT 浏览器插件
