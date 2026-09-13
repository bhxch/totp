import type { HashAlgorithm } from './hotp'

export interface OtpUriParams {
  type: 'totp' | 'hotp' | 'steam'
  issuer: string
  label: string
  secret: string
  algorithm: HashAlgorithm
  digits: number
  period: number
  counter?: number
}

const ALGORITHMS: HashAlgorithm[] = ['SHA1', 'SHA256', 'SHA512']

export function parseOtpUri(uri: string): OtpUriParams {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error('invalid otpauth uri')
  }
  if (url.protocol !== 'otpauth:') throw new Error('invalid otpauth uri')
  const type = url.host.toLowerCase() as OtpUriParams['type']
  if (!['totp', 'hotp', 'steam'].includes(type)) throw new Error('invalid otpauth uri')

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
  const algRaw = (q.get('algorithm') ?? 'SHA1').toUpperCase() as HashAlgorithm
  const typeFinal: OtpUriParams['type'] = type === 'steam' || issuer.toLowerCase() === 'steam' ? 'steam' : type
  const counterRaw = q.get('counter')

  return {
    type: typeFinal,
    issuer: issuer || label,
    label,
    secret,
    algorithm: ALGORITHMS.includes(algRaw) ? algRaw : 'SHA1',
    digits: typeFinal === 'steam' ? 5 : Number(q.get('digits') ?? 6) || 6,
    period: Number(q.get('period') ?? 30) || 30,
    ...(counterRaw !== null ? { counter: Number(counterRaw) || 0 } : {}),
  }
}

export function buildOtpUri(p: OtpUriParams): string {
  const labelPart = p.issuer ? `${p.issuer}:${p.label}` : p.label
  const host = p.type === 'steam' ? 'steam' : p.type
  const q = new URLSearchParams()
  q.set('secret', p.secret)
  if (p.issuer) q.set('issuer', p.issuer)
  if (p.algorithm !== 'SHA1') q.set('algorithm', p.algorithm)
  if (p.type !== 'steam' && p.digits !== 6) q.set('digits', String(p.digits))
  if (p.period !== 30) q.set('period', String(p.period))
  if (p.type === 'hotp' && p.counter !== undefined) q.set('counter', String(p.counter))
  return `otpauth://${host}/${encodeURIComponent(labelPart)}?${q.toString()}`
}
