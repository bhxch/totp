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

  it('C19：secret 非法 → code=INVALID + 错误信息（不是占位 ------）', async () => {
    const bad: OtpEntry = { ...entry, uuid: 'bad', secret: '!!!非法 base32!!!' }
    const { codes } = useOtpCodes(ref([bad]))
    await vi.waitFor(() => expect(codes.value.get('bad')).toBeDefined())
    const c = codes.value.get('bad')!
    expect(c.code).toBe('INVALID')
    expect(c.code).not.toBe('------')
    expect(c.error).toBeTruthy()
    // 正常条目仍能计算
    const { codes: codes2 } = useOtpCodes(ref([entry]))
    await vi.waitFor(() => expect(codes2.value.get('a')).toBeDefined())
    expect(codes2.value.get('a')!.code).not.toBe('INVALID')
  })

  it('I61：progress=0..1 区间且 progress = remaining / period（HOTP 也按 period 计算）', async () => {
    // 使用 period=10 便于断言剩余/进度比例
    const e10: OtpEntry = { ...entry, uuid: 'p', period: 10 }
    const { codes } = useOtpCodes(ref([e10]))
    await vi.waitFor(() => expect(codes.value.get('p')).toBeDefined())
    const c = codes.value.get('p')!
    expect(c.progress).toBeGreaterThanOrEqual(0)
    expect(c.progress).toBeLessThanOrEqual(1)
    expect(c.progress).toBeCloseTo(c.remaining / 10, 5)
    // 边界：新周期第一秒 remaining==period → progress=1；最后一秒 remaining==1 → progress=0.1
    expect(c.remaining).toBeLessThanOrEqual(10)
  })
})
