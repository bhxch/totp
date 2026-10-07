import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { randomBytes } from '@totp/core'
import LockScreen from '../src/components/LockScreen.vue'
import type { VueStore } from '../src/store'
import type { AbeOps, AbeResult, DpapiUnlockOps } from '../src/components/securityPlatform'
import { createTestI18n } from './helpers/i18n'

/** plan p6 §0.3：锁屏静默解锁 ABE 优先、DPAPI 无声回退。
 *  顺序语义：abeSource 非空 && 宿主传入 abe && supported → 先试 abe.unwrap()；
 *  失败（异常/返回 null/服务不可达）→ 回退现有 dpapi 静默路径（零改动语义）；
 *  两者皆败维持 1s 后「重试」UI；abe 失败信息 console.warn 留痕不打断 UI */

function mockStore(over: Partial<VueStore>): VueStore {
  return {
    unlock: vi.fn(),
    unlockWithDek: vi.fn().mockResolvedValue(undefined),
    prfSources: computed(() => []),
    securitySettings: ref(null),
    // VueStore 契约：abeSource 为 ComputedRef（未绑定即恒值 null），非裸 null
    abeSource: computed(() => null),
    ...over,
  } as unknown as VueStore
}

/** 已绑定 abe 标记源的 store（_LOCKED 无关紧要——LockScreen 只读 abeSource 非空与否） */
function storeWithAbe(over: Partial<VueStore> = {}): VueStore {
  return mockStore({ abeSource: computed(() => ({ kind: 'abe' })), ...over })
}

/** ABE 通道 mock（默认 supported、unwrap 解出指定 DEK） */
function makeAbe(over: Partial<AbeOps> = {}): AbeOps {
  return {
    supported: true,
    status: vi.fn().mockResolvedValue(null),
    bind: vi.fn().mockResolvedValue(true),
    // C1 终审：绑定编排新增成员（LockScreen 不消费，桩为成功语义即可）
    wrap: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue({ ok: true } as AbeResult),
    addSource: vi.fn().mockResolvedValue(undefined),
    removeSource: vi.fn().mockResolvedValue(undefined),
    unwrap: vi.fn().mockResolvedValue(randomBytes(32)),
    ...over,
  }
}

/** DPAPI 通道 mock（形态同 LockScreen.test.ts：默认已绑定、unprotect 解出指定 DEK） */
function makeDpapi(over: Partial<DpapiUnlockOps> = {}): DpapiUnlockOps {
  return {
    source: computed(() => ({ wrappedDekD: 'WRAPPED-DEK' })),
    getCurrentDek: vi.fn(() => null),
    protect: vi.fn(),
    unprotect: vi.fn().mockResolvedValue(randomBytes(32)),
    add: vi.fn(),
    remove: vi.fn(),
    label: 'Windows 自动解锁',
    ...over,
  }
}

/** LockScreen props 的具体类型（Record<string, unknown> 过不了 vue-tsc 组件 props 检查） */
type LockScreenProps = { store: VueStore; dpapi?: DpapiUnlockOps | null; abe?: AbeOps | null }

