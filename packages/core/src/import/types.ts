// 导入框架共享类型：与 OtpEntry 字段子集对齐的解析结果
export interface ParsedEntry {
  type: 'totp' | 'hotp' | 'steam' | 'yandex'
  issuer: string
  label: string
  secret: string
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: number
  period: number
  counter?: number
  note?: string
  /** Yandex（yaotp）的 PIN，可选；仅 type=yandex 时产出 */
  pin?: string
  /** 源格式 group 键映射出的标签名（原始名，仅 trim；无 group 键的格式缺省） */
  tags?: string[]
}

export interface ImportResult {
  entries: ParsedEntry[]
  failures: Array<{ index: number; message: string }>
}

// twoFas/bitwarden/proton/stratum/freeOtp/foxauth：JSON 对象特征可可靠判定的 App 格式；
// andOtp/totpAuthenticator：JSON 数组特征可可靠判定的 App 格式；
// freeOtpLegacy：tokens.xml（XML）特征可可靠判定；
// ente 明文导出为 otpauth URI 行，由 uriBatch 覆盖，不设独立判定
// ImportFormat 联合自 R5 起由 registry.ts 的 IMPORT_FORMAT_ORDER 元组派生（单一注册表，
// 新增格式 = 元组加键 + IMPORT_REGISTRY 加条目，编译期互锁），不再在此手写维护。

// 通用 JSON/JSONL 映射：点路径取值 + 可选 transform
export interface FieldMap {
  path: string
  transform?: 'none' | 'uppercaseSecret'
}

export interface RowMapping {
  type?: FieldMap
  issuer?: FieldMap
  label?: FieldMap
  secret: FieldMap
  algorithm?: FieldMap
  digits?: FieldMap
  period?: FieldMap
  counter?: FieldMap
  note?: FieldMap
  defaults?: Partial<ParsedEntry>
}
