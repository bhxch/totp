import { validateReleaseMinutes } from '../src/components/releasePlatform'
import { describe, expect, it } from 'vitest'

describe('validateReleaseMinutes', () => {
  it('0（禁用）与常规值合法', () => {
    expect(validateReleaseMinutes(0)).toBe(true)
    expect(validateReleaseMinutes(5)).toBe(true)
    expect(validateReleaseMinutes(1440)).toBe(true)
  })
  it('负数/小数/超一天非法', () => {
    expect(validateReleaseMinutes(-1)).toBe(false)
    expect(validateReleaseMinutes(1.5)).toBe(false)
    expect(validateReleaseMinutes(1441)).toBe(false)
  })
})
