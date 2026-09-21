# 设计：FoxAuth 备份导入（验收条目 11）

## 背景与目标

支持从 FoxAuth（Firefox 扩展，GPL-3.0）的备份 JSON 导入条目，作为第 16 种导入格式，
完全对齐现有导入框架模式。

## 格式调研结论（源码：FoxAuth/FoxAuth `src/scripts/import.js`）

导出为整个 storage 快照，顶层白名单字段 `['accountInfos', 'isEncrypted', 'passwordInfo', 'settings', 'dropbox']`：

- `accountInfos`：条目数组，字段 `localIssuer`（发行方）、`localAccountName`（账户名）、
  `localSecretToken`（Base32 secret）、`localOTPType`（`'Time based'` TOTP /
  `'Counter based'` HOTP）、`localOTPDigits`（`'6'`|`'8'`）、`localOTPPeriod`（`'30'`）、
  `localRecovery`。**算法固定 SHA-1，无 algorithm 字段**。
- 加密备份：`isEncrypted: true` 时 `accountInfos` 为密文；口令为
  `passwordInfo.encryptPassword` 的 **Base64 解码值**；加密实现源自 Firefox Send
  （WebCrypto，`src/scripts/encryption/keychain.js`，AES-GCM 封装）。

## 设计

### §1 识别（`packages/core/src/import/sniff.ts`）

对象含 `accountInfos` 数组 + `isEncrypted` 布尔 → `'foxauth'`；
插入判定链（generic 兜底之前），文件头判定顺序注释同步更新。
`ImportFormat` 联合类型加 `'foxauth'`。

### §2 解析器（`packages/core/src/import/jsonApps.ts`，风格对齐 `importTwoFas`）

`importFoxauth(text, password?)`：

| 源字段 | 目标 | 说明 |
|---|---|---|
| `localIssuer` | `issuer` | 缺省空 |
| `localAccountName` | `label` | |
| `localSecretToken` | `secret` | 经 `normalizeSecret` |
| `localOTPType === 'Counter based'` | `hotp` | 否则 `totp` |
| `localOTPDigits` | `digits` | 缺省 6 |
| `localOTPPeriod` | `period` | 缺省 30 |
| （无） | `algorithm` | 恒 SHA1 |

单条错误进 `failures`，不阻断整批（现有 collectEntries 模式）。

### §3 加密分支

`isEncrypted: true` 时需 `password`：Base64 解码 `passwordInfo.encryptPassword` 得口令，
Firefox Send 式 AES-GCM 解密 `accountInfos`。

**前置调查（实现第一步）**：拉取 FoxAuth 源码 `keychain.js`/`MessageEncryption.js`
确认 KDF（PBKDF2 迭代/salt/哈希）与 AES-GCM 参数（IV 位置/tag 长度），在
`docs` 或测试注释中固化参数依据。若参数无法确认（版本漂移等），**降级**：
加密版给出结构级明确报错（同 2FAS `servicesEncrypted` 处理），明文版先行交付。

### §4 接线

- `paste.ts` DISPATCH 表加同步入口（仅明文；加密走导入页口令通道）。
- 导入 UI 格式清单、README 支持格式表更新。
- fixtures：明文样本、加密样本（真实导出或按确认参数构造）、坏数据样本。

## 验收

- 单测：sniff 命中/不误判（如 Authenticator 扩展 JSON 不误入）；TOTP/HOTP 映射；
  digits/period 缺省；加密样本解密后与明文样本同结果；坏 secret 进 failures。
- 与既有格式互斥性回归（现有 sniff 测试全绿）。

## 非目标

- FoxAuth 的 Dropbox 同步配置（`dropbox` 字段）导入。
- 导出为 FoxAuth 格式。
- Authenticator 扩展格式（已有等价路径，不重复）。
