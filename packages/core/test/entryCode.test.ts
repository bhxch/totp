import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

  it('steam 已知向量（同源 test/vectors/steam.json，与 steam.test.ts 对拍参考实现共用）', async () => {
    const vec = JSON.parse(
      readFileSync(fileURLToPath(new URL('./vectors/steam.json', import.meta.url)), 'utf8'),
    ) as { secretBase32: string; vectors: Array<{ tMs: number; code: string }> }
    for (const v of vec.vectors) {
      const r = await computeEntryCode({ ...base, type: 'steam', secret: vec.secretBase32 }, v.tMs)
      expect(r.code).toBe(v.code)
    }
  })

  it('yandex 黄金向量（抄自 test/yandex.test.ts VECTORS，对齐 Aegis YAOTP.java；条目需 pin 字段且 digits=8）', async () => {
    // 覆盖不同 pin 与 period 的两条；secret 为 26 字符自洽校验形态（yandex.test.ts 同款）
    const cases = [
      { pin: '1234', period: 30, timeMs: 1700000000000, code: 'vaxzahfg' },
      { pin: '0000', period: 60, timeMs: 1700000060000, code: 'ywxgaaht' },
    ] as const
    for (const v of cases) {
      const r = await computeEntryCode(
        { ...base, type: 'yandex', secret: 'KJTEUGOD5SNXVWBCWJ4G36W4IA', pin: v.pin, period: v.period, digits: 8 },
        v.timeMs,
      )
      expect(r.code).toBe(v.code)
    }
  })
})
