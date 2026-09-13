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
- 主窗口：完整条目管理（与插件 options 一致），「失焦自动隐藏」默认关闭，可在窗口顶部勾选开启；「隐藏到托盘」按钮收起窗口；主窗口点 X 收起到托盘；彻底退出请用托盘右键菜单 → 退出
- mini 弹窗：只读验证码列表，复制后自动隐藏；以下三种方式均可弹出/隐藏
  - 托盘图标左键点击
  - 全局快捷键 `Alt+Shift+T`
  - mini 窗失焦自动隐藏（mini 窗固定启用）

## 备份

备份入口在管理页（桌面主窗口 / 插件 options 页）的「备份」卡；popup 不含备份功能。

### 加密格式（envelope v1）

- 备份文件为 JSON 文本，扩展名 `.totpbackup`，结构：`v`、`kdf`、`wrapNonce`、`wrappedDek`、`dataNonce`、`ciphertext`
- 加密流程：Argon2id（m=65536, t=3, p=1，随机 16 字节 salt）由口令派生 KEK → KEK 以 AES-256-GCM 包裹随机 32 字节 DEK → DEK 以 AES-256-GCM 加密 vault 明文（wrap/data 两段 nonce 各自独立随机）
- 口令错误或文件损坏时解密失败并明确报错，不会输出错误数据

### 桌面本地备份

- 目录：`%APPDATA%/com.totp.desktop/backups/`，写入为临时文件 + 重命名的原子写
- 两种模式（偏好持久化，可在卡内切换）：
  - 保留 N 份：按 `vault-日期-时间.totpbackup` 命名，滚动删除超出 N 的最旧备份
  - 覆盖：固定写入 `vault-backup.totpbackup`
- 恢复：卡内备份列表（新在前）选择一份，输入口令解密，两步确认后整体替换当前 vault

### 导出 / 导入文件

- 桌面：系统对话框选择保存/打开路径（`.totpbackup` 过滤器）
- 插件：浏览器下载保存 / 文件选择器导入

### 口令自管

- 备份口令不存储、不上传，仅用于本地加解密；无任何云端同步
- 口令丢失则备份无法恢复（无后门、无找回手段），请自行妥善保管

## 插件功能（M1）

- 录入：手动（base32 校验）、TOTP/Steam
- 列表：实时验证码 + 倒计时、关键字搜索、按当前站点 URL 过滤（五种匹配策略，条目编辑中配置）
- 管理：编辑/删除（二次确认）、分组管理（options 页）
- options 页：浏览器扩展详情 → 扩展选项
