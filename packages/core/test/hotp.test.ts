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
})
