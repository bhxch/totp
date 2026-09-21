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

## 加密参数附录（调查于 2026-09-21）

源码：`FoxAuth/FoxAuth` master @ `65db1142f30340d720ab666d4caedccf9098d8bf`
（`src/scripts/encryption/keychain.js`、`src/scripts/encryption/MessageEncryption.js`、
`src/scripts/accountInfo.js`、`src/scripts/import.js`、`src/scripts/sync.js`）。

**裁定结果：实现解密路径。** 全部参数已从源码固化，并用 Node WebCrypto
按下列参数构造 FoxAuth 风格加密样本后解密回验通过（`ROUNDTRIP_OK=true`，
错误口令如期抛 `OperationError`），可复现。

- 导出文件形态：`sync.js exportBtn` 直接 `JSON.stringify(browser.storage.local.get())`
  全量 dump 为 `Foxauth_export.json`。故加密备份中：
  - `passwordInfo.encryptPassword` = **Base64(UTF-8(口令))**（`savePasswordInfo`
    `base64Encode(nextPassword)`）；`import.js transformOwnJson` 导入时
    `base64Decode` 还原明文口令（`TextDecoder('utf-8')`）。
  - `passwordInfo.encryptIV` = **12 字节数组**（`Array.from(iv)` 存储的数字数组）。
    IV 不在密文内，**必须从该字段读取**；缺失时应结构级报错（对应 FoxAuth
    自身 `import_error_imported_encryptIV`）。
  - `accountInfos` 各条目中仅 `localAccountName` / `localSecretToken` /
    `localRecovery` 三字段为密文；`localIssuer`、`localOTPType`、
    `localOTPDigits`、`localOTPPeriod` 等保持明文（`accountInfo.js
    __encryptAndDecrypt` 字段白名单）。
- 密钥链（`keychain.js` L26-52 + `MessageEncryption.js` L19）：
  - rawSecret = 口令字符串**逐字符 charCode** 的字节序列。FoxAuth 经
    `btoa(password)` → `b64ToArray()` 往返实现（latin1 语义），对含
    U+00FF 以上字符的口令 `btoa` 会抛 `InvalidCharacterError`（FoxAuth 自身
    限制）；我们按 `charCodeAt(i)` 直取即可，latin1 口令下完全一致。
  - `importKey('raw', rawSecret, 'HKDF', false, ['deriveKey'])`。
  - KDF：**HKDF-SHA-256，salt = 空 `Uint8Array`（0 字节），info =
    UTF-8("encryption")，派生 128 bit AES-GCM 密钥**。注意不是 PBKDF2——
    `keychain.js` 中的 PBKDF2 仅用于 Firefox Send 服务端鉴权（`setPassword`
    → HMAC auth header），与备份加密无关。
- 密文（`keychain.js encryptFile/decryptFile` L154-197）：
  - **AES-GCM，`tagLength: 128`，无 AAD**；输出 = ciphertext‖tag（WebCrypto
    默认拼接）。
  - IV = `passwordInfo.encryptIV` 的 12 字节（`Uint8Array.from(...)`，
    `accountInfo.js` L13），**所有条目所有字段复用同一 key+IV**（FoxAuth
    的 GCM IV 复用缺陷，简化了我们的实现，无需记录 per-field nonce）。
  - 编码：**非 Base64**。`MessageEncryption.encrypt` 用 `ab2str`
    （`String.fromCharCode` 逐字节）把密文存为"二进制字符串"，JSON 序列化时
    经 `\uXXXX` 转义；解密侧用 `str2ab`（逐字符 `charCodeAt`）还原字节。
- 解密成功判据：WebCrypto `decrypt` 对 GCM tag 校验通过即逐字段成功；
  口令错误/密文损坏 → `OperationError`。可再以解密出的 `localSecretToken`
  过 `normalizeSecret`+Base32 校验作业务级判据。
- 回验测试向量（Node 24 WebCrypto 实测，可直接作 Task 4 fixture）：
  - 口令 `hunter23`，`encryptPassword = "aHVudGVyMjM="`，
    `encryptIV = [103,22,171,5,240,91,9,77,66,199,34,13]`。
  - 明文 secret `JBSWY3DPEHPK3PXP`（Base32, SHA-1/TOTP，16 字符）→ 密文串
    （逐字符 `charCodeAt` 序，32 字节 = 16 密文 + 16 tag）：
    `08 9e b3 b0 18 2c 9e 0b 2b db 44 2b d4 1e e8 6c ed b3 fe e6 4c 44 2c
    6b 85 11 1e a8 1d e3 a9 70`。
  - 完整样本 JSON 与生成脚本存于 `E:\tmp\cc\foxauth-src\verify-chain.mjs`。

实现要点（供 Task 4）：口令 = `base64Decode(encryptPassword)` 的 UTF-8 明文；
`rawSecret = Uint8Array.from(口令, c => c.charCodeAt(0))`；HKDF-SHA-256(空
salt, info="encryption", 128)；`decrypt({AES-GCM, iv: Uint8Array.from(encryptIV),
tagLength: 128}, key, str2ab(密文串))`；结果 `TextDecoder('utf-8').decode`。
