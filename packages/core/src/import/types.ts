// 导入框架共享类型：与 OtpEntry 字段子集对齐的解析结果
export interface ParsedEntry {
  type: 'totp' | 'hotp' | 'steam'
  issuer: string
  label: string
  secret: string
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  digits: number
  period: number
  counter?: number
  note?: string
}

export interface ImportResult {
  entries: ParsedEntry[]
  failures: Array<{ index: number; message: string }>
}

// twoFas/bitwarden/proton/stratum/freeOtp：JSON 对象特征可可靠判定的 App 格式；
// andOtp/totpAuthenticator：JSON 数组特征可可靠判定的 App 格式；
// freeOtpLegacy：tokens.xml（XML）特征可可靠判定；
// ente 明文导出为 otpauth URI 行，由 uriBatch 覆盖，不设独立判定
export type ImportFormat =
  | 'aegis'
  | 'winauth'
  | 'uriBatch'
  | 'generic'
  | 'twoFas'
  | 'bitwarden'
  | 'proton'
  | 'stratum'
  | 'freeOtp'
  | 'freeOtpLegacy'
  | 'totpAuthenticator'
  | 'andOtp'

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
