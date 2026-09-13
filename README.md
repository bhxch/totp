# TOTP 验证码工具

纯前端 TOTP 验证码管理：浏览器插件（Chrome/Edge/Firefox）+ Tauri 桌面程序。

- 设计文档：`docs/plans/2026-09-13-totp-tool-design.md`
- 实施计划：`docs/plans/`（按里程碑分计划）

## 开发

```bash
pnpm install
pnpm test          # 全部单测
# 注意：extension 的类型检查依赖 WXT 生成的 .wxt/ 目录（已被 git ignore），
# 需先构建（或先跑 pnpm --filter @totp/extension dev），再执行 pnpm typecheck。
pnpm --filter @totp/extension build   # 插件产物 .output/chrome-mv3
pnpm typecheck     # 类型检查
```

## 结构

- `packages/core` — 纯 TS 核心：base32/HOTP/TOTP/Steam/URI/模型/存储抽象
- `packages/ui` — Vue 3 共享组件
- `apps/extension` — WXT 浏览器插件
- `apps/desktop` — Tauri 2 桌面程序（复用 `packages/ui` 的管理组件）

## 桌面版（Tauri）

```bash
pnpm --filter @totp/desktop tauri dev    # 开发（先起 vite，再编译 Rust）
pnpm --filter @totp/desktop tauri build  # 构建，产物为 exe + NSIS 安装包
```

- 数据位置：`%APPDATA%/com.totp.desktop/vault.json`
- 主窗口：完整条目管理（与插件 options 一致），「失焦自动隐藏」默认关闭，可在窗口顶部勾选开启；「隐藏到托盘」按钮收起窗口
- mini 弹窗：只读验证码列表，复制后自动隐藏；以下三种方式均可弹出/隐藏
  - 托盘图标左键点击
  - 全局快捷键 `Alt+Shift+T`
  - mini 窗失焦自动隐藏（mini 窗固定启用）

## 插件功能（M1）

- 录入：手动（base32 校验）、TOTP/Steam
- 列表：实时验证码 + 倒计时、关键字搜索、按当前站点 URL 过滤（五种匹配策略，条目编辑中配置）
- 管理：编辑/删除（二次确认）、分组管理（options 页）
- options 页：浏览器扩展详情 → 扩展选项
