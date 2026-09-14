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

## 浏览器同步（扩展端）

仅插件端支持：借 Chrome 账号经 `chrome.storage.sync` 在登录同一账号的浏览器之间同步数据（桌面版无此功能）。开关在插件 options 页的「浏览器同步」卡，**默认关闭**，需显式开启；卡内状态条显示上次同步时间/状态。

- 同步内容：vault 全量 + 应用设置。vault 落盘加密已启用时，同步的是 AES-256-GCM 密文（与「安全」卡加密同一形态）；未启用时同步明文 JSON（与本地一致的信任模型，建议先启用加密）
- 分片机制：vault 按 UTF-8 字节切成每片 5500 字节原始数据的分片（键名 `sync:v1:序号/总数`，每片独立 base64），编码后约 7.4KB，低于同步区单键 8KB 上限；设置明文整份同步（仅 blurHide 等偏好项，不含 secret）
- 冲突策略：简单 LWW——每次推送 revision 单调 +1，仅当远端 revision 更新时拉取应用；本地每次数据变更即推送，同步区有变化即拉取；开关位按设备独立，不会被其他设备改写
- 超限行为：同步区总配额约 100KB，占用超 90% 时状态条提示「同步空间已满——建议配置云备份后关闭浏览器同步」
- 加密态换设备：新设备同步到的是密文，需输入**同一口令**解锁后才能查看/使用；口令不存储在同步通道中，丢失则无法解锁
- 浏览器支持：以 Chrome/Edge 为主验证；Firefox 的 storage.sync 配额与行为不同，未全面验证

## 云同步（Cloud）

通过自备的网盘/对象存储在多设备间同步数据。入口在管理页（桌面主窗口 / 插件 options 页）的「云同步」卡；popup 不含云同步。云端固定一个对象，内容为加密备份 envelope（`totp-backup.totpbackup`）。

### 支持后端（五选一）

| 后端 | 凭据（均为手动粘贴，自备） |
| --- | --- |
| WebDAV | 服务器地址 + 用户名 + 应用密码（坚果云等） |
| S3 兼容 | Region + Bucket + AccessKeyId + SecretAccessKey；Endpoint 可选（如 MinIO `http://localhost:9000`），填了走 path-style；Key 前缀可选 |
| Google Drive | OAuth Access Token（文件 id 首次推送自动创建并回存凭据） |
| OneDrive | Microsoft Graph Access Token（写入云盘根目录下同名文件） |
| GitHub Gist | GitHub Token + Gist ID（建议使用 secret gist，避免备份内容暴露在公开页） |

- S3 上传为纯 fetch 实现的 AWS Signature V4 签名（无 SDK 依赖），兼容 MinIO 等自托管服务
- 凭据仅存本地（桌面：`%APPDATA%/com.totp.desktop/` 下本地 JSON；插件：`chrome.storage.local`，不进浏览器同步区），随代码一起落地的只有你手动粘贴的内容；token 过期需自行重新获取粘贴
- 自建 WebDAV/S3（MinIO）服务需允许跨域（CORS），否则插件端请求会被浏览器拦截

### 加密与口令

- 云端对象与「备份」同一加密形态（envelope v1：Argon2id 派生 KEK → AES-256-GCM 包裹 DEK → 加密 vault），服务器上永远只有密文
- 同步口令即备份加密口令，卡内每次输入、不保存不上传；口令丢失则云端备份无法解开（无后门、无找回手段）

### 同步语义

- 每次同步先回读云端对象：内容 SHA-256 与本地记录的上次基线（cloudRev）一致则提示「云端已是最新」，不重复写入；不一致再按口令解密远端
- 冲突（云端与本地基线不同）：以云端为准覆盖本地（LWW，远端胜），覆盖前先把本地数据保存为冲突副本——桌面写入备份目录 `conflict-日期-时间.totpbackup`（不参与滚动删除，可从「备份」卡列表恢复）；插件端保存为下载文件
- 远端内容用当前口令解不开（口令不一致/结构损坏）时直接报错，不做任何写入，本地数据不受影响
- 采用云端数据前有明确提示与两步确认；确认后云端数据整体替换当前 vault

## 导入

导入入口在管理页（桌面主窗口 / 插件 options 页）的「导入」卡；popup 不含导入功能。选择文件后自动嗅探格式，按向导完成解析 → 冲突确认 → 报告；识别失败或误判时可在格式下拉中手动指定。各格式字段口径对齐 Aegis 官方导入器实现（beemdevelopment/Aegis）。

### 支持格式

**文本格式（桌面与插件均可导入）**

