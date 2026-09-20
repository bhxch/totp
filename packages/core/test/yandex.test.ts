import { yandexCode, yandexValidateSecret, base32Decode, base32Encode } from '@totp/core'
import { describe, expect, it } from 'vitest'

// 由 scripts/gen-yaotp-vectors.mjs 产出（独立参考实现 node:crypto，Step 1 运行结果原样粘贴）：
const VECTORS = [
  {
    secretB32: 'KJTEUGOD5SNXVWBCWJ4G36W4IA',
    pin: '1234',
    period: 30,
    timeMs: 1700000000000,
    code: 'vaxzahfg',
  },
  {
    secretB32: 'KJTEUGOD5SNXVWBCWJ4G36W4IA',
    pin: '1234',
    period: 60,
    timeMs: 1700000060000,
    code: 'fodmwngm',
  },
  {
    secretB32: 'KJTEUGOD5SNXVWBCWJ4G36W4IA',
    pin: '0000',
    period: 30,
    timeMs: 1700000000000,
    code: 'zpizgiyt',
  },
  {
    secretB32: 'KJTEUGOD5SNXVWBCWJ4G36W4IA',
    pin: '0000',
    period: 60,
    timeMs: 1700000060000,
    code: 'ywxgaaht',
  },
  {
    secretB32: 'KJTEUGOD5SNXVWBCWJ4G36W4IA',
    pin: 'yy9-_x',
    period: 30,
    timeMs: 1700000000000,
    code: 'jdooggar',
  },
  {
    secretB32: 'KJTEUGOD5SNXVWBCWJ4G36W4IA',
    pin: 'yy9-_x',
    period: 60,
    timeMs: 1700000060000,
    code: 'wuxmxjmh',
  },
] as const

describe('yandexCode（黄金向量，对齐 Aegis YAOTP.java）', () => {
  it.each(VECTORS)('pin=$pin period=$period timeMs=$timeMs', async (v) => {
    await expect(yandexCode(v.secretB32, v.pin, v.timeMs, v.period)).resolves.toBe(v.code)
  })
  it('输出恒为 8 位小写字母', async () => {
    const code = await yandexCode(VECTORS[0]!.secretB32, VECTORS[0]!.pin, VECTORS[0]!.timeMs)
    expect(code).toMatch(/^[a-z]{8}$/)
  })
  it('空 pin 也是合法 pin（不抛错，仍产出 8 位字母）', async () => {
    const code = await yandexCode(VECTORS[0]!.secretB32, '', VECTORS[0]!.timeMs)
    expect(code).toMatch(/^[a-z]{8}$/)
  })
})

describe('yandexValidateSecret（Aegis YandexInfo.validateSecret 移植，KeeYaOtp ChecksumIsValid）', () => {
  // 生成侧同式构造：CRC 域置零后跑与实现相同的 13 位分组累积，数据余数即校验值，回填尾部 12 位
  function buildValid26(body: Uint8Array): Uint8Array {
    const full = new Uint8Array(26); full.set(body)
    const POLY = 0b1_1000_1111_0011
    let accum = 0
    let accumBits = 0
    let totalBits = 26 * 8 - 12
    let inputIndex = 0
    let inputBitsAvailable = 8
    while (totalBits > 0) {
      let requiredBits = 13 - accumBits
      if (totalBits < requiredBits) requiredBits = totalBits
      while (requiredBits > 0) {
        const curInput = full[inputIndex]! & ((1 << inputBitsAvailable) - 1)
        const bitsToRead = Math.min(requiredBits, inputBitsAvailable)
        accum = ((accum << bitsToRead) | (curInput >> (inputBitsAvailable - bitsToRead))) & 0xffff
        totalBits -= bitsToRead
        requiredBits -= bitsToRead
        inputBitsAvailable -= bitsToRead
        accumBits += bitsToRead
        if (inputBitsAvailable === 0) { inputIndex += 1; inputBitsAvailable = 8 }
      }
      if (accumBits === 13) accum ^= POLY
      accumBits = accum === 0 ? 0 : 32 - Math.clz32(accum)
    }
    full[24] = (accum >> 8) & 0x0f
    full[25] = accum & 0xff
    return full
  }

  it('16 字节直通；自洽 26 字节通过；任一位翻转抛错；长度非法抛错', () => {
    const body = new Uint8Array(16).map((_, i) => i * 7 + 1)
    expect(() => yandexValidateSecret(body)).not.toThrow()
    const full = buildValid26(body)
    expect(() => yandexValidateSecret(full)).not.toThrow()
    // body 任一位翻转 → 校验失败
    const badBody = full.slice(); badBody[3]! ^= 1
    expect(() => yandexValidateSecret(badBody)).toThrow()
    // 校验值本身任一位翻转 → 校验失败
    const badCrc = full.slice(); badCrc[25]! ^= 1
    expect(() => yandexValidateSecret(badCrc)).toThrow()
    expect(() => yandexValidateSecret(new Uint8Array(10))).toThrow()
    expect(() => yandexValidateSecret(new Uint8Array(20))).toThrow()
  })
  it('base32 round-trip：16 字节编解码一致（yandexCode 内部路径）', () => {
    const bytes = base32Decode(VECTORS[0]!.secretB32)
    expect(bytes.length).toBe(16)
    expect(base32Encode(bytes)).toBe(VECTORS[0]!.secretB32 + '======')
  })
})
