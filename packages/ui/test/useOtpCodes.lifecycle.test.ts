import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type Ref } from 'vue'
import { useOtpCodes } from '../src/composables/useOtpCodes'
import type { OtpEntry } from '@totp/core'

const entry: OtpEntry = {
  uuid: 'a', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_700_000_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useOtpCodes 定时器生命周期', () => {
  it('每秒重算：nowMs 随 interval 推进，codes 跟随刷新', async () => {
    const scope = effectScope()
    let api: ReturnType<typeof useOtpCodes> | null = null
    scope.run(() => { api = useOtpCodes(ref([entry]) as Ref<OtpEntry[]>) })
    const codes = api!.codes
    await vi.waitFor(() => expect(codes.value.get('a')).toBeDefined()) // 首轮 recompute
    const now0 = api!.nowMs.value
    await vi.advanceTimersByTimeAsync(1000)
    expect(api!.nowMs.value).toBe(now0 + 1000)
    scope.stop()
  })

  it('onScopeDispose 清理 interval：scope.stop 后不再重算', async () => {
    const scope = effectScope()
    let api: ReturnType<typeof useOtpCodes> | null = null
    scope.run(() => { api = useOtpCodes(ref([entry]) as Ref<OtpEntry[]>) })
    await vi.waitFor(() => expect(api!.codes.value.get('a')).toBeDefined())
    const now0 = api!.nowMs.value
    scope.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api!.nowMs.value).toBe(now0) // 定时器已清，nowMs 不再推进
  })

  it('entries 响应式：追加条目后下一轮重算纳入新码', async () => {
    const entries = ref<OtpEntry[]>([entry])
    const scope = effectScope()
    let api: ReturnType<typeof useOtpCodes> | null = null
    scope.run(() => { api = useOtpCodes(entries) })
    await vi.waitFor(() => expect(api!.codes.value.get('a')).toBeDefined())
    expect(api!.codes.value.has('b')).toBe(false)
    const bad: OtpEntry = { ...entry, uuid: 'b' }
    entries.value = [...entries.value, bad]
    await vi.advanceTimersByTimeAsync(1000) // 下一轮 interval 重算
    await vi.waitFor(() => expect(api!.codes.value.has('b')).toBe(true))
    scope.stop()
  })
})
