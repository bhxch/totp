import { base32Decode, base32Encode } from '../encoding/base32'
import { base64ToBytes } from '../crypto/aesgcm'
import { hexToBytes } from '../encoding/hex'
import {
  asObject, collectEntries, normalizeAlgorithm, normalizeSecret, steamEntry,
  toNonNegativeNumber, toPositiveNumber,
} from './normalize'
import type { ImportResult, ParsedEntry } from './types'

// 其余 JSON/XML/Binary 类 App 导出格式导入（FreeOTP+ / 旧版 FreeOTP / TOTP Authenticator / andOTP）。
// 每个格式的字段口径以 Aegis 官方 Importer 源码为准（beemdevelopment/Aegis master）：
// - importers/FreeOtpPlusImporter.java（tokens 数组复用 FreeOtpImporter.DecryptedStateV1）
// - importers/FreeOtpImporter.java（旧版 readV1 读 shared_prefs/tokens.xml，每条 <string> 值为 Gson token JSON）
// - importers/TotpAuthenticatorImporter.java（外部分享 = Base64(AES-CBC)；条目 {base, key, name, issuer}）
// - importers/AndOtpImporter.java（明文 = 顶层 JSON 数组）
// 错误契约与 jsonApps.ts 一致：结构级错误 throw；单条损坏进 failures 不阻断。

// ---------- 共享辅助（多数已迁出至 ./normalize） ----------

function isBase32(raw: string): boolean {
  try {
    return base32Decode(raw).length > 0
  } catch {
    return false
  }
}

// ---------- FreeOTP+ / 旧版 FreeOTP 共用条目转换（FreeOtpImporter.java DecryptedStateV1.convertEntry） ----------
// 源码口径：
// - secret = toBytes(obj.getJSONArray("secret"))：有符号字节数组（Gson byte[]），(byte)getInt(i) 取低 8 位；
//   简报猜测的「params 池索引 / secret 为 base64」与源码不符（Aegis master 与 FreeOTPPlus 导出源码均无池），
//   研究结论见 .superpowers/sdd/2026-09-14-plan8-import-full/task-2-report.md 差异清单
// - type = getString("type").toLowerCase()（必需）；"totp" → period=optInt("period",30)；
//   "hotp" → counter=getLong("counter")（必需，Aegis 原样入库，FreeOTP 存储值比"下一个计数器"小 1，
//   官方测试 DatabaseImporterTest.checkImportedFreeOtpEntriesV1 注释 "FreeOTP adds -1 to the counter"）
// - algo = optString("algo", "SHA1")、digits = optInt("digits", 6)（2025-04 提交补的 null 回退）
// - issuer = getString("issuerExt")（必需）；label = optString("label")（缺省 ''）
// - issuerExt === "Steam" 且 totp → SteamInfo（本仓库口径 digits=5）

/** Gson byte[] → 字节；非数组/元素非法返回 null；空数组视为缺少 secret */
function freeOtpSecretBytes(raw: unknown): Uint8Array | null {
  if (!Array.isArray(raw)) return null
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    const n = Number(raw[i])
    if (!Number.isInteger(n) || n < -128 || n > 255) return null
    out[i] = n & 0xff // Java (byte) 截断：-19 → 0xED
  }
  return out
}

