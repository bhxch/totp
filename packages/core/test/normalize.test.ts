import { describe, expect, it } from 'vitest'
import {
  asObject, collectEntries, isBase32, normalizeAlgorithm, normalizeSecret, normalizeType,
  parseJson, parseJsonObject, steamEntry, toNonNegativeNumber, toOtpDigits, toPositiveNumber,
} from '../src/import/normalize'
import type { ImportResult, ParsedEntry } from '../src/import/types'

describe('toOtpDigits', () => {
  it('6/7/8 恒等；steam 恒 5；其余钳 6', () => {
    expect(toOtpDigits(6, 'totp')).toBe(6)
    expect(toOtpDigits(7, 'totp')).toBe(7)
    expect(toOtpDigits(8, 'hotp')).toBe(8)
    expect(toOtpDigits(6, 'steam')).toBe(5)
    expect(toOtpDigits(8, 'steam')).toBe(5)
    expect(toOtpDigits(5, 'totp')).toBe(6)
    expect(toOtpDigits(9, 'totp')).toBe(6)
    expect(toOtpDigits(Number.NaN, 'totp')).toBe(6)
  })
})

describe('normalize helpers', () => {
  it('normalizeSecret: trim/uppercase/whitespace removed', () => {
    expect(normalizeSecret('  Ab Cd  Ef ')).toBe('ABCDEF')
    expect(normalizeSecret('a\nb\tc')).toBe('ABC')
    expect(normalizeSecret(null)).toBe('')
    expect(normalizeSecret(undefined)).toBe('')
    expect(normalizeSecret(123)).toBe('123')
  })

  it('normalizeAlgorithm: only SHA1/SHA256/SHA512; others fall back to SHA1', () => {
    expect(normalizeAlgorithm('sha1')).toBe('SHA1')
    expect(normalizeAlgorithm('SHA256')).toBe('SHA256')
    expect(normalizeAlgorithm('SHA512')).toBe('SHA512')
    expect(normalizeAlgorithm('MD5')).toBe('SHA1')
    expect(normalizeAlgorithm('')).toBe('SHA1')
    expect(normalizeAlgorithm(null)).toBe('SHA1')
  })

  it('normalizeType: steam/hotp/totp detection (case-insensitive substring)', () => {
    expect(normalizeType('TOTP')).toBe('totp')
    expect(normalizeType('hotp')).toBe('hotp')
    expect(normalizeType('STEAM')).toBe('steam')
    expect(normalizeType('totp_steam_legacy')).toBe('steam')
    expect(normalizeType('hotp-v2')).toBe('hotp')
    expect(normalizeType('')).toBe('totp')
    expect(normalizeType(null)).toBe('totp')
  })

  it('toPositiveNumber: fallback on non-positive or non-finite', () => {
    expect(toPositiveNumber(30, 6)).toBe(30)
    expect(toPositiveNumber(0, 6)).toBe(6)
    expect(toPositiveNumber(-1, 6)).toBe(6)
    expect(toPositiveNumber(NaN, 6)).toBe(6)
    expect(toPositiveNumber('15', 6)).toBe(15)
    expect(toPositiveNumber('abc', 6)).toBe(6)
  })

  it('toNonNegativeNumber: fallback on negative or non-finite, accepts 0', () => {
    expect(toNonNegativeNumber(0, 5)).toBe(0)
    expect(toNonNegativeNumber(10, 5)).toBe(10)
    expect(toNonNegativeNumber(-1, 5)).toBe(5)
    expect(toNonNegativeNumber(NaN, 5)).toBe(5)
  })

  it('asObject: object only, excludes null and arrays', () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 })
    expect(asObject(null)).toBeNull()
    expect(asObject([])).toBeNull()
    expect(asObject('str')).toBeNull()
    expect(asObject(42)).toBeNull()
  })

  it('collectEntries: success and failure paths stay independent', () => {
    const ok: ParsedEntry = { type: 'totp', issuer: 'i', label: 'l', secret: 'S', algorithm: 'SHA1', digits: 6, period: 30 }
    // 显式按类型 dispatch：number → error，string → success，object → success，null → error
    const res = collectEntries([1, 'two', null, ok], (row) => {
      if (typeof row === 'number') return { error: '数字非法' }
      if (row === null) return { error: 'null 非法' }
      if (typeof row === 'string') return ok
      return ok
    }) as ImportResult
    expect(res.entries).toEqual([ok, ok])
    expect(res.failures.length).toBe(2)
    expect(res.failures[0]?.message).toBe('数字非法')
    expect(res.failures[1]?.message).toBe('null 非法')
  })

  it('steamEntry: SHA1/5/30 and normalizeSecret idempotent', () => {
    const e = steamEntry('  abc def ', 'Steam', 'Steam account')
    expect(e).toEqual({
      type: 'steam', issuer: 'Steam', label: 'Steam account', secret: 'ABCDEF',
      algorithm: 'SHA1', digits: 5, period: 30,
    })
  })

  // R12 收敛单点的直接锚点：isBase32/parseJson/parseJsonObject 此前散在
  // jsonApps/miscApps（逐字副本）与各 importer 内联变体，行为契约由此锁定
  it('isBase32: 可解码非空即合法；空串/单字符/非法字符为假', () => {
    expect(isBase32('JBSWY3DPEHPK3PXP')).toBe(true)
    expect(isBase32('jbswy3dpehpk3pxp')).toBe(true) // base32Decode 大小写兼容
    expect(isBase32('ABC')).toBe(true) // ≥2 个合法字符不足 8bit 也解出 1 字节
    expect(isBase32('')).toBe(false) // 空串：base32Decode 抛 invalid input
    expect(isBase32('A')).toBe(false) // 单字符：不足编码 1 字节，base32Decode 抛错
    expect(isBase32('not-base32!')).toBe(false) // 非法字符抛错（'-'/' ' 被清洗，'!' 不会）
  })

  it('parseJson: 解析失败抛「{label} 文件结构非法：不是合法 JSON」', () => {
    expect(parseJson('{"a":1}', 'X')).toEqual({ a: 1 })
    expect(() => parseJson('{oops}', 'FreeOTP+')).toThrow('FreeOTP+ 文件结构非法：不是合法 JSON')
  })

  it('parseJsonObject: 顶层非对象（数组/标量/null）抛「顶层不是 JSON 对象」', () => {
    expect(parseJsonObject('{"a":1}', '2FAS')).toEqual({ a: 1 })
    expect(() => parseJsonObject('[1,2]', '2FAS')).toThrow('2FAS 文件结构非法：顶层不是 JSON 对象')
    expect(() => parseJsonObject('42', 'Bitwarden')).toThrow('Bitwarden 文件结构非法：顶层不是 JSON 对象')
    expect(() => parseJsonObject('null', 'Stratum')).toThrow('Stratum 文件结构非法：顶层不是 JSON 对象')
  })
})
