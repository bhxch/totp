import { describe, expect, it, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { useOtpCodes } from '../src/composables/useOtpCodes'
import type { OtpEntry } from '@totp/core'

// 向量与 packages/core/test/yandex.test.ts 同源（scripts/gen-yaotp-vectors.mjs 产出）
const SECRET = 'KJTEUGOD5SNXVWBCWJ4G36W4IA'

const yandexEntry: OtpEntry = {
  uuid: 'ya', type: 'yandex', issuer: 'Yandex', label: 'user', secret: SECRET,
  algorithm: 'SHA256', digits: 8, period: 30, pin: '1234', tagIds: [], order: 0, createdAt: 0,
}

describe('useOtpCodes yandex 分支', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('yandex 条目按 pin+SHA256 计算 8 位小写字母码（固定时刻对齐黄金向量）', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    const { codes } = useOtpCodes(ref([yandexEntry]))
    await vi.waitFor(() => expect(codes.value.get('ya')).toBeDefined())
    const c = codes.value.get('ya')!
    expect(c.code).toBe('vaxzahfg')
    expect(c.error).toBeUndefined()
  })

  it('无 pin（缺省）也产出 8 位字母码，不进 INVALID', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000)
    const noPin: OtpEntry = { ...yandexEntry, uuid: 'np' }
    delete (noPin as { pin?: string }).pin
    const { codes } = useOtpCodes(ref([noPin]))
    await vi.waitFor(() => expect(codes.value.get('np')).toBeDefined())
    const c = codes.value.get('np')!
    expect(c.code).toMatch(/^[a-z]{8}$/)
    expect(c.code).not.toBe('INVALID')
  })

  it('secret 非法 → INVALID（分支内异常照常兜底）', async () => {
    const bad: OtpEntry = { ...yandexEntry, uuid: 'bad', secret: '!!!非法!!!' }
    const { codes } = useOtpCodes(ref([bad]))
    await vi.waitFor(() => expect(codes.value.get('bad')).toBeDefined())
    expect(codes.value.get('bad')!.code).toBe('INVALID')
  })
})
