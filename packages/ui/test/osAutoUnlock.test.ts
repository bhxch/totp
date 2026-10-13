import { describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { randomBytes } from '@totp/core'
import { attemptOsAutoUnlock } from '../src/components/osAutoUnlock'
import type { VueStore } from '../src/store'
import type { AbeOps, DpapiUnlockOps } from '../src/components/securityPlatform'

function mockStore(over: Partial<VueStore> = {}): VueStore {
  return {
    abeSource: computed(() => null),
    unlockWithDek: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as VueStore
}

function makeDpapi(over: Partial<DpapiUnlockOps> = {}): DpapiUnlockOps {
  return {
    label: 'Windows 自动解锁',
    techSuffix: '',
    source: computed(() => ({ wrappedDekD: 'WRAPPED' })),
    getCurrentDek: () => null,
    protect: vi.fn(),
    unprotect: vi.fn().mockResolvedValue(randomBytes(32)),
    add: vi.fn(),
    remove: vi.fn(),
    ...over,
  }
}

function makeAbe(over: Partial<AbeOps> = {}): AbeOps {
  return {
    supported: true,
    source: computed(() => ({ kind: 'abe' })),
    status: vi.fn(),
    bind: vi.fn(),
    wrap: vi.fn(),
    remove: vi.fn(),
    addSource: vi.fn(),
    removeSource: vi.fn(),
    unwrap: vi.fn().mockResolvedValue(randomBytes(32)),
    ...over,
  }
}

describe('attemptOsAutoUnlock', () => {
  it('ABE 成功：unwrap→unlockWithDek→true，不触 DPAPI', async () => {
    const dek = randomBytes(32)
    const unlockWithDek = vi.fn().mockResolvedValue(undefined)
    const dpapi = makeDpapi()
    const ok = await attemptOsAutoUnlock(mockStore({ abeSource: computed(() => ({ kind: 'abe' })), unlockWithDek }), dpapi, makeAbe({ unwrap: vi.fn().mockResolvedValue(dek) }))
    expect(ok).toBe(true)
    expect(unlockWithDek).toHaveBeenCalledWith(dek)
    expect(dpapi.unprotect).not.toHaveBeenCalled()
  })

  it('ABE 失败（null/异常/注入失败）：无声回退 DPAPI', async () => {
    const dek = randomBytes(32)
    const unlockWithDek = vi.fn()
      .mockRejectedValueOnce(new Error('inject fail'))
      .mockResolvedValueOnce(undefined)
    const store = mockStore({ abeSource: computed(() => ({ kind: 'abe' })), unlockWithDek })
    const ok = await attemptOsAutoUnlock(store, makeDpapi({ unprotect: vi.fn().mockResolvedValue(dek) }), makeAbe({ unwrap: vi.fn().mockResolvedValue(dek) }))
    expect(ok).toBe(true)
    expect(store.unlockWithDek).toHaveBeenCalledTimes(2)
  })

  it('ABE 失败且 DPAPI 也失败：false 静默（不抛错）', async () => {
    const store = mockStore({ abeSource: computed(() => ({ kind: 'abe' })) })
    const ok = await attemptOsAutoUnlock(
      store,
      makeDpapi({ unprotect: vi.fn().mockRejectedValue(new Error('DPAPI 解密失败')) }),
      makeAbe({ unwrap: vi.fn().mockRejectedValue(new Error('服务不可达')) }),
    )
    expect(ok).toBe(false)
    expect(store.unlockWithDek).not.toHaveBeenCalled()
  })

  it('无 ABE 绑定：直接走 DPAPI', async () => {
    const dek = randomBytes(32)
    const abe = makeAbe({ unwrap: vi.fn() })
    const ok = await attemptOsAutoUnlock(mockStore(), makeDpapi({ unprotect: vi.fn().mockResolvedValue(dek) }), abe)
    expect(ok).toBe(true)
    expect(abe.unwrap).not.toHaveBeenCalled()
  })

  it('无任何通道/未绑定来源：false 且不发起任何调用（Review Focus 1）', async () => {
    const dpapi = makeDpapi({ source: computed(() => null) })
    const store = mockStore()
    expect(await attemptOsAutoUnlock(store, dpapi, undefined)).toBe(false)
    expect(await attemptOsAutoUnlock(store, undefined, undefined)).toBe(false)
    expect(dpapi.unprotect).not.toHaveBeenCalled()
    expect(store.unlockWithDek).not.toHaveBeenCalled()
  })

  it('abe.supported=false（非 Windows）：跳过 ABE 直接 DPAPI', async () => {
    const dek = randomBytes(32)
    const abe = makeAbe({ supported: false, unwrap: vi.fn() })
    const ok = await attemptOsAutoUnlock(mockStore({ abeSource: computed(() => ({ kind: 'abe' })) }), makeDpapi({ unprotect: vi.fn().mockResolvedValue(dek) }), abe)
    expect(ok).toBe(true)
    expect(abe.unwrap).not.toHaveBeenCalled()
  })
})