function convertFreeOtpEntry(obj: Record<string, unknown>): ParsedEntry | { error: string } {
  const issuer = typeof obj.issuerExt === 'string' ? obj.issuerExt : null
  if (issuer === null) return { error: '缺少 issuerExt' }

  const secretBytes = freeOtpSecretBytes(obj.secret)
  if (!secretBytes || secretBytes.length === 0) return { error: 'secret 非法（应为字节数组）' }
  const secret = base32Encode(secretBytes)

  const algorithm = obj.algo === null || obj.algo === undefined ? 'SHA1' : normalizeAlgorithm(obj.algo)
  const digits = obj.digits === null || obj.digits === undefined ? 6 : toPositiveNumber(obj.digits, 6)
  const label = typeof obj.label === 'string' ? obj.label : ''

  const type = String(obj.type ?? '').toLowerCase()
  if (type === 'totp') {
    if (issuer === 'Steam') return steamEntry(secret, issuer, label)
    const period = obj.period === null || obj.period === undefined ? 30 : toPositiveNumber(obj.period, 30)
    return { type: 'totp', issuer, label, secret, algorithm, digits, period }
  }
  if (type === 'hotp') {
    // counter 必需（getLong 抛错→单条失败）；数值原样保留（不 +1，对齐 Aegis）
    if (obj.counter === null || obj.counter === undefined) return { error: 'HOTP 缺少 counter' }
    const counter = toNonNegativeNumber(obj.counter, NaN)
    if (!Number.isFinite(counter)) return { error: 'HOTP counter 非法' }
    return { type: 'hotp', issuer, label, secret, algorithm, digits, period: 30, counter }
  }
  return { error: `不支持的 type: ${obj.type ?? ''}` }
}

