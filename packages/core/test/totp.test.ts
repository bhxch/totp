import { describe, expect, it } from 'vitest'
import { totp, verifyTotp } from '../src/otp/totp'
import { hotp } from '../src/otp/hotp'
import { base32Decode } from '../src/encoding/base32'

// RFC 6238 Appendix B 官方向量（8 位）
const S1 = new TextEncoder().encode('12345678901234567890') // SHA1
const S256 = new TextEncoder().encode('12345678901234567890123456789012') // SHA256
const S512 = new TextEncoder().encode(
  '1234567890123456789012345678901234567890123456789012345678901234', // 64 字节
)

describe('totp RFC 6238 向量', () => {
  const cases: Array<[number, string, string, string]> = [
    // [T秒, SHA1, SHA256, SHA512]
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ]
  it.each(cases)('T=%i', async (tSec, sha1, sha256, sha512) => {
    const tMs = tSec * 1000
    expect(await totp(S1, tMs, { algorithm: 'SHA1', digits: 8 })).toBe(sha1)
    expect(await totp(S256, tMs, { algorithm: 'SHA256', digits: 8 })).toBe(sha256)
    expect(await totp(S512, tMs, { algorithm: 'SHA512', digits: 8 })).toBe(sha512)
  })
})

describe('totp period/digits', () => {
  it('默认 30 秒周期、6 位，与 hotp(counter=floor(t/30)) 一致', async () => {
    const secret = base32Decode('JBSWY3DPEHPK3PXP')
    const tMs = 1_700_000_000_000
    const expected = await totp(secret, tMs)
    expect(expected).toHaveLength(6)
    expect(expected).toBe(await hotp(secret, Math.floor(tMs / 1000 / 30)))
  })
})

describe('verifyTotp', () => {
  it('当前码通过；窗口外的旧码在 window=0 时拒绝', async () => {
    const secret = base32Decode('JBSWY3DPEHPK3PXP')
    const nowMs = 1_700_000_000_000
    const code = await totp(secret, nowMs)
    expect(await verifyTotp(secret, code, { nowMs })).toBe(true)
    const oldCode = await totp(secret, nowMs - 5 * 60 * 1000)
    expect(await verifyTotp(secret, oldCode, { nowMs, window: 0 })).toBe(false)
    expect(await verifyTotp(secret, oldCode, { nowMs, window: 10 })).toBe(true)
  })

  it('I30：t0 自定义：counter = floor((T - T0) / X)，等价偏移后再验证', async () => {
    const secret = base32Decode('JBSWY3DPEHPK3PXP')
    const nowMs = 1_700_000_000_000
    const t0 = 60 // 偏移 60 秒
    const code = await totp(secret, nowMs, { t0 })
    // 同 t0 验证通过
    expect(await verifyTotp(secret, code, { nowMs, t0 })).toBe(true)
    // 不传 t0（默认 0）时 counter 不同
    expect(await verifyTotp(secret, code, { nowMs })).toBe(false)
    // 另一个 t0 也应通过
    const code2 = await totp(secret, nowMs, { t0: 120 })
    expect(await verifyTotp(secret, code2, { nowMs, t0: 120 })).toBe(true)
  })
})
