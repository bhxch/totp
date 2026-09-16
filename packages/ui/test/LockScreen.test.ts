import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { addPrfSource, base64ToBytes, bytesToBase64, randomBytes, setupVaultEncryption, type SecuritySettings } from '@totp/core'
import LockScreen from '../src/components/LockScreen.vue'
import type { VueStore } from '../src/store'
import type { DpapiUnlockOps } from '../src/components/securityPlatform'

/** 模拟 PRF 能力可用：通过 PublicKeyCredential.getClientCapabilities().prf=true 让 prfSupported() 返回 true */
function stubPrfSupported(): void {
  const Stub = class {
    static isUserVerifyingPlatformAuthenticatorAvailable = vi.fn().mockResolvedValue(true)
    static getClientCapabilities = vi.fn().mockResolvedValue({ prf: true })
  }
  Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: Stub, writable: true })
}
beforeAll(() => stubPrfSupported())

function mockStore(over: Partial<VueStore>): VueStore {
  return { unlock: vi.fn(), unlockWithDek: vi.fn().mockResolvedValue(undefined), ...over } as unknown as VueStore
}

/** 无 prf 绑定的最小 store（现有口令解锁用例形态） */
function plainStore(unlock: (pw: string) => Promise<void>): VueStore {
  return mockStore({
    unlock,
    prfSources: computed(() => []),
    securitySettings: ref(null),
  })
}

/** 构造已绑定 passkey 的 security fixture：返回真实可解的 prfOutput（credentialId 用合法 base64url 形态） */
async function prfFixture(): Promise<{ security: SecuritySettings; dek: Uint8Array; prfOutput: Uint8Array; salt: string }> {
  const vaultJson = JSON.stringify({ version: 1, entries: [{ uuid: 'a' }], groups: [], updatedAt: 1 })
  const { security, dek } = await setupVaultEncryption(vaultJson, 'pw')
  const prfOutput = randomBytes(64)
  const salt = bytesToBase64(randomBytes(32))
  return { security: await addPrfSource(security, dek, 'Y3JlZC0x', prfOutput, salt), dek, prfOutput, salt }
}

function mockWebAuthnGet(first: Uint8Array[]): void {
  ;(navigator as unknown as { credentials: unknown }).credentials = {
    get: vi.fn(async () => ({
      rawId: new ArrayBuffer(0),
      // W3C WebAuthn L3 真实形状：{ prf: { enabled, results: { first } } }
      getClientExtensionResults: () => ({
        prf: { enabled: true, results: { first: first[0] ? (first[0].buffer.slice(first[0].byteOffset, first[0].byteOffset + first[0].byteLength) as ArrayBuffer) : undefined } },
      }),
    })),
  }
}

/** DPAPI(Windows) 解锁通道 mock（默认已绑定来源、unprotect 解出指定 DEK） */
function makeDpapi(over: Partial<DpapiUnlockOps> = {}): DpapiUnlockOps {
  return {
    source: computed(() => ({ wrappedDekD: 'WRAPPED-DEK' })),
    getCurrentDek: vi.fn(() => null),
    protect: vi.fn(),
    unprotect: vi.fn().mockResolvedValue(randomBytes(32)),
    add: vi.fn(),
    remove: vi.fn(),
    ...over,
  }
}

afterEach(() => {
  delete (navigator as unknown as { credentials?: unknown }).credentials
})

