import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import { addPrfSource, base64ToBytes, bytesToBase64, randomBytes, setupVaultEncryption, type SecuritySettings } from '@totp/core'
import LockScreen from '../src/components/LockScreen.vue'
import type { VueStore } from '../src/store'
import type { DpapiUnlockOps } from '../src/components/securityPlatform'

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

  it('无 prf 绑定：不渲染「使用 Passkey 解锁」按钮', () => {
    const w = mount(LockScreen, { props: { store: plainStore(vi.fn()) } })
    expect(w.find('button.passkey').exists()).toBe(false)
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
    await w.find('button.passkey').trigger('click')
    // PRF 求值参数：allowCredentials 指定绑定凭据，eval.first = 绑定 salt
    const getCred = (navigator as unknown as { credentials: { get: ReturnType<typeof vi.fn> } }).credentials.get
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
    await w.find('button.passkey').trigger('click')
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
    await w.find('button.passkey').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('vault corrupted'))
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

  it('未提供 dpapi 通道或未绑定来源：挂载后不做自动解锁', () => {
    const unprotect = vi.fn()
    mount(LockScreen, { props: { store: plainStore(vi.fn()) } })
    mount(LockScreen, {
      props: { store: plainStore(vi.fn()), dpapi: makeDpapi({ source: computed(() => null), unprotect }) },
    })
    expect(unprotect).not.toHaveBeenCalled()
  })
})
