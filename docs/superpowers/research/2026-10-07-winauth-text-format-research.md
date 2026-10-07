# WinAuth 文本导出格式对照调研（P2 粘贴导入依据落库）

- 日期：2026-10-07
- 类型：格式调研记录（补录性质——2026-10-06 P2 实施时依据的官方源码对照未落库，本档补齐可追溯性，对应审查项 R4-M3）
- 对照对象：winauth/winauth 官方仓库 master 分支源码（C# WinForms）
- 结论已落地于：`packages/core/src/import/uriBatch.ts`（# 注释行、`?` 前未编码 `#`、Steam 行重建）、`packages/core/src/import/steamGuard.ts` / `registry.ts`（SDA JSON 直解）

## 1. 导出文本格式（ExportAuthenticators）

- 官方导出入口：`WinAuth/WinAuthHelper.cs` L771-837 `ExportAuthenticators`——逐条目写出 **仅 ToUrl 行**（每行一个 `otpauth://` URI），**不产生 `#` 注释行**。README 中 `#` 容错是**导入侧**的宽容行为（兼容手工整理文本），非官方导出器产物（R4-M4 措辞收窄依据）。

## 2. ToUrl 行格式（WinAuthAuthenticator.cs L745-760）

- 普通 TOTP/HOTP：标准 `otpauth://totp/<label>?secret=...&digits=...&period=...` 形态。
- label 经 `UrlPathEncode` 编码，**不编码 `#`**（L760）——即 label 含 `#` 时 URI 中出现裸 `#`，会被按 fragment 截断。导入侧在 `?` 前把 `#` 还原为 `%23` 再解析（`uriBatch.ts` 实现依据）。
- **Steam 条目**：scheme 仍为 `totp`，形如 `otpauth://totp/Steam:<account>?secret=<base32>&digits=5&deviceid=<id>&data=<UrlEncode(SteamGuard JSON)>`。特征 = query **同时含 `deviceid` 与 `data`**；`data` 参数即完整 SteamGuard（SDA）JSON，可用于重建 steam 条目（`uriBatch.ts` Steam 行重建依据，审查项 R4-I1）。

## 3. 无口令导出 txt 的行结构（WinAuthHelper.cs）

- L579：允许 `#` 开头注释行，解析时跳过（导入侧同款容错）。
- L585-589：`?` 前未编码 `#` 的处理——与 §2 L760 的 ToUrl 行为互逆（导入侧还原逻辑依据）。

## 4. SDA（SteamGuard）maFile 字段口径（AddSteamAuthenticator.cs）

- L497-511 / L541-563：`serial_number`、`device_id` 等字段一律 `Value<string>()` 读取——**数字形态也接受**（JToken 宽松转换）。导入侧 `registry.ts` sniffSteamGuard 与 `steamGuard.ts` label 回退因此兼容 `string | number`（R4-M1 修复依据）。

## 5. 与实现的对齐清单

| 官方行为 | 源码位置 | 实现落点 |
| --- | --- | --- |
| 导出仅 ToUrl 行、无注释行 | WinAuthHelper.cs:771-837 | README 措辞（导入侧容错口径） |
| `#` 注释行跳过 | WinAuthHelper.cs:579 | uriBatch.ts 行预处理 |
| `?` 前裸 `#` 还原 `%23` | WinAuthHelper.cs:585-589 / WinAuthAuthenticator.cs:760 | uriBatch.ts 行预处理 |
| Steam 行 = totp scheme + deviceid+data | WinAuthAuthenticator.cs:745-760 | uriBatch.ts Steam 行重建（data→importSteamGuard） |
| 字段数字宽收 | AddSteamAuthenticator.cs:497-511,541-563 | registry.ts sniff / steamGuard.ts asText 归一 |

> 注：本档为事后补录，行号以调研时 master 分支为准；后续若官方仓库大幅重构，以重新核对为准。