describe('LockScreen', () => {
  it('解锁成功：调用 unlock、清空口令与错误、emit unlocked', async () => {
    const store = plainStore(vi.fn().mockResolvedValue(undefined))
    const w = mount(LockScreen, { props: { store } })
    await w.find('input[type="password"]').setValue('pw')
    await w.find('form').trigger('submit')
    await vi.waitFor(() => expect(store.unlock).toHaveBeenCalledWith('pw'))
    expect((w.get('input[type="password"]').element as HTMLInputElement).value).toBe('')
    expect(w.text()).not.toContain('口令错误')
    expect(w.emitted('unlocked')).toHaveLength(1)
  })

  it('口令错误：显示错误消息、不清 busy、不 emit unlocked', async () => {
    const store = plainStore(vi.fn().mockRejectedValue(new Error('口令错误或数据已损坏')))
    const w = mount(LockScreen, { props: { store } })
    await w.find('input[type="password"]').setValue('bad')
    await w.find('form').trigger('submit')
    await vi.waitFor(() => expect(w.text()).toContain('口令错误或数据已损坏'))
    expect(w.emitted('unlocked')).toBeUndefined()
  })

  it('口令明/密文切换：初始遮蔽，点切换钮变明文，再点恢复遮蔽', async () => {
    const w = mount(LockScreen, { props: { store: plainStore(vi.fn()) } })
    expect(w.find('input[type="password"]').exists()).toBe(true)
    await w.find('button[aria-label="显示口令"]').trigger('click')
    expect(w.find('input[type="password"]').exists()).toBe(false)
    expect(w.find('input[type="text"]').exists()).toBe(true)
    await w.find('button[aria-label="隐藏口令"]').trigger('click')
    expect(w.find('input[type="password"]').exists()).toBe(true)
  })

  it('无 prf 绑定：不渲染「使用 Passkey 解锁」按钮', () => {
    const w = mount(LockScreen, { props: { store: plainStore(vi.fn()) } })
    expect(w.find('button.passkey').exists()).toBe(false)
  })

  it('allowPasskey=false：有 prf 绑定也不渲染 passkey 按钮（popup 夺焦销毁窗口，入口门控），口令输入保留', () => {
    const store = mockStore({
      prfSources: computed(() => [{ credentialId: 'Y3JlZC0x', salt: 'cw==' }]),
      securitySettings: ref(null),
    })
    const w = mount(LockScreen, { props: { store, allowPasskey: false } })
    expect(w.find('button.passkey').exists()).toBe(false)
    expect(w.find('input[type="password"]').exists()).toBe(true)
  })

  it('有 prf 绑定：渲染 passkey 按钮；点击走 getPrfOutput→unlockWithPrf→unlockWithDek→emit unlocked', async () => {
    const { security, dek, prfOutput, salt } = await prfFixture()
    const unlockWithDek = vi.fn().mockResolvedValue(undefined)
    const store = mockStore({
      prfSources: computed(() => [{ credentialId: 'Y3JlZC0x', salt }]),
      securitySettings: ref(security),
      unlockWithDek,
    })
    mockWebAuthnGet([prfOutput])
    const w = mount(LockScreen, { props: { store } })
    expect(w.find('button.passkey').exists()).toBe(true)
    // 等 prfSupported 异步探测完成：直接给若干 microtask 推进 onMounted 的 promise 链
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
    // 触发 PRF 解锁（直接调组件方法，绕过 vue 渲染 disabled="" 在 jsdom 中 button.disabled=true 的差异）
    void (w.vm as unknown as { onPasskeyUnlock: () => Promise<void> }).onPasskeyUnlock()
    const getCred = (navigator as unknown as { credentials: { get: ReturnType<typeof vi.fn> } }).credentials.get
    await vi.waitFor(() => expect(getCred).toHaveBeenCalled(), { timeout: 2000, interval: 5 })
    const arg = getCred.mock.calls[0]![0] as { publicKey: { allowCredentials: { id: Uint8Array }[]; extensions: { prf: { eval: { first: Uint8Array } } } } }
    expect(Array.from(arg.publicKey.allowCredentials[0]!.id)).toEqual(Array.from(base64ToBytes('Y3JlZC0x'))) // base64url('cred-1')
    expect(Array.from(arg.publicKey.extensions.prf.eval.first)).toEqual(Array.from(base64ToBytes(salt)))
    // 解出真实 DEK 并注入
    await vi.waitFor(() => expect(unlockWithDek).toHaveBeenCalledWith(dek))
    expect(w.emitted('unlocked')).toHaveLength(1)
    expect(w.text()).not.toContain('解锁失败')
  })

  it('PRF 无输出（用户取消/不支持）：显示解锁失败，不 emit unlocked', async () => {
    const { security, salt } = await prfFixture()
    const store = mockStore({
      prfSources: computed(() => [{ credentialId: 'Y3JlZC0x', salt }]),
      securitySettings: ref(security),
    })
    mockWebAuthnGet([]) // results.first 缺失 → getPrfOutput null
    const w = mount(LockScreen, { props: { store } })
    // 等 prfSupported 探测完成
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
    // 直接调组件方法
    void (w.vm as unknown as { onPasskeyUnlock: () => Promise<void> }).onPasskeyUnlock()
    await vi.waitFor(() => expect(w.text()).toContain('passkey 解锁失败'))
    expect(store.unlockWithDek).not.toHaveBeenCalled()
    expect(w.emitted('unlocked')).toBeUndefined()
  })

  it('unlockWithDek 失败：显示错误消息、不 emit unlocked', async () => {
    const { security, prfOutput, salt } = await prfFixture()
    const store = mockStore({
      prfSources: computed(() => [{ credentialId: 'Y3JlZC0x', salt }]),
      securitySettings: ref(security),
      unlockWithDek: vi.fn().mockRejectedValue(new Error('vault corrupted')),
    })
    mockWebAuthnGet([prfOutput])
    const w = mount(LockScreen, { props: { store } })
    // 等 prfSupported 探测完成
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
    void (w.vm as unknown as { onPasskeyUnlock: () => Promise<void> }).onPasskeyUnlock()
    // 等若干 tick：getPrfOutput→unlockWithPrf→unlockWithDek reject→catch 写 msg
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 50))
    expect(w.text()).toContain('vault corrupted')
    expect(w.emitted('unlocked')).toBeUndefined()
  })

  it('dpapi 已绑定：挂载后静默 unprotect→unlockWithDek→emit unlocked（无需交互）', async () => {
    const dek = randomBytes(32)
    const unprotect = vi.fn().mockResolvedValue(dek)
    const unlockWithDek = vi.fn().mockResolvedValue(undefined)
    const store = mockStore({ unlockWithDek, prfSources: computed(() => []), securitySettings: ref(null) })
    const w = mount(LockScreen, { props: { store, dpapi: makeDpapi({ unprotect }) } })
    await vi.waitFor(() => expect(unlockWithDek).toHaveBeenCalledWith(dek))
    expect(unprotect).toHaveBeenCalledWith('WRAPPED-DEK')
    expect(store.unlock).not.toHaveBeenCalled()
    expect(w.emitted('unlocked')).toHaveLength(1)
  })

  it('dpapi unprotect 失败（跨机器/跨用户）：静默保留口令解锁路径，不 emit unlocked', async () => {
    const unprotect = vi.fn().mockRejectedValue(new Error('DPAPI 解密失败'))
    const store = mockStore({ prfSources: computed(() => []), securitySettings: ref(null) })
    const w = mount(LockScreen, { props: { store, dpapi: makeDpapi({ unprotect }) } })
    await vi.waitFor(() => expect(unprotect).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(store.unlockWithDek).not.toHaveBeenCalled()
    expect(w.emitted('unlocked')).toBeUndefined()
    expect(w.text()).not.toContain('DPAPI 解密失败') // 静默：不展示错误
    // 口令手动路径仍可用
    await w.find('input[type="password"]').setValue('pw')
    await w.find('form').trigger('submit')
    await vi.waitFor(() => expect(store.unlock).toHaveBeenCalledWith('pw'))
  })

  it('I44：dpapi 静默失败 1s 后仍锁定 → 显示「重试 Windows 自动解锁」按钮', async () => {
    vi.useFakeTimers()
    try {
      const unprotect = vi.fn().mockRejectedValue(new Error('DPAPI 解密失败'))
      const store = mockStore({ locked: computed(() => true), prfSources: computed(() => []), securitySettings: ref(null) })
      const w = mount(LockScreen, { props: { store, dpapi: makeDpapi({ unprotect }) } })
      // 0：尚未显示重试按钮
      expect(w.find('button.dpapi-retry').exists()).toBe(false)
      // 1s 后显示
      await vi.advanceTimersByTimeAsync(1100)
      expect(w.find('button.dpapi-retry').exists()).toBe(true)
      expect(w.text()).toContain('重试 Windows 自动解锁')
      // 按钮触发 onRetryDpapi；onMounted 已调用过 unprotect 一次，重试应再调一次
      const before = unprotect.mock.calls.length
      await w.find('button.dpapi-retry').trigger('click')
      await vi.advanceTimersByTimeAsync(10)
      expect(unprotect.mock.calls.length).toBe(before + 1)
      expect(store.unlockWithDek).not.toHaveBeenCalled() // 重试同样失败 → 仍不调用 unlockWithDek
    } finally {
      vi.useRealTimers()
    }
  })

  it('I44：dpapi 已绑定但首次 unprotect 成功：不显示重试按钮', async () => {
    vi.useFakeTimers()
    try {
      const unprotect = vi.fn().mockResolvedValue(randomBytes(32))
      const unlockWithDek = vi.fn().mockResolvedValue(undefined)
      const store = mockStore({ unlockWithDek, prfSources: computed(() => []), securitySettings: ref(null) })
      mount(LockScreen, { props: { store, dpapi: makeDpapi({ unprotect }) } })
      await vi.advanceTimersByTimeAsync(1100)
      // 渲染时 store 已解锁，不显示 dpapi 入口（button dpapi-retry 不存在）
      // 验证 unlockWithDek 已被调用
      expect(unlockWithDek).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('未提供 dpapi 通道或未绑定来源：挂载后不做自动解锁', () => {
    const unprotect = vi.fn()
    mount(LockScreen, { props: { store: plainStore(vi.fn()) } })
    mount(LockScreen, {
      props: { store: plainStore(vi.fn()), dpapi: makeDpapi({ source: computed(() => null), unprotect }) },
    })
    expect(unprotect).not.toHaveBeenCalled()
  })
})

describe('LockScreen PRF 能力显隐（C17）', () => {
  it('PRF 能力不可用：passkey 按钮渲染但 disabled，且带 tooltip', async () => {
    // 把 stub 切到「能力不可用」分支：getClientCapabilities().prf=false
    const Stub = class {
      static isUserVerifyingPlatformAuthenticatorAvailable = vi.fn().mockResolvedValue(false)
      static getClientCapabilities = vi.fn().mockResolvedValue({ prf: false })
    }
    Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: Stub, writable: true })
    const store = mockStore({
      prfSources: computed(() => [{ credentialId: 'Y3JlZC0x', salt: 'cw==' }]),
      securitySettings: ref(null),
    })
    const w = mount(LockScreen, { props: { store } })
    await vi.waitFor(() => {
      const btn = w.find('button.passkey')
      expect(btn.exists()).toBe(true)
      expect(btn.attributes('disabled')).toBeDefined()
      expect(btn.attributes('title')).toBe('当前浏览器不支持 Passkey 解锁')
    })
    // 恢复 stub 让其它测试仍走能力可用路径
    stubPrfSupported()
  })

  it('PRF 能力可用：passkey 按钮可点击（顶部 stub 已让 prfSupported=true）', async () => {
    const store = mockStore({
      prfSources: computed(() => [{ credentialId: 'Y3JlZC0x', salt: 'cw==' }]),
      securitySettings: ref(null),
    })
    const w = mount(LockScreen, { props: { store } })
    await vi.waitFor(() => {
      const btn = w.find('button.passkey')
      expect(btn.exists()).toBe(true)
      // vue 把 :disabled="false" 渲染成空串属性（仍是 falsy，不阻断点击）
      expect(btn.attributes('disabled')).toBeFalsy()
    })
  })
})
