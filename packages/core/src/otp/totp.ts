import { hotp, type HashAlgorithm } from './hotp'

export async function totp(
  secret: Uint8Array,
  timeMs: number,
  opts: { period?: number; algorithm?: HashAlgorithm; digits?: number; t0?: number } = {},
): Promise<string> {
  const { period = 30, algorithm = 'SHA1', digits = 6, t0 = 0 } = opts
  // RFC 6238 §4.1: counter = floor((T - T0) / X)，T0 默认 0 兼容旧实现
  const counter = Math.floor((timeMs / 1000 - t0) / period)
  return hotp(secret, counter, { algorithm, digits })
}

export async function verifyTotp(
  secret: Uint8Array,
  code: string,
  opts: { period?: number; algorithm?: HashAlgorithm; digits?: number; window?: number; nowMs?: number; t0?: number } = {},
): Promise<boolean> {
  const { window = 1, nowMs = Date.now() } = opts
  const period = opts.period ?? 30
  const t0 = opts.t0 ?? 0
  // 校验 counter 安全整数上界：hotp 内部用 setUint32(4, counter) 写入 32 位，超过即静默截断
  const current = Math.floor((nowMs / 1000 - t0) / period)
  if (!Number.isSafeInteger(current) || current < 0) return false
  for (let c = current - window; c <= current + window; c++) {
    if (c < 0) continue
    if ((await hotp(secret, c, { algorithm: opts.algorithm ?? 'SHA1', digits: opts.digits ?? 6 })) === code) return true
  }
  return false
}
