# TOTP 验证码工具设计文档

日期：2026-09-13
状态：设计已经用户逐节确认

## 1. 概述

纯前端 TOTP 验证码工具，一个 monorepo 出两种产物：

1. **浏览器插件**：Chrome / Edge / Firefox 三端兼容
2. **Tauri 桌面程序**：托盘常驻 + 快捷键唤出的轻量桌面应用

核心能力：RFC 6238 标准 TOTP / RFC 4226 HOTP、Steam 专用算法、Aegis 风格的分组/排序/录入体验、对齐 Aegis 全量导入格式、通用 JSON/JSONL 导入（自定义键值映射）、AES-256-GCM 加密备份与多后端同步、图标包与关键词自动推荐。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 技术栈 | Vue 3 + TypeScript + Vite；核心逻辑抽成框架无关纯 TS 包 |
| 加密算法 | AES-256-GCM（WebCrypto）+ Argon2id（hash-wasm）；不存在 AES-512，以 256 位为上限 |
| 插件 URL 过滤交互 | 匹配过滤 + 点击复制 + otpauth 链接处理（不做自动填充页面表单） |
| 桌面形态 | 托盘常驻 + 弹出小窗、全局快捷键、失焦自动隐藏 |
| 二维码录入 | 图片/粘贴截图解码 + 粘贴 otpauth URI 文本（摄像头实时扫码、屏幕选区扫码不在第一版） |
| 浏览器同步 | 默认走浏览器自带同步（加密分片），超限后切云后端；同步内容一律密文 |
| 导入范围 | 对齐 Aegis 源码全部 19 种 importer，另加通用 JSON/JSONL 自定义映射 |

## 3. 总体架构与仓库结构

pnpm monorepo：

```
totp/
├── packages/
│   ├── core/        # 纯 TS，零框架依赖，可在 Node/浏览器/Tauri 运行，全部单测
│   └── ui/          # Vue 3 共享界面组件
├── apps/
│   ├── extension/   # 浏览器插件壳（WXT）
│   └── desktop/     # Tauri 2 桌面壳
├── docs/
└── pnpm-workspace.yaml
```

### packages/core

- **OTP 引擎**：RFC 4226 HOTP、RFC 6238 TOTP（SHA-1/256/512、6–8 位、自定义 period）、Steam 算法（自定义 base32 字母表 5 字符）、otpauth:// URI 解析与生成
- **领域模型**：条目/分组/排序/图标，对齐 Aegis 字段（含高级选项）
- **加密**：Argon2id + AES-256-GCM，密钥分层（见第 7 节）
- **导入导出**：19 种格式 + 通用映射引擎
- **匹配引擎**：五种 URL 匹配策略（基础域名/主机/精确/前缀/正则）
- **存储与同步**：StorageAdapter 抽象 + 云后端适配器（纯 fetch）

### packages/ui

插件 popup、插件 options、桌面主窗口共用同一组 Vue 组件（条目列表、搜索、分组、录入表单、导入向导、图标管理、设置）。

### 工具链

pnpm workspace、Vite、WXT（插件）、Tauri 2（桌面）、Vitest（测试）、Playwright（产物冒烟）。

构建产物：Chrome/Edge MV3 zip、Firefox zip、Tauri 安装包（Windows 优先）。

## 4. 数据模型与存储

### 核心条目模型

```ts
interface OtpEntry {
  uuid: string
  type: 'totp' | 'hotp' | 'steam'
  issuer: string            // 服务名，如 GitHub
  label: string             // 账户名，如 me@example.com
  secret: string            // base32
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: 6 | 7 | 8
  period: number            // 秒，默认 30
  counter?: number          // HOTP 专用
  note?: string
  icon?: IconRef            // 见第 8 节
  groups: string[]          // 分组 id，支持多分组
  matchRules?: MatchRule[]  // 插件 URL 匹配规则，桌面版忽略
  order: number             // 手动排序
  createdAt: number
  usedAt?: number
  // Aegis 扩展字段透传保存
}
```

### 存储分层

| 层 | 浏览器插件 | Tauri 桌面版 |
|---|---|---|
| 条目/设置 | `chrome.storage.local`（WXT 统一 API） | 应用数据目录 `vault.json`（Tauri fs） |
| 浏览器同步 | `chrome.storage.sync`（加密分片，见第 6 节） | 不适用 |
| 图标二进制 | IndexedDB | `icons/` 子目录文件 |

设计要点：

1. **写放大控制**：所有写操作经 core 序列化为单个 JSON 快照；先写临时键再原子替换，防半写损坏。
2. **浏览器 sync 配额**：单项 8KB、总量 100KB（Chrome/Firefox 同量级）。同步的是加密 vault 分片，配额内约容 100+ 条典型条目。
3. **vault 本体加密**：见第 7 节密钥分层，vault 数据全程密文落盘（DEK 加密）。

## 5. OTP 引擎