function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} 文件结构非法：不是合法 JSON`)
  }
}

/** FreeOTP+ JSON 导出导入（FreeOtpPlusImporter.java：顶层 {tokens: [...]}，tokenOrder 仅展示顺序，忽略） */
export function importFreeOtp(text: string): ImportResult {
  const obj = asObject(parseJsonText(text, 'FreeOTP+'))
  if (!obj) throw new Error('FreeOTP+ 文件结构非法：顶层不是 JSON 对象')
  if (!Array.isArray(obj.tokens)) throw new Error('FreeOTP+ 文件结构非法：缺少 tokens 数组')
  return collectEntries(obj.tokens, (raw, index) => {
    const entry = asObject(raw)
    if (!entry) return { error: `条目 ${index} 非对象` }
    return convertFreeOtpEntry(entry)
  })
}

// ---------- 旧版 FreeOTP（FreeOtpImporter.java readV1：shared_prefs/tokens.xml） ----------
// 源码口径：XML <map> 下每条 <string name="..."> 值为 Gson token JSON（元素文本中引号转义为 &quot;），
// 跳过 name="tokenOrder"（!entry.Name.equals("tokenOrder")），其余 string 条目逐条 JSON 解析。
// V2（freeotp_v2_*.xml，Java 序列化二进制 + AES-GCM 加密）非文本格式，不支持。
// Android SharedPreferences XML 为机器生成（属性恒 name="..."），正则提取即可，无需完整 XML 解析器
// （与 winauth.ts 的 M1 决策一致）。

/** Android shared_prefs XML 实体反转义（导出供 sqlite.ts 的 Authy/BattleNet XML 入口复用） */
export function xmlUnescape(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/g, (m, e: string) => {
    switch (e) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
    }
  })
}

/** shared_prefs <string name="...">value</string> 提取（机器生成，属性恒 name="..."，见 M1 决策） */
export const XML_STRING_RE = /<string\s+name="([^"]*)"\s*>([\s\S]*?)<\/string>/g

/** 旧版 FreeOTP tokens.xml 导入（Android shared_prefs 备份） */
export function importFreeOtpLegacy(text: string): ImportResult {
  const trimmed = text.trim()
  if (!trimmed.startsWith('<')) {
    throw new Error('旧版 FreeOTP 文件结构非法：不是合法 XML（应为 shared_prefs/tokens.xml）')
  }
  const entries: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  let ordinal = 0
  for (const m of trimmed.matchAll(XML_STRING_RE)) {
    const name = m[1] ?? ''
    if (name === 'tokenOrder') continue
    const index = ordinal++
    let obj: unknown
    try {
      obj = JSON.parse(xmlUnescape(m[2] ?? ''))
    } catch {
      failures.push({ index, message: `条目 ${index} token JSON 非法` })
      continue
    }
    const entry = asObject(obj)
    const res = entry ? convertFreeOtpEntry(entry) : { error: `条目 ${index} 非对象` }
    if ('error' in res) failures.push({ index, message: res.error })
    else entries.push(res)
  }
  return { entries, failures }
}

// ---------- TOTP Authenticator（TotpAuthenticatorImporter.java） ----------
// 源码口径（com.authenticator.authservice2）：
// - 外部分享文件：Base64 文本 → AES/CBC/PKCS5Padding 解密；密钥 = SHA-256(UTF8(口令))，
//   IV = 16 字节全零（源码 WARNING 注释的硬编码 IV）；默认口令 "TotpAuthenticator"（对话框「否」路径）
// - 解密明文为 JSON 对象，其第一个键（obj.names()[0]）即条目数组 JSON 字符串（App 序列化怪癖）
// - 条目：base=16|32|64（getInt 必需，其他值单条失败）、key=secret 字符串（必需）、
//   name/issuer=optString；info 固定 TotpInfo(secret) → totp/SHA1/6/30（App 不支持其他参数）
// - 明文形态（解密后的条目数组 / 内部 STATIC_TOTP_CODES_LIST 偏好值，JSON 数组）直接解析
// 简报猜测的明文 {tokens:[{secret,label,issuer}]} 与源码不符，以源码为准。

const TOTP_AUTH_DEFAULT_PASSWORD = 'TotpAuthenticator' // TotpAuthenticatorImporter.java PASSWORD
const TOTP_AUTH_IV = new Uint8Array(16) // 源码硬编码 IV（16 字节全零）

/** hex → 字节（大小写兼容，奇数长度/非法字符 → null；导出供 sqlite.ts 复用 — 即 encoding/hex 的 re-export） */
export { hexToBytes }

/** {base, key} → secret 字节；非法返回 null（错误信息按 Aegis：不支持的 base / 解码失败单条失败） */
function totpAuthSecretBytes(entry: Record<string, unknown>): { bytes?: Uint8Array; error?: string } {
  const base = Number(entry.base)
  const key = typeof entry.key === 'string' ? entry.key : null
  if (!key) return { error: '缺少 secret（key）' }
  if (!Number.isInteger(base)) return { error: '缺少 base' }
  try {
    let bytes: Uint8Array
    if (base === 16) {
      // Aegis：Hex.decode(secretString)（encoding/Hex.java，大小写兼容）
      const decoded = hexToBytes(key)
      if (!decoded) return { error: `base ${entry.base} secret 解码失败` }
      bytes = decoded
    } else if (base === 32) {
      bytes = base32Decode(key)
    } else if (base === 64) {
      bytes = base64ToBytes(key)
    } else {
      return { error: `不支持的 secret 编码: base ${entry.base}` }
    }
    if (bytes.length === 0) return { error: 'secret 为空' }
    return { bytes }
  } catch {
    return { error: `base ${entry.base} secret 解码失败` }
  }
}

function convertTotpAuthenticatorEntry(obj: Record<string, unknown>): ParsedEntry | { error: string } {
  const res = totpAuthSecretBytes(obj)
  if (!res.bytes) return { error: res.error ?? 'secret 非法' }
  return {
    type: 'totp',
    issuer: typeof obj.issuer === 'string' ? obj.issuer : '',
    label: typeof obj.name === 'string' ? obj.name : '',
    secret: base32Encode(res.bytes),
    algorithm: 'SHA1', // TotpInfo(secret) → OtpInfo.DEFAULT_ALGORITHM
    digits: 6, // OtpInfo.DEFAULT_DIGITS
    period: 30, // TotpInfo.DEFAULT_PERIOD
  }
}

function parseTotpAuthenticatorArray(parsed: unknown): ImportResult {
  if (!Array.isArray(parsed)) throw new Error('TOTP Authenticator 文件结构非法：条目不是 JSON 数组')
  return collectEntries(parsed, (raw, index) => {
    const entry = asObject(raw)
    if (!entry) return { error: `条目 ${index} 非对象` }
    return convertTotpAuthenticatorEntry(entry)
  })
}

/**
 * TOTP Authenticator 导入：
 * - 明文 JSON 数组（内部 STATIC_TOTP_CODES_LIST 偏好值 / 手工解密后的条目数组）直接解析
 * - 外部分享文件（Base64 密文）：SHA-256(口令) + AES-CBC（IV=0）解密后解析；
 *   口令缺省用硬编码默认口令；解密失败（口令错/文件损坏）抛中文错误
 */
export async function importTotpAuthenticator(text: string, password?: string): Promise<ImportResult> {
  const trimmed = text.trim()

  // 明文条目数组
  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error('TOTP Authenticator 文件结构非法：不是合法 JSON')
    }
    return parseTotpAuthenticatorArray(parsed)
  }

  // 外部分享：Base64 → AES-CBC 解密
  let cipherBytes: Uint8Array
  try {
    cipherBytes = base64ToBytes(trimmed.replace(/\s+/g, ''))
  } catch {
    throw new Error('TOTP Authenticator 文件结构非法：不是合法 base64')
  }

  const passBytes = new TextEncoder().encode(password ?? TOTP_AUTH_DEFAULT_PASSWORD)
  let plain: string
  try {
    // 密钥 = SHA-256(UTF8(口令))（源码 decrypt：MessageDigest SHA-256 + SecretKeySpec）
    const hash = await crypto.subtle.digest('SHA-256', passBytes as BufferSource)
    const key = await crypto.subtle.importKey('raw', hash, 'AES-CBC', false, ['decrypt'])
    const bytes = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: TOTP_AUTH_IV as BufferSource }, key, cipherBytes as BufferSource)
    plain = new TextDecoder().decode(bytes)
  } catch {
    throw new Error('TOTP Authenticator 口令错误或文件已损坏')
  }

  let outer: unknown
  try {
    outer = JSON.parse(plain)
  } catch {
    throw new Error('TOTP Authenticator 口令错误或文件已损坏')
  }
  const obj = asObject(outer)
  if (!obj) throw new Error('TOTP Authenticator 文件结构非法：解密内容不是 JSON 对象')
  // 解密对象的首键即条目数组 JSON 串（App 序列化怪癖）；空对象 → 空结果（源码 keys 判空）
  const firstKey = Object.keys(obj)[0]
  if (firstKey === undefined) return { entries: [], failures: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(firstKey)
  } catch {
    throw new Error('TOTP Authenticator 文件结构非法：解密内容不含有效条目数组')
  }
  return parseTotpAuthenticatorArray(parsed)
}

// ---------- andOTP（AndOtpImporter.java） ----------
// 源码口径：
// - 明文 = 顶层 JSON 数组（简报猜测的 {entries:[...]} 与源码不符；Aegis read() 用 JSONArray 解析，
//   解析失败才视作加密）。条目必需字段：type（totp/hotp/steam，小写化）、algorithm、digits、
//   secret（Base32 字符串）；totp 另需 period（getInt）、hotp 另需 counter（getLong）、
//   steam 的 period 可选（optInt 缺省 30）
// - issuer/label：issuer 键存在 → label=getString("label")、issuer=getString("issuer")；
//   否则 label 按 " - " 拆分（首段=issuer，次段=label；无分隔则 issuer=''）
// - 加密备份（read() JSON 解析失败分支）：真实格式为二进制 AES-256-GCM（新格式头 = 4B 大端迭代数 +
//   12B 盐 + 12B nonce + 密文 + 16B tag，PBKDF2WithHmacSHA1/256bit；旧格式 = SHA-256(口令) 作密钥、
//   无头）——简报猜测的 fernet / AES-256-CBC+PBKDF2 均与源码不符。二进制文件经 UTF-8 文本管道读入
//   已不可逆损毁，本实现明确报「暂不支持」，M2 需二进制读取支持后补（见 task-2-report）。

function andOtpIssuerLabel(obj: Record<string, unknown>): { issuer: string; label: string } | { error: string } {
  if ('issuer' in obj) {
    if (typeof obj.label !== 'string') return { error: '缺少 label' }
    return { issuer: String(obj.issuer ?? ''), label: obj.label }
  }
  if (typeof obj.label !== 'string') return { error: '缺少 label' }
  const parts = obj.label.split(' - ')
  if (parts.length > 1) return { issuer: parts[0]!, label: parts[1]! }
  return { issuer: '', label: parts[0]! }
}

function convertAndOtpEntry(obj: Record<string, unknown>, index: number): ParsedEntry | { error: string } {
  // 必需字段（getString/getInt 缺失 → 单条失败，对齐 Aegis DatabaseImporterEntryException）
  if (typeof obj.type !== 'string') return { error: `条目 ${index} 缺少 type` }
  const type = obj.type.toLowerCase()
  if (typeof obj.algorithm !== 'string') return { error: `条目 ${index} 缺少 algorithm` }
  if (obj.digits === null || obj.digits === undefined) return { error: `条目 ${index} 缺少 digits` }
  if (typeof obj.secret !== 'string' || obj.secret.trim() === '') return { error: `条目 ${index} 缺少 secret` }
  const secret = normalizeSecret(obj.secret)
  if (!isBase32(secret)) return { error: `条目 ${index} secret 非法 base32` }

  const labelRes = andOtpIssuerLabel(obj)
  if ('error' in labelRes) return { error: `条目 ${index} ${labelRes.error}` }

  // andOTP 条目自带 tags: string[]（明文导出即标签数组）；非字符串/空白项过滤（spec §4）
  const tagList = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : []
  const tagField = tagList.length > 0 ? { tags: tagList } : {}
  const algorithm = normalizeAlgorithm(obj.algorithm)
  const digits = toPositiveNumber(obj.digits, 6)

  if (type === 'totp') {
    if (obj.period === null || obj.period === undefined) return { error: `条目 ${index} 缺少 period` }
    return { type: 'totp', ...labelRes, secret, algorithm, digits, period: toPositiveNumber(obj.period, 30), ...tagField }
  }
  if (type === 'hotp') {
    if (obj.counter === null || obj.counter === undefined) return { error: `条目 ${index} 缺少 counter` }
    return { type: 'hotp', ...labelRes, secret, algorithm, digits, period: 30, counter: toNonNegativeNumber(obj.counter, 0), ...tagField }
  }
  if (type === 'steam') {
    // SteamInfo(secret, algo, digits, optInt("period", 30))；本仓库口径 steam digits=5
    return { ...steamEntry(secret, labelRes.issuer, labelRes.label), algorithm, ...tagField }
  }
  return { error: `条目 ${index} 不支持的 type: ${obj.type}` }
}

/** andOTP 明文导出导入；加密备份（二进制 AES-256-GCM）文本管道不支持 → 结构级报错提示明文导出 */
export function importAndOtp(text: string): ImportResult {
  const trimmed = text.trim()
  // Aegis read()：JSON 数组解析失败 → EncryptedState。文本管道下非数组输入即视为加密/损坏
  if (!trimmed.startsWith('[')) {
    throw new Error('andOTP 加密备份暂不支持：请用明文导出（JSON 数组）')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('andOTP 文件结构非法：不是合法 JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('andOTP 文件结构非法：顶层不是 JSON 数组')
  return collectEntries(parsed, (raw, index) => {
    const entry = asObject(raw)
    if (!entry) return { error: `条目 ${index} 非对象` }
    return convertAndOtpEntry(entry, index)
  })
}
