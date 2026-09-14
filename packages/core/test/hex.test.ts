import { describe, expect, it } from 'vitest'
import { hexToBytes } from '../src/encoding/hex'

describe('hexToBytes', () => {
  it('decodes lowercase hex', () => {
    const out = hexToBytes('deadbeef')
    expect(Array.from(out!)).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('decodes uppercase hex', () => {
    const out = hexToBytes('DEADBEEF')
    expect(Array.from(out!)).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('decodes mixed case', () => {
    const out = hexToBytes('DeAdBeEf')
    expect(Array.from(out!)).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('returns empty array for empty input', () => {
    const out = hexToBytes('')
    expect(out).not.toBeNull()
    expect(out!.length).toBe(0)
  })

  it('returns null for odd length', () => {
    expect(hexToBytes('abc')).toBeNull()
  })

  it('returns null for non-hex characters', () => {
    expect(hexToBytes('zz')).toBeNull()
    expect(hexToBytes('ab cd')).toBeNull()
    expect(hexToBytes('ab\ncd')).toBeNull()
  })
})
