import { describe, expect, it } from 'vitest'
import { computeEntryCode } from '../src/otp/entryCode'
import type { OtpEntry } from '../src/model'

const base = {
  uuid: 'u', issuer: 'I', label: 'L', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  algorithm: 'SHA1' as const, digits: 6 as const, period: 30, tagIds: [], order: 0, createdAt: 0,
}
// RFC 6238 附录 B 参考密钥 "12345678901234567890"（ASCII）对应 base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ

describe('computeEntryCode', () => {
  it('totp 分发并携带剩余秒数', async () => {
    const r = await computeEntryCode({ ...base, type: 'totp' }, 59_000)
    expect(r.code).toMatch(/^\d{6}$/)
    expect(r.period).toBe(30)
    expect(r.remaining).toBeGreaterThan(0)
    expect(r.remaining).toBeLessThanOrEqual(30)
  })

  it('hotp 窥视当前 counter 且不推进（纯函数天然不推进）', async () => {
    const e = { ...base, type: 'hotp' as const, counter: 5 }
    const r1 = await computeEntryCode(e, 59_000)
    const r2 = await computeEntryCode(e, 59_000)
    expect(r1.code).toBe(r2.code)
    expect(r2.counter).toBe(5)
  })

  it('RFC 6238 已知向量锚定（T=59, SHA1, 8位=94287082）', async () => {
    const r = await computeEntryCode({ ...base, type: 'totp', digits: 8 }, 59_000)
    expect(r.code).toBe('94287082')
  })

  it('unknown 类型抛错', async () => {
    await expect(computeEntryCode({ ...base, type: 'unknown' as never }, 59_000)).rejects.toThrow()
  })
})