function mountScreen(props: LockScreenProps) {
  return mount(LockScreen, { props, global: { plugins: [createTestI18n()] } })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LockScreen 静默解锁 abe→dpapi 回退（plan p6 §0.3）', () => {
  it('abe 成功：unwrap→unlockWithDek→emit unlocked，不试 dpapi', async () => {
    const dek = randomBytes(32)
    const unwrap = vi.fn().mockResolvedValue(dek)
    const unprotect = vi.fn()
    const unlockWithDek = vi.fn().mockResolvedValue(undefined)
    const store = storeWithAbe({ unlockWithDek })
    const w = mountScreen({ store, dpapi: makeDpapi({ unprotect }), abe: makeAbe({ unwrap }) })
    await vi.waitFor(() => expect(unlockWithDek).toHaveBeenCalledWith(dek))
    expect(unwrap).toHaveBeenCalledTimes(1)
    expect(unprotect).not.toHaveBeenCalled()
    expect(store.unlock).not.toHaveBeenCalled()
    expect(w.emitted('unlocked')).toHaveLength(1)
  })

  it('abe 返回 null（服务不可达/未装/被拒）：console.warn 留痕，无声回退 dpapi 成功', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dpapiDek = randomBytes(32)
    const unprotect = vi.fn().mockResolvedValue(dpapiDek)
    const unlockWithDek = vi.fn().mockResolvedValue(undefined)
    const store = storeWithAbe({ unlockWithDek })
    const w = mountScreen({ store, dpapi: makeDpapi({ unprotect }), abe: makeAbe({ unwrap: vi.fn().mockResolvedValue(null) }) })
    await vi.waitFor(() => expect(unprotect).toHaveBeenCalledWith('WRAPPED-DEK'))
    await vi.waitFor(() => expect(unlockWithDek).toHaveBeenCalledWith(dpapiDek))
    expect(w.emitted('unlocked')).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    // 静默回退：不展示 abe 失败错误
    expect(w.text()).not.toContain('ABE')
  })

  it('abe 抛异常（Unexpected）：同样无声回退 dpapi 成功', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dpapiDek = randomBytes(32)
    const unprotect = vi.fn().mockResolvedValue(dpapiDek)
    const unlockWithDek = vi.fn().mockResolvedValue(undefined)
    const store = storeWithAbe({ unlockWithDek })
    const w = mountScreen({ store, dpapi: makeDpapi({ unprotect }), abe: makeAbe({ unwrap: vi.fn().mockRejectedValue(new Error('pipe broken')) }) })
    await vi.waitFor(() => expect(unlockWithDek).toHaveBeenCalledWith(dpapiDek))
    expect(unprotect).toHaveBeenCalledTimes(1)
    expect(w.emitted('unlocked')).toHaveLength(1)
  })

  it('两者皆败：abe 失败回退 dpapi 也失败 → 1s 后显示「重试 Windows 自动解锁」', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const unprotect = vi.fn().mockRejectedValue(new Error('DPAPI 解密失败'))
      const store = storeWithAbe({ locked: computed(() => true) })
      const w = mountScreen({ store, dpapi: makeDpapi({ unprotect }), abe: makeAbe({ unwrap: vi.fn().mockRejectedValue(new Error('unavailable')) }) })
      expect(w.find('button.dpapi-retry').exists()).toBe(false)
      await vi.advanceTimersByTimeAsync(1100)
      expect(w.find('button.dpapi-retry').exists()).toBe(true)
      expect(store.unlockWithDek).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('未传 abe prop（extension 宿主）：abeSource 非空也直接走 dpapi，不触碰 abe', async () => {
    const dpapiDek = randomBytes(32)
    const unprotect = vi.fn().mockResolvedValue(dpapiDek)
    const unlockWithDek = vi.fn().mockResolvedValue(undefined)
    const store = storeWithAbe({ unlockWithDek })
    const w = mountScreen({ store, dpapi: makeDpapi({ unprotect }) })
    await vi.waitFor(() => expect(unlockWithDek).toHaveBeenCalledWith(dpapiDek))
    expect(w.emitted('unlocked')).toHaveLength(1)
  })

  it('supported=false（非 Windows 桩）或 abeSource 未绑定：跳过 abe 直接 dpapi', async () => {
    const dpapiDek = randomBytes(32)
    const unprotect = vi.fn().mockResolvedValue(dpapiDek)
    const never = vi.fn()
    // supported=false
    const w1 = mountScreen({
      store: storeWithAbe(),
      dpapi: makeDpapi({ unprotect }),
      abe: makeAbe({ supported: false, unwrap: never }),
    })
    await vi.waitFor(() => expect(w1.emitted('unlocked')).toHaveLength(1))
    expect(never).not.toHaveBeenCalled()
    // abeSource null
    unprotect.mockClear()
    const w2 = mountScreen({
      store: mockStore({}),
      dpapi: makeDpapi({ unprotect }),
      abe: makeAbe({ unwrap: never }),
    })
    await vi.waitFor(() => expect(w2.emitted('unlocked')).toHaveLength(1))
    expect(never).not.toHaveBeenCalled()
  })
})
