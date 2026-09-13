import { hotp, type HashAlgorithm } from './hotp'

export async function totp(
  secret: Uint8Array,
  timeMs: number,
  opts: { period?: number; algorithm?: HashAlgorithm; digits?: number } = {},
): Promise<string> {
  const { period = 30, algorithm = 'SHA1', digits = 6 } = opts
  const counter = Math.floor(timeMs / 1000 / period)
  return hotp(secret, counter, { algorithm, digits })
}

export async function verifyTotp(
  secret: Uint8Array,
  code: string,
  opts: { period?: number; algorithm?: HashAlgorithm; digits?: number; window?: number; nowMs?: number } = {},
): Promise<boolean> {
  const { window = 1, nowMs = Date.now() } = opts
  const period = opts.period ?? 30
  const current = Math.floor(nowMs / 1000 / period)
  for (let c = current - window; c <= current + window; c++) {
    if (c < 0) continue
    if ((await hotp(secret, c, { algorithm: opts.algorithm ?? 'SHA1', digits: opts.digits ?? 6 })) === code) return true
  }
  return false
}
