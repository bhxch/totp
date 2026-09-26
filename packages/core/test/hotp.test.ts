import { describe, expect, it } from 'vitest'
import { hmac, hotp, truncateU31, type HashAlgorithm } from '../src/otp/hotp'

// RFC 4226 Appendix D：secret = ASCII "12345678901234567890"
const SECRET = new TextEncoder().encode('12345678901234567890')

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

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

// R16①：HMAC 原语从 hotp 私有实现单点导出（steam.ts 的 SHA-1 特化等价收敛于此）。
// 向量：RFC 2202 TC1（SHA-1）/ RFC 4231 TC1（SHA-256、SHA-512），key = 0x0b × 20，data = "Hi There"
describe('R16①：hmac 三算法原语', () => {
  const key = new Uint8Array(20).fill(0x0b)
  const data = new TextEncoder().encode('Hi There')
  it.each([
    ['SHA1', 'b617318655057264e28bc0b6fb378c8ef146be00'],
    ['SHA256', 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    ['SHA512', '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854'],
  ] as Array<[HashAlgorithm, string]>)('HMAC-%s（RFC 权威向量）', async (algorithm, expected) => {
    expect(bytesToHex(await hmac(key, data, algorithm))).toBe(expected)
  })
})

// R16①：截断底层统一——「以末字节低 4 位为偏移取 4 字节 + 清最高符号位」产出 u31。
// 产出形态不在本层：hotp 转十进制串 padStart；steam 用字符表取模（各自既有向量锁定）。
describe('R16①：truncateU31', () => {
  it('偏移取末字节低 4 位，高位忽略', () => {
    const mac = new Uint8Array(20)
    mac[19] = 0x0a // offset = 10
    mac[10] = 0x5e; mac[11] = 0xad; mac[12] = 0xbe; mac[13] = 0xef
    expect(truncateU31(mac)).toBe(0x5eadbeef)
    mac[19] = 0xfa // 高 4 位变化不改变偏移
    expect(truncateU31(mac)).toBe(0x5eadbeef)
  })
  it('清符号位：首字节 ≥ 0x80 不产生负数/进位', () => {
    const mac = new Uint8Array(20)
    mac[19] = 0x0f // offset = 15
    mac[15] = 0xff; mac[16] = 0xff; mac[17] = 0xff; mac[18] = 0xff
    expect(truncateU31(mac)).toBe(0x7fffffff)
    mac[15] = 0x80; mac[16] = 0x00; mac[17] = 0x00; mac[18] = 0x2a
    expect(truncateU31(mac)).toBe(0x2a)
  })
  it('恒在 u31 值域内', () => {
    for (let i = 0; i < 64; i++) {
      const mac = new Uint8Array(20).map(() => Math.floor(Math.random() * 256))
      const n = truncateU31(mac)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThanOrEqual(0x7fffffff)
    }
  })
})
