import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, RFC4648_ALPHABET, STEAM_ALPHABET } from '../src/encoding/base32'

describe('base32Encode', () => {
  // RFC 4648 官方向量
  it.each([
    [new Uint8Array(0), ''],
    [new TextEncoder().encode('f'), 'MY======'],
    [new TextEncoder().encode('fo'), 'MZXQ===='],
    [new TextEncoder().encode('foo'), 'MZXW6==='],
    [new TextEncoder().encode('foob'), 'MZXW6YQ='],
    [new TextEncoder().encode('fooba'), 'MZXW6YTB'],
    [new TextEncoder().encode('foobar'), 'MZXW6YTBOI======'],
  ])('%s → %s', (input, expected) => {
    expect(base32Encode(input)).toBe(expected)
  })
})

describe('base32Decode', () => {
  it.each([
    ['', 0],
    ['MY======', 1],
    ['MZXW6YTBOI======', 6],
    ['MZXW6YTBOI', 6], // padding 可省略
    ['mzxw6ytboi======', 6], // 小写
    ['MZXW 6YTB OI', 6], // 空格
  ])('%s → %d bytes', (input, expectedLen) => {
    const out = base32Decode(input)
    expect(out.length).toBe(expectedLen)
    expect(new TextDecoder().decode(out)).toBe('foobar'.slice(0, expectedLen))
  })

  it('非法字符抛错', () => {
    expect(() => base32Decode('ABC1')).toThrow('invalid base32') // 1 不在 RFC4648 表
  })
})

describe('字母表', () => {
  it('RFC4648 表 32 字符；Steam 表 26 字符无 0/1', () => {
    expect(RFC4648_ALPHABET).toHaveLength(32)
    expect(STEAM_ALPHABET).toHaveLength(26)
    expect(STEAM_ALPHABET).not.toMatch(/[01]/)
  })
})
