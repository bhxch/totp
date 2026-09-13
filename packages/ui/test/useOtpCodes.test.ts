import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useOtpCodes } from '../src/composables/useOtpCodes'
import type { OtpEntry } from '@totp/core'

const entry: OtpEntry = {
  uuid: 'a', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order: 0, createdAt: 0,
}

describe('useOtpCodes', () => {
  it('立即计算当前码与剩余时间', async () => {
    const { codes, nowMs } = useOtpCodes(ref([entry]))
    await vi.waitFor(() => expect(codes.value.get('a')).toBeDefined())
    const c = codes.value.get('a')!
    expect(c.code).toMatch(/^\d{6}$/)
    expect(c.remaining).toBeGreaterThan(0)
    expect(c.remaining).toBeLessThanOrEqual(30)
    expect(c.progress).toBeCloseTo(c.remaining / 30, 5)
    expect(nowMs.value).toBeGreaterThan(0)
  })
})
