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

## 导入

导入入口在管理页（桌面主窗口 / 插件 options 页）的「导入」卡；popup 不含导入功能。选择文件后自动嗅探格式，按向导完成解析 → 冲突确认 → 报告。

### 支持格式

- **Aegis**（JSON vault）：明文与口令加密均支持；加密 vault 需输入 Aegis 导出时设置的口令（scrypt + AES-GCM，算法对齐 Aegis 官方实现）
- **WinAuth**（XML 配置文件）：明文、口令保护（条目级/整包，PBKDF2 + Blowfish，对齐官方算法）均支持；使用 Windows DPAPI 加密（用户/机器层）的文件**仅桌面版可导入**（依赖系统凭据解密），插件端遇到会逐条提示「请用桌面版导入」；YubiKey 加密暂不支持
- **otpauth URI 文本**：每行一条 `otpauth://totp/...|hotp/...|steam/...` URI
- **通用 JSON / JSON array / JSONL**：逐字段配置点路径映射（如 `otp.params.secret`）将行对象映射为条目，secret 字段必填；单个 JSON 对象会自动探测其嵌套的行数组。secret 自动去空白并大写，非法 algorithm/digits/period 回落默认值（SHA1/6/30），Steam 条目固定 5 位

### 冲突策略

冲突判定：与现有条目的 issuer + label 相同（忽略大小写与首尾空白）。非冲突条目一律直接新增；冲突条目按所选策略处理：

- **跳过冲突条目**（skip）：保留现有条目，不导入该条
- **覆盖现有条目**（replace）：用导入条目覆盖现有条目（保留其分组与排序位置）
- **保留两者（并存）**（merge）：导入条目照常新增，与现有条目并存

### 失败处理

- 单条解析失败不阻断整体导入：其余条目照常导入，失败条目在报告中逐条列出原因（含行号/条目号）
- 整体解密类失败（如 Aegis 口令错误、文件结构非法）会明确报错，不会写入部分数据

## 安全

### vault 落盘加密

- 默认关闭；在管理页「安全」卡中启用并设置口令，之后 vault 文件以密文落盘（桌面与插件各自独立存储、分别启用）
- 算法与备份 envelope 同级：Argon2id（m=65536, t=3, p=1，随机 16 字节 salt）由口令派生 KEK → KEK 以 AES-256-GCM 包裹随机 32 字节 DEK → DEK 以 AES-256-GCM 加密 vault 明文
- 更换口令仅用新口令重新包裹 DEK（重包裹），数据本身无需重加密，即时完成
- 口令不存储、不上传；口令丢失则已加密数据无法解锁（无后门、无找回手段）

### 解锁语义

- 锁定状态按窗口独立：某个窗口（popup/options/桌面窗口）解锁不影响其他窗口，跨窗口会通过通知感知加密状态变化（明文写前核对盘上状态，防止降级覆盖密文）
- 页面关闭即锁定：下次打开需重新输入口令
- mini 弹窗不支持输入口令，vault 锁定时显示「加密启用后迷你窗不可用，请在主窗口解锁使用」（DEK 不跨窗口，主窗解锁后 mini 也不持有 DEK）

### 剪贴板自动清空

- 复制验证码后 30 秒自动清空剪贴板，可在「安全」卡中关闭
- 插件端在 Chrome/Edge 上经 background（alarms + offscreen）执行，popup 提前关闭也能清空；Firefox 暂不支持自动清空

### 密钥遮蔽

- 录入/编辑表单中 secret 输入框默认以密码形态遮蔽，点右侧按钮可临时明文查看

## 图标

条目可配置品牌图标，列表头像与录入表单展示；四种来源，均在录入/编辑表单的「图标」区设置。

### 内置图标集

- Simple Icons 精选 **111 项**（CC0、单色 SVG），覆盖开发/云/社区/国内服务/支付/游戏/安全等常见 2FA 发行方；由 `scripts/gen-builtin-icons.mjs` 从 simple-icons 包提取生成（`packages/core/src/icons/builtin.json`）
- 商标下架说明：上游 Simple Icons 会应商标方要求不定期移除部分品牌图标，内置集只能收录当期包内仍在收录的图标；已下架或未收录的品牌，请用图标包导入/上传/URL 引用补足
- issuer 关键词推荐：录入时输入发行方名称自动匹配（归一化忽略大小写与空白、`.`、`-`、`_`，另含 59 条别名，支持中文如「微信」「B站」「战网」）；命中且未手动选图标时显示推荐气泡，点击即用

### 图标包导入

- 支持 aegis-icons 社区包及同构 zip 包：任意目录层级下的 `.png` 均会导入，**文件名（去扩展名）即服务名**，与条目 issuer 归一化后匹配
- 限制：单个文件超过 50KB 跳过；最多导入 500 个；同名（归一化后）图标后者覆盖前者
- 入口：录入/编辑表单的「图标」区点「导入图标包（zip）」选择 zip 文件；导入后需在条目编辑中手动选择对应图标（包导入只入库，不自动绑定到条目）

### 用户上传

- 任意图片自动等比缩放至长边 ≤128px（不放大），转 PNG 存储

### URL 引用

- 填入图片 URL 后立即拉取并缓存为本地副本（缓存键 `url:<id>`）
- URL 拉取上限 200KB，超限视为失败；拉取失败（网络不通、非 2xx、站点不允许跨域 CORS）会明确报错，修正 URL 后可重试；缓存丢失（如清空存储、换设备）时列表回退首字母占位，可在编辑表单重新拉取

### 存储位置

- 图标统一以 dataUrl 存于 `'icons'` 键（id→dataUrl 映射），与 vault 各自独立
- 浏览器插件：`chrome.storage.local`，已声明 `unlimitedStorage` 权限，不受 10MB 默认配额限制；popup 与 options 共享同一份数据
- 桌面：与 vault 同目录 `%APPDATA%/com.totp.desktop/`

## 插件功能（M1）

- 录入：手动（base32 校验）、TOTP/Steam
- 列表：实时验证码 + 倒计时、关键字搜索、按当前站点 URL 过滤（五种匹配策略，条目编辑中配置）
- 管理：编辑/删除（二次确认）、分组管理（options 页）
- options 页：浏览器扩展详情 → 扩展选项
