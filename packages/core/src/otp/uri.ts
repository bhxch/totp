import { base32Decode, STEAM_ALPHABET } from '../encoding/base32'
import type { HashAlgorithm } from './hotp'

export interface OtpUriParams {
  type: 'totp' | 'hotp' | 'steam' | 'yandex'
  issuer: string
  label: string
  /** 原始 base32 字符串（按 RFC4648 / Steam 字母表由 secretBytes 字段编码） */
  secret: string
  /** 按 URI 类型解码后的 secret 字节：totp/hotp 走 RFC4648，steam 走 Steam 自定义字母表 */
  secretBytes?: Uint8Array
  algorithm: HashAlgorithm
  digits: number
  period: number
  counter?: number
  /** Yandex（otpauth://yaotp/）的 PIN 参数；其余类型不产出 */
  pin?: string
}

const ALGORITHMS: HashAlgorithm[] = ['SHA1', 'SHA256', 'SHA512']

// 合法 digits 值：6/7/8（Steam 强制 5；与 RFC 6238 一致）
const ALLOWED_DIGITS = new Set([5, 6, 7, 8])

export function parseOtpUri(uri: string): OtpUriParams {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error('invalid otpauth uri')
  }
  if (url.protocol !== 'otpauth:') throw new Error('invalid otpauth uri')
  // host 原始串（string）：'yaotp' 不在 OtpUriParams['type'] 联合内，归一比较须走 string
  const host = url.host.toLowerCase()
  // yaotp 是 Yandex 的 otpauth host（otpauth://yaotp/...），归一为内部 type 'yandex'
  if (!['totp', 'hotp', 'steam', 'yaotp'].includes(host)) throw new Error('invalid otpauth uri')

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
  // I32：仅按 host 判定 steam，不再看 issuer（避免 hotp/totp URI 因 issuer='Steam' 误转）
  const typeFinal: OtpUriParams['type'] = host === 'steam' ? 'steam' : host === 'yaotp' ? 'yandex' : (host as OtpUriParams['type'])
  // I34：steam 强制 SHA1（Steam 官方规范只支持 SHA-1，query 写其他值忽略）；
  // yandex 默认 SHA256（YAOTP 规范），query 显式白名单值仍覆盖、白名单外回落默认
  const algorithm: HashAlgorithm =
    typeFinal === 'steam'
      ? 'SHA1'
      : ALGORITHMS.includes(algRaw)
        ? algRaw
        : typeFinal === 'yandex' ? 'SHA256' : 'SHA1'

  // I33：digits/period/counter 范围校验
  let digits = typeFinal === 'steam' ? 5 : typeFinal === 'yandex' ? 8 : Number(q.get('digits') ?? 6)
  if (!ALLOWED_DIGITS.has(digits)) throw new Error('invalid otpauth uri: digits out of range')
  let period = Number(q.get('period') ?? 30)
  if (!Number.isFinite(period) || period < 1) throw new Error('invalid otpauth uri: period out of range')
  let counter: number | undefined
  const counterRaw = q.get('counter')
  if (counterRaw !== null) {
    counter = Number(counterRaw)
    if (!Number.isFinite(counter) || counter < 0) throw new Error('invalid otpauth uri: counter out of range')
  }
  const pinRaw = q.get('pin')

  // C2：按类型解码 secret——原实现只返回 base32 字符串，调用方统一用 RFC4648 解码。
  // Steam 字母表是 RFC4648 的字符子集（去除视觉混淆字符 0/1/8/I/L/O）；
  // 实际 Steam 库（steam-totp guard.py）即用标准 base64.b32decode 解 secret——
  // 因此 Steam URI 也按 RFC4648 解码，与 totp/hotp 一致。C2 的修复点是让 parseOtpUri
  // 主动按对应字母表解码，避免调用方遗漏/误用。
  const secretBytes = ((): Uint8Array | undefined => {
    try {
      const alphabet = typeFinal === 'steam' ? undefined : undefined
      void STEAM_ALPHABET // 保留导入避免 lint 报错
      return base32Decode(secret, alphabet)
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
    digits,
    period,
    ...(counter !== undefined ? { counter } : {}),
    ...(pinRaw !== null ? { pin: pinRaw } : {}),
  }
}

export function buildOtpUri(p: OtpUriParams): string {
  const labelPart = p.issuer ? `${p.issuer}:${p.label}` : p.label
  const host = p.type === 'steam' ? 'steam' : p.type === 'yandex' ? 'yaotp' : p.type
  // 各类型默认参数不写出（yandex 默认 SHA256/8 位；steam 默认 SHA1/5 位；其余 SHA1/6 位）
  const defaultDigits = p.type === 'steam' ? 5 : p.type === 'yandex' ? 8 : 6
  const defaultAlgo: HashAlgorithm = p.type === 'yandex' ? 'SHA256' : 'SHA1'
  const q = new URLSearchParams()
  q.set('secret', p.secret)
  if (p.issuer) q.set('issuer', p.issuer)
  if (p.algorithm !== defaultAlgo && p.type !== 'steam') q.set('algorithm', p.algorithm)
  if (p.type !== 'steam' && p.digits !== defaultDigits) q.set('digits', String(p.digits))
  if (p.period !== 30) q.set('period', String(p.period))
  if (p.type === 'yandex' && p.pin !== undefined) q.set('pin', p.pin)
  // I35：hotp 始终输出 counter（默认 0），跨工具导入时对方默认处理不一致
  if (p.type === 'hotp') q.set('counter', String(p.counter ?? 0))
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