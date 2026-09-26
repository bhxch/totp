import { base32Decode } from '../encoding/base32'
import type { HashAlgorithm } from './hotp'
import { otpTypeForHost, TYPE_PROFILES } from './typeProfiles'
import type { EntryType, OtpDigits } from '../model'

export interface OtpUriParams {
  type: EntryType
  issuer: string
  label: string
  /** 原始 base32 字符串（按 RFC4648 / Steam 字母表由 secretBytes 字段编码） */
  secret: string
  /** 按 URI 类型解码后的 secret 字节：totp/hotp 走 RFC4648，steam 走 Steam 自定义字母表 */
  secretBytes?: Uint8Array
  algorithm: HashAlgorithm
  /** parseOtpUri 已按 typeProfile 收口并校验：强制类型（steam/yandex）恒 forcedDigits，其余 ∈ 5-8 */
  digits: OtpDigits
  period: number
  counter?: number
  /** Yandex（otpauth://yaotp/）的 PIN 参数；其余类型不产出 */
  pin?: string
}

// 合法 digits 值：5/6/7/8 = OtpDigits 全集（Steam 强制 5；与 RFC 6238 一致）
const ALLOWED_DIGITS = new Set([5, 6, 7, 8])

export function parseOtpUri(uri: string): OtpUriParams {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error('invalid otpauth uri')
  }
  if (url.protocol !== 'otpauth:') throw new Error('invalid otpauth uri')
  // host 原始串（string）：'yaotp' 不在 EntryType 联合内，归一比较须走 string；
  // 白名单与别名（yaotp→yandex）由注册表 hostAliases 承载（R3）
  const typeFinal = otpTypeForHost(url.host.toLowerCase())
  if (!typeFinal) throw new Error('invalid otpauth uri')
  const profile = TYPE_PROFILES[typeFinal]

  const q = url.searchParams
  const secret = q.get('secret')?.replace(/\s+/g, '') ?? ''
  if (!secret) throw new Error('invalid otpauth uri')

  // path 形如 /Issuer:label 或 /label（可能整体编码过）
  let rawPath: string
  try {
    rawPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    throw new Error('invalid otpauth uri')
  }
  const colon = rawPath.indexOf(':')
  let prefixIssuer = ''
  let label = rawPath
  if (colon >= 0) {
    prefixIssuer = rawPath.slice(0, colon)
    label = rawPath.slice(colon + 1)
  }

  const issuer = q.get('issuer') ?? prefixIssuer
  const algRaw = (q.get('algorithm') ?? '').toUpperCase() as HashAlgorithm
  // I34：steam 强制 SHA1（supportedAlgorithms 单元素，query 写其他值忽略）；
  // yandex 默认 SHA256（YAOTP 规范）；query 显式白名单值仍覆盖、白名单外回落 defaultAlgorithm
  const algorithm = profile.supportedAlgorithms.includes(algRaw) ? algRaw : profile.defaultAlgorithm

  // I33：digits/period/counter 范围校验。强制类型（steam=5/yandex=8）忽略 query；
  // 其余取 query digits、缺省 defaultDigits（6）
  const digitsRaw = profile.forcedDigits ?? Number(q.get('digits') ?? profile.defaultDigits)
  if (!ALLOWED_DIGITS.has(digitsRaw)) throw new Error('invalid otpauth uri: digits out of range')
  let period = Number(q.get('period') ?? 30)
  if (!Number.isFinite(period) || period < 1) throw new Error('invalid otpauth uri: period out of range')
  let counter: number | undefined
  const counterRaw = q.get('counter')
  if (counterRaw !== null) {
    counter = Number(counterRaw)
    if (!Number.isFinite(counter) || counter < 0) throw new Error('invalid otpauth uri: counter out of range')
  }
  // M6：pin 仅 supportsPin 类型读取产出（YAOTP 规范参数）；其余类型不读不写，避免 totp 条目 pin 污染
  const pinRaw = profile.supportsPin ? q.get('pin') : null

  // C2：按类型解码 secret——全部类型统一走 RFC4648 解码路径（STEAM_ALPHABET 是 RFC4648 的
  // 字符子集，去除视觉混淆字符 0/1/L/O 等；实际 Steam 库 steam-totp guard.py 即用标准
  // base64.b32decode 解 secret）。parseOtpUri 主动解码，避免调用方遗漏/误用。
  const secretBytes = ((): Uint8Array | undefined => {
    try {
      return base32Decode(secret)
    } catch {
      return undefined
    }
  })()

  return {
    type: typeFinal,
    issuer: issuer || label,
    label,
    secret,
    ...(secretBytes !== undefined ? { secretBytes } : {}),
    algorithm,
    digits: digitsRaw as OtpDigits, // ALLOWED_DIGITS 校验后 ∈ 5-8
    period,
    ...(counter !== undefined ? { counter } : {}),
    ...(pinRaw !== null ? { pin: pinRaw } : {}),
  }
}

export function buildOtpUri(p: OtpUriParams): string {
  const profile = TYPE_PROFILES[p.type]
  const labelPart = p.issuer ? `${p.issuer}:${p.label}` : p.label
  // 规范 host（hostAliases[0]）：yandex 输出 'yaotp'，其余同名
  const host = profile.hostAliases[0]
  const q = new URLSearchParams()
  q.set('secret', p.secret)
  if (p.issuer) q.set('issuer', p.issuer)
  // 各类型默认参数不写出（yandex 默认 SHA256/8 位；steam 默认 SHA1/5 位且 supportedAlgorithms 单元素/
  // digitsMutable=false 恒省略——I34 steam 强制参数写出无意义；其余 SHA1/6 位非默认才写）
  if (p.algorithm !== profile.buildUriDefaults.algorithm && profile.supportedAlgorithms.length > 1)
    q.set('algorithm', p.algorithm)
  if (profile.digitsMutable && p.digits !== profile.buildUriDefaults.digits) q.set('digits', String(p.digits))
  if (p.period !== 30) q.set('period', String(p.period))
  if (profile.supportsPin && p.pin !== undefined) q.set('pin', p.pin)
  // I35：hotp 始终输出 counter（默认 0），跨工具导入时对方默认处理不一致
  if (profile.alwaysWriteCounter) q.set('counter', String(p.counter ?? 0))
  return `otpauth://${host}/${encodeURIComponent(labelPart)}?${q.toString()}`
}

/**
 * Firefox `protocol_handlers` 注册的 ext+otpauth scheme（裸 otpauth 被 Firefox schema 白名单硬校验拒绝）
 * → 还原为 otpauth://。可选吃掉回调里的 `//`（ext+otpauth://… 常见 href 写法），
 * 避免还原出 otpauth:////…（host 空）被 parseOtpUri 拒绝。
 */
export function normalizeExtOtpauth(uri: string): string {
  return uri.replace(/^ext\+otpauth:(?:\/\/)?/i, 'otpauth://')
}
