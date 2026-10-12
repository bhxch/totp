# 隐私政策（Privacy Policy）

- **适用产品**：浏览器扩展「TOTP 验证码工具」（Microsoft Edge Add-ons 及其他渠道分发的 Chromium / Firefox 版本）
- **生效日期**：2026-10-12 ｜ **版本**：1.0
- **开发者**：bhxch（[github.com/bhxch/totp](https://github.com/bhxch/totp)）

同仓库的桌面应用遵循相同的"本地优先、无遥测"原则；本政策以浏览器扩展为准。

---

## 中文

### 概要

- 我们**不收集**任何个人数据：无遥测、无统计分析、无账号体系、无固定后端服务器。
- 您的所有数据（TOTP 密钥、验证码、设置）仅存储在您自己的设备（浏览器本地存储）中，且经加密保护。
- 唯一的网络传输是您**主动配置**云备份时，将**加密备份**发送到您自己指定的服务端，开发者不经手、无法访问。

### 我们收集什么

本扩展不收集、不传输、不出售任何个人数据。扩展内不含任何遥测、埋点、崩溃上报或广告组件，也不会将您的使用行为报告给开发者或任何第三方。

### 数据的本地存储与加密

- TOTP 密钥、验证码条目与设置保存在浏览器的本地存储（`chrome.storage.local`）中，不出您的设备。
- 库以 AES-GCM 加密，加密密钥由您设置的主密码经 Argon2id / scrypt 派生；开发者不掌握您的主密码，也无法恢复您的数据。
- 扩展支持空闲自动锁定（可配置时长），锁定后需重新输入主密码。

### 云备份（仅您主动配置时）

- 仅当您在扩展设置中自行填写并连接云存储服务（WebDAV、Amazon S3、GitHub Gist、Google Drive、OneDrive，及可选代理）时，扩展才会发起网络请求。
- 上传内容为加密备份信封：数据在离开设备前已加密，您的云服务商与开发者均无法读取其内容。
- 扩展没有开发者控制的固定服务器；所有请求都直接发往您配置的地址。断开云备份即可停止全部对外传输。

### 剪贴板处理

- 您点击复制时，验证码会写入系统剪贴板，并在 **30 秒后自动清除**（以降低被后续程序读取的风险）。剪贴板内容不经过任何网络。

### 扩展权限用途

| 权限 | 用途 |
| --- | --- |
| `storage` / `unlimitedStorage` | 在本地浏览器存储中保存加密库与设置 |
| `clipboardWrite` | 复制验证码到剪贴板，30 秒后自动清除 |
| `clipboardRead` | 在手动导入表单中一键读取您剪贴板里的 otpauth 链接（仅在您主动操作时读取） |
| `activeTab` | 仅用于右键菜单「识别图片中的 otpauth 二维码」：图片字节在本地解码 |
| `contextMenus` | 提供上述右键菜单项 |
| `alarms` | 由后台调度剪贴板 30 秒自动清除等定时任务 |
| `notifications` | 本地通知（如剪贴板已清除、云备份结果），无远程推送 |
| `idle` | 按您配置的空闲时长自动锁定密码库 |
| `offscreen` | Chrome MV3 后台无 DOM，需离屏文档承载剪贴板写入/清除 |
| `host_permissions`（http/https） | 仅用于您自行配置的云备份端点直连；无固定后端，默认不出网 |

### 数据共享与出售

我们不出售、不出租、不以任何方式向第三方共享您的数据，唯一例外是您自行配置的云备份端点（内容为加密信封，且属于您与自己服务商之间的存储行为）。

### 儿童隐私

本扩展不面向儿童，也不有意收集任何用户的个人信息（包括儿童）。

### 政策变更

本政策的任何修订都会记录在本仓库（[docs/PRIVACY.md](./PRIVACY.md)）的提交历史中，并在本页更新版本号与生效日期。

### 联系我们

如有隐私相关问题，请通过 GitHub Issues 联系：<https://github.com/bhxch/totp/issues>

---

## English

### Summary

- We **do not collect** any personal data: no telemetry, no analytics, no accounts, no backend servers.
- All your data (TOTP secrets, codes, settings) stays on your own device (browser local storage) and is encrypted.
- The only network traffic is **encrypted backups** that **you** explicitly configure to be sent to **your own** cloud storage endpoints. The developer never sees or stores your data.

### What we collect

This extension collects, transmits, and sells nothing. It contains no telemetry, tracking, crash reporting, or advertising components, and never reports your usage to the developer or any third party.

### Local storage & encryption

- TOTP secrets, entries, and settings are stored in your browser's local storage (`chrome.storage.local`) and never leave your device.
- The vault is encrypted with AES-GCM; the encryption key is derived from your master password via Argon2id / scrypt. The developer does not know your master password and cannot recover your data.
- The vault auto-locks after a user-configured idle period and requires the master password again.

### Cloud backup (only when you configure it)

- Network requests are made **only** when you configure a cloud storage service in the extension settings (WebDAV, Amazon S3, GitHub Gist, Google Drive, OneDrive, plus an optional proxy).
- What is uploaded is an encrypted backup envelope: data is encrypted before it leaves your device, so neither your cloud provider nor the developer can read it.
- The extension has no developer-controlled server; requests go directly to the endpoints you configured. Disconnecting cloud backup stops all outbound traffic.

### Clipboard handling

- When you copy a code, it is placed on the system clipboard and **automatically cleared after 30 seconds** to reduce the risk of it being read by other programs. Clipboard contents never travel over the network.

### Extension permissions

| Permission | Purpose |
| --- | --- |
| `storage` / `unlimitedStorage` | Store the encrypted vault and settings in local browser storage |
| `clipboardWrite` | Copy codes to the clipboard and auto-clear them after 30 seconds |
| `clipboardRead` | One-click import of an otpauth URI from your clipboard in the manual-import form (read only on your explicit action) |
| `activeTab` | Only for the context-menu action "recognize otpauth QR code in image": image bytes are decoded locally |
| `contextMenus` | Provides that context-menu item |
| `alarms` | Schedules the 30-second clipboard auto-clear and similar timed tasks from the service worker |
| `notifications` | Local notifications (e.g. clipboard cleared, cloud backup results); no remote push |
| `idle` | Auto-lock the vault after a user-configured idle period |
| `offscreen` | Chrome MV3 service workers have no DOM; an offscreen document hosts clipboard write/clear |
| `host_permissions` (http/https) | Only for direct connections to the cloud backup endpoints you configure yourself; no fixed backend, no traffic by default |

### Data sharing & sale

We never sell, rent, or share your data with third parties. The sole exception is the cloud backup endpoint you configure yourself (the payload is an encrypted envelope, and the storage is between you and your own provider).

### Children's privacy

This extension is not directed at children and does not knowingly collect personal information from any user, including children.

### Changes to this policy

Any revision is recorded in the commit history of this repository ([docs/PRIVACY.md](./PRIVACY.md)), with the version and effective date updated on this page.

### Contact

For privacy questions, reach us via GitHub Issues: <https://github.com/bhxch/totp/issues>
