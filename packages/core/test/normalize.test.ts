import { describe, expect, it } from 'vitest'
import {
  asObject, collectEntries, normalizeAlgorithm, normalizeSecret, normalizeType, steamEntry,
  toNonNegativeNumber, toOtpDigits, toPositiveNumber,
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
})
