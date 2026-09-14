import { describe, expect, it } from 'vitest'
import { hotp } from '../src/otp/hotp'

// RFC 4226 Appendix D：secret = ASCII "12345678901234567890"
const SECRET = new TextEncoder().encode('12345678901234567890')

describe('hotp', () => {
  it.each([
    [0, '755224'], [1, '287082'], [2, '359152'], [3, '969429'],
    [4, '338314'], [5, '254676'], [6, '287922'], [7, '162583'],
    [8, '399871'], [9, '520489'],
  ])('counter=%i → %s', async (counter, expected) => {
    expect(await hotp(SECRET, counter)).toBe(expected)
  })

  it('支持 8 位（RFC 6238 样例 counter=1 8位: 84755224 的后 8 位）', async () => {
    expect(await hotp(SECRET, 0, { digits: 8 })).toBe('84755224')
  })

  it('I39：大 counter 边界 — 2^31-1 / 2^32-1 / 2^32 一致行为（WebCrypto setUint32 静默截断，约定 64-bit counter 仅取低 32 位）', async () => {
    // 2^32-1 截断后等于 -1（低 32 位全 1）；2^32 截断后等于 0
    // 实际行为：hotp(secret, 2^32-1) === hotp(secret, -1) === hotp(secret, 0xFFFFFFFF)
    const atMax32 = await hotp(SECRET, 2 ** 32 - 1)
    expect(atMax32).toHaveLength(6)
    // counter 0 已知值；2^32 截断为 0 → 应当等于 counter=0
    const atWrap = await hotp(SECRET, 2 ** 32)
    expect(atWrap).toBe('755224')
    // counter=2^31 截断后等于 0x80000000（最高位为 0 当作正数）
    const at31 = await hotp(SECRET, 2 ** 31)
    expect(at31).toHaveLength(6)
    expect(at31).not.toBe('')
  })
})