- **Aegis**（JSON vault）：明文与口令加密均支持；加密 vault 需输入 Aegis 导出时设置的口令（scrypt + AES-GCM，算法对齐 Aegis 官方实现）
- **WinAuth**（XML 配置文件）：明文、口令保护（条目级/整包，PBKDF2 + Blowfish，对齐官方算法）均支持；使用 Windows DPAPI 加密（用户/机器层）的文件**仅桌面版可导入**（依赖系统凭据解密），插件端遇到会逐条提示「请用桌面版导入」；YubiKey 加密暂不支持
- **2FAS**（JSON 导出）：明文支持（TOTP/HOTP/Steam）；加密导出（servicesEncrypted）不支持，会提示改用不加密导出
- **Bitwarden**（JSON 导出）：明文支持，`login.totp` 接受 otpauth URI / `steam://` / 裸 base32 secret 三种形态；密码保护导出（encrypted）不支持，会提示改用明文导出
- **Ente Auth**：明文导出即 otpauth URI 行文本，与「URI 文本」同一入口；加密导出不支持，请在应用内改用明文导出
- **Proton Authenticator**（JSON 导出）：明文支持（条目 uri 为 otpauth:// 或 steam://）；加密导出不支持，会提示改用明文导出
- **Stratum / Authenticator Pro**（JSON 导出）：明文支持（大写键 schema，HOTP/TOTP/Steam）；二进制加密导出不支持
- **FreeOTP+**（JSON 导出）与**旧版 FreeOTP**（shared_prefs tokens.xml）：均支持；secret 按字节数组还原，HOTP counter 沿用存储值（对齐 Aegis 口径）
- **TOTP Authenticator**：明文 JSON 数组与外部分享文件（Base64 密文）均支持；分享文件默认口令 `TotpAuthenticator`，改过口令的在口令页输入
- **andOTP**（JSON 导出）：明文支持；加密备份（二进制）暂不支持，请用明文导出
- **Authy**（shared_prefs XML）：明文与口令加密条目均支持；含加密条目时需输入 Authy 备份口令（PBKDF2 + AES-CBC）
- **Battle.net**（shared_prefs XML）：XOR 掩码还原，单文件单条目（8 位 TOTP）
- **Duo**（files/duokit/accounts.json）：JSON 数组，含 counter 的条目按 HOTP 导入
- **Microsoft Authenticator**（SQLite db）：`accounts` 表，普通条目 6 位、Microsoft 型 8 位 TOTP
- **Google Authenticator / otpauth URI 文本**：每行一条 `otpauth://totp/...|hotp/...|steam/...` URI（多数应用的 URI/迁移文本导出均走此入口）
- **通用 JSON / JSON array / JSONL**：逐字段配置点路径映射（如 `otp.params.secret`）将行对象映射为条目，secret 字段必填；单个 JSON 对象会自动探测其嵌套的行数组。secret 自动去空白并大写，非法 algorithm/digits/period 回落默认值（SHA1/6/30），Steam 条目固定 5 位。映射方案可命名保存、复用与删除：再次导入同结构文件时按列名匹配自动推荐，也可手动套用

**SQLite 数据库（桌面与插件均可导入，需联网）**

- 来源设备数据库文件（应用私有目录的 db，经系统备份/adb 等方式取出）：先按 SQLite 文件头校验，再在 sqlite_master 中按已知表名探测并解析（当前识别 Microsoft Authenticator 的 `accounts` 表）
- 解析经 sql.js 完成，其 wasm 二进制固定从 jsdelivr CDN 加载，**首次使用需联网**；离线时明确报错，SQLite 类导入不可用

**暂不支持**

- **Authenticator Plus**：备份为口令加密 ZIP，无法解密；请在原应用中导出为 otpauth URI 明文文本，再用「URI 文本」入口导入
- **Google Authenticator 旧版 SQLite 数据库**（≤5000100 版本）：需 root 提取应用私有目录数据库，暂不支持
- **Steam Android 客户端**：Steamguard-*.json 暂不支持；Steam 令牌可经 WinAuth 导入

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
- 更换口令仅用新口令重新包裹 DEK（重包裹），数据本身无需重加密，即时完成；已绑定的 Passkey/Windows 自动解锁来源不受影响
- 口令不存储、不上传；口令丢失则已加密数据无法解锁（无后门、无找回手段）

### 解锁方式

vault 加密支持多种解锁来源（KEK 来源）并存，在管理页「安全」卡的「解锁方式」区管理；任意一种成功即可解锁：

- **口令（默认）**：启用加密时的唯一方式，也是其他方式的兜底
- **Passkey 解锁（PRF 扩展）**：
  - 在「安全」卡绑定 Passkey 后，锁定页出现「使用 Passkey 解锁」按钮：本地验证（指纹/PIN 弹窗）通过后由 passkey PRF 扩展输出直接派生密钥解出 DEK，自动完成解锁，全程无需口令
  - PRF 输出仅在本机求值，不外传；绑定信息（凭据 id + 盐 + 包裹后的 DEK）存本地
  - 浏览器支持面：Chrome/Edge 与桌面版（WebView2）可用；Firefox 扩展页面的 PRF 支持有限，探测不支持时「添加 Passkey 解锁」入口自动隐藏并提示
  - 绑定过程会连续弹出两次认证器窗口（注册 + 求值确认），属预期行为
  - 可绑定多个 Passkey（列表逐个管理）
- **Windows 自动解锁（DPAPI，仅桌面版）**：
  - 启用后 DEK 以 Windows DPAPI（当前用户）包裹落盘；桌面版锁定页打开时静默尝试自动解锁，开机后无需任何输入直接进入
  - 换 Windows 账户或换机器后 DPAPI 解不开属预期：静默失败并回落到口令/Passkey 手动解锁，不报错不打断
  - 插件端不提供此方式
- **移除守护**：任一解锁方式均可移除，但至少保留一种——全部移除会被拒绝
- **换设备**：Passkey/DPAPI 绑定只存本机，不随浏览器同步或云同步走。新设备同步到密文数据后，需先用口令解锁，再重新绑定其他解锁方式
- **真机冒烟建议**：发布前建议在真实环境验证——用真实认证器（Windows Hello / YubiKey / 手机通行密钥）走一遍绑定与解锁闭环；桌面版验证重启后 DPAPI 静默解锁与换账户回落；Firefox 下确认 Passkey 入口按预期隐藏

### 解锁语义

- 锁定状态按窗口独立：某个窗口（popup/options/桌面窗口）解锁不影响其他窗口，跨窗口会通过通知感知加密状态变化（明文写前核对盘上状态，防止降级覆盖密文）
- 页面关闭即锁定：下次打开需重新解锁（口令或已绑定的 Passkey/Windows 自动解锁）
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