- 纯 TS 实现 HMAC 步骤调用 WebCrypto，无第三方 OTP 依赖
- 测试向量：RFC 4226 / RFC 6238 官方向量 + Steam 已知向量
- `totp(secret, {algorithm, digits, period, t})` / `hotp(secret, counter, ...)` / Steam 变体
- otpauth URI：`otpauth://totp/Issuer:label?secret=..&issuer=..&algorithm=..&digits=..&period=..` 全参数解析与生成；Steam 用 `otpauth://steam/...` 及 issuer=Steam 兼容识别

## 6. 备份与同步

### 加密备份文件格式（自定义 envelope）

```json
{
  "v": 1,
  "kdf": { "alg": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": "..." },
  "wrapNonce": "...",
  "wrappedDek": "...",
  "dataNonce": "...",
  "ciphertext": "..."
}
```

二进制字段均为 base64；AES-GCM 认证标签内嵌于 wrappedDek/ciphertext 尾部（WebCrypto 默认拼接，无独立 mac 字段）；wrapNonce/dataNonce 各自独立随机生成——同一密钥下 GCM nonce 禁止复用。

自描述、带版本号，向后兼容升级。

### 浏览器同步（默认通道）

1. 同步内容 = 完整条目库 + 设置 + 元数据，**全部先加密再入 sync**：vault 经 DEK 加密后按 <8KB 分片写入 `chrome.storage.sync`；云端只见密文
2. **超限策略**：写入前 `getBytesInUse` 估算；预估超限时提示切换云后端；条目增长逼近阈值提前提醒
3. 设置项与元数据同样走加密通道，密钥用户自管

### 云同步后端（超限或主动选择时接管）

WebDAV、S3、OneDrive、Google Drive、GitHub Gist——core 内纯 fetch 适配器，插件与桌面共用。

- **同步成功检查**：上传后回读远端比对内容 hash；状态条显示「上次同步时间 / 成功 / 失败原因」
- **冲突**：本地记录与远端版本号比对，last-write-wins + 本地冲突副本保留
- **密钥自管**：云备份文件固定用口令加密（跨设备可恢复）；口令不存云；可更换（更换后重加密重传）

### 桌面本地备份

备份到本地文件（可选目录），策略可选「保留最近 N 份（自动滚动删除）」或「覆盖单份」。

## 7. 密钥与解锁体系

**密钥分层**：DEK（随机 256 位）加密 vault；KEK 只用于解开 wrapped DEK。

KEK 来源三种，可多绑：

1. **口令 + Argon2id**（默认，跨设备通用）：会话级有效
2. **Passkey + WebAuthn PRF extension**：绑定 Windows Hello/PIN、Touch ID、YubiKey 等本地验证；验证时由认证器**确定性派生** KEK，密钥永不落盘，**本地验证通过即自动解密**。Chrome 118+ / 新版 Firefox / Tauri WebView2 (Windows) 支持
   - 背景：MV3 扩展页面表单无法被浏览器密码管理器自动填充，PRF 是「免输口令 + 高安全」的唯一正解
3. **桌面端 DPAPI / 凭据管理器**：Windows 安全存储包裹 KEK，开机后静默解锁

插件端「记住解锁」选项：non-extractable CryptoKey 存 IndexedDB（浏览器 profile 级保护，设置中标注风险等级）。

云备份恢复时用口令模式解开，再在新设备绑定 passkey/DPAPI。

## 8. 图标系统

图标来源四种，统一 `IconRef` 模型（`{ kind: 'builtin'|'pack'|'custom'|'url', ... }`）：

1. **内置图标**：Simple Icons 精选集（CC0，SVG 单色）+ issuer 关键词/别名映射表（如 `github` / `github.com` / `GitHub Inc.` → GitHub）
2. **图标包**：导入 aegis-icons 社区包（zip，文件名即 issuer 名）及同构包，自动建关键词映射
3. **用户上传**：任意图片自动缩放至 128×128 转存
4. **HTTP URL 引用**：保存链接，首次使用拉取并缓存（IndexedDB / icons 目录），失败回退直链

**自动推荐**：手动录入输入 issuer 时实时按关键词/别名匹配内置与包内图标，气泡一键选用；导入条目时批量套用。

## 9. 导入导出体系

统一导入向导：选文件 → 自动嗅探格式 → 预览解析 →（通用格式）键值映射 → 冲突策略（跳过/合并/替换）→ 逐条结果报告。

### 嗅探

JSON object 看 `db`/`slots` 键判 Aegis；XML 判 WinAuth；JSON array / JSONL 自动区分；裸文本含 `otpauth://` 判 URI 批量。

### 支持清单（对齐 Aegis 源码 19 种）

| 类型 | 格式 | 实现 |
|---|---|---|
| JSON 类 | Aegis（明文/加密 vault）、2FAS、Bitwarden、Ente Auth、andOTP（明文/加密）、Stratum、Proton Authenticator、FreeOTP/FreeOTP+、TOTP Authenticator | 内置 schema + 通用映射兜底 |
| XML/文本类 | WinAuth（明文/口令加密）、Plain text（otpauth URI 列表）、Google Authenticator URI 导出 | 内置解析 |
| SQLite 类 | Authy、Battle.net、Duo、Microsoft Authenticator、Steam、Authenticator Plus、Authenticator Plus | `sql.js`（wasm，按需懒加载），用户 root/adb 取出的 db 文件 |

WinAuth 限制：默认 DPAPI 加密导出仅 Tauri 桌面版支持（Windows CryptUnprotectData）；插件端遇到时明确报错引导改用桌面版。

Aegis 加密 vault：header 内 scrypt/Argon2 参数 + key slot（AES-GCM 包裹主密钥），口令解开 slot 后全量导入，与官方算法兼容。

### 通用导入向导（JSON / JSON array / JSONL / SQLite 通用）

1. **结构定位**：嵌套 JSON 先选择条目数组所在路径（自动探测候选如 `data[].otps`）；JSONL 按行展开；SQLite 选表
2. **字段映射**：每个目标字段（secret/issuer/label/type/digits/period/algorithm/counter/icon…）映射到源数据点路径（如 `otp.params.secret`），常见键名自动预选
3. **映射方案保存复用**：方案命名存储、编辑、删除；下次导入相似文件自动推荐；方案随设置导出可跨设备
4. 预览前 3 条 → 冲突策略 → 逐条成功/失败报告（行号+原因，失败不阻断成功条目）

### 导出

Aegis 明文 JSON（互操作）、加密备份 envelope、明文/加密 WinAuth XML（回导 WinAuth）、otpauth URI 批量文本。

## 10. 浏览器插件形态

WXT 构建，一次实现三店兼容（Chrome/Edge MV3 service worker；Firefox 差异化构建）。

### popup（约 360×640）

- 顶部搜索框（关键字过滤）
- 当前页匹配过滤开关：默认开，按五种匹配策略（基础域名/主机/精确/前缀/正则，Bitwarden 同款）过滤有效条目，无匹配自动回退显示全部
- 条目列表：图标 + issuer + label + 验证码 + 周期倒计时环
- 点击复制验证码后 2 秒自动关闭；HOTP 点击递增；右键/长按菜单（编辑/复制 URI/置顶）

### options 全功能页

与桌面主窗口同一套 UI：录入/分组/排序/导入/同步/图标管理/设置。

### otpauth:// 链接

- Firefox：manifest `protocol_handlers` 原生注册
- Chrome/Edge：**平台不支持扩展注册自定义协议**，替代路径——右键菜单「将选中 URI 添加为条目」+ 粘贴入口兜底

### 权限

`storage`、`clipboardWrite`、`activeTab`（popup 打开时读当前页 URL）；右键菜单按需 `contextMenus`。不申请 `<all_urls>` 全站权限。

## 11. Tauri 桌面形态

- 主窗口 = 全功能页；托盘常驻，左键托盘弹出独立小窗（迷你列表，同 popup 交互）
- 全局快捷键唤出/隐藏小窗（默认 `Alt+Shift+T`，可改）
- 小窗失焦自动隐藏；主窗口可选开关
- 插件：tray-icon、global-shortcut、clipboard-manager、dialog、fs、opener、autostart（可选开机自启）

## 12. 安全

- secret 在列表中默认遮蔽，点击显示；复制后可选 30 秒自动清空剪贴板（默认开）
- 严格 CSP；无遥测；浏览器 sync 与云后端只见密文；口令不落盘
- 依赖最小化：`hash-wasm`（Argon2id）、`jsQR`、`fflate`（zip/图标包）、`sql.js`（懒加载）；TOTP/URI 解析/匹配引擎/云后端全部自写，密码原语用 WebCrypto

## 13. 错误处理

- 导入逐条报告（行号+原因），失败不阻断成功条目
- 同步失败指数退避重试 + 错误分类（网络/认证/配额/冲突）
- 存储防半写（临时键 + 原子替换）；检测损坏时提示从浏览器 sync 密文或最近备份恢复

## 14. 测试策略

- **core 单测（Vitest）**：RFC 4226/6238 官方向量、Steam 向量、Aegis 加密 vault 样例往返、WinAuth 样例、19 种导入格式各一份样例、URI 解析/生成、匹配引擎五策略、Argon2id+AES-GCM 往返、JSON/JSONL 嗅探与映射、passkey PRF 派生（mock 认证器）
- **UI 测试**：录入表单、导入向导映射交互等关键组件（Vue Test Utils）
- **产物冒烟**：`wxt build`（chrome/firefox/mv2/mv3 目标）与 `tauri build` 通过；Playwright 加载插件冒烟（popup 打开、复制动作）

## 15. 分期路线

- **M1 MVP**：core（OTP/Steam/URI/匹配/加密）+ ui 基础 + 插件（popup/options/搜索/URL 过滤/复制）+ 桌面（主窗口/托盘/快捷键/失焦隐藏）+ Aegis/WinAuth/通用 JSON 导入 + 本地备份
- **M2**：19 格式全量导入 + 映射方案保存 + 图标系统完整（内置集/图标包/推荐）+ 浏览器同步加密分片
- **M3**：云同步五后端 + 同步检查/冲突处理 + passkey PRF/DPAPI 解锁 + aegis-icons 包导入
- **Backlog**：整库口令更换流水、HOTP UI 增强、摄像头实时扫码、屏幕选区扫码、自动填充到网页表单
