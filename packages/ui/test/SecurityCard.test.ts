import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import SecurityCard from '../src/components/SecurityCard.vue'
import type { DpapiUnlockOps, SecurityOps, SecurityPlatform } from '../src/components/securityPlatform'

function makeSecurity(over: Partial<SecurityOps> = {}): SecurityOps {
  return {
    locked: ref(false),
    hasEncryption: computed(() => false),
    enableEncryption: vi.fn().mockResolvedValue(undefined),
    disableEncryption: vi.fn().mockResolvedValue(undefined),
    changePassphrase: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

function makePlatform(over: Partial<SecurityPlatform> = {}): SecurityPlatform {
  return {
    security: makeSecurity(),
    clipboardClearEnabled: computed(() => true),
    setClipboardClear: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

/** 已启用且解锁的 security */
function unlockedSecurity(over: Partial<SecurityOps> = {}): SecurityOps {
  return makeSecurity({ hasEncryption: computed(() => true), ...over })
}

/** DPAPI(Windows) 解锁能力 mock（默认未绑定来源） */
function makeDpapi(over: Partial<DpapiUnlockOps> = {}): DpapiUnlockOps {
  return {
    source: computed(() => null),
    getCurrentDek: vi.fn(() => new Uint8Array(32).fill(7)),
    protect: vi.fn().mockResolvedValue('WRAPPED-DEK'),
    unprotect: vi.fn().mockResolvedValue(new Uint8Array(32)),
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

describe('SecurityCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('platform 为 null 不渲染', () => {
    const w = mount(SecurityCard, { props: { platform: null } })
    expect(w.find('section.security').exists()).toBe(false)
  })

  it('未启用：两次口令不一致不调用 enableEncryption', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('a')
    await inputs[1]!.setValue('b')
    await w.find('button.enable-enc').trigger('click')
    expect(p.security!.enableEncryption).not.toHaveBeenCalled()
    expect(w.text()).toContain('不一致')
  })

  it('未启用：口令一致调用 enableEncryption', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('a')
    await inputs[1]!.setValue('a')
    await w.find('button.enable-enc').trigger('click')
    await vi.waitFor(() => expect(p.security!.enableEncryption).toHaveBeenCalledWith('a'))
  })

  it('未启用：提示浏览器同步数据在启用加密后也将是密文；已启用态不显示该说明', () => {
    const disabled = mount(SecurityCard, { props: { platform: makePlatform() } })
    expect(disabled.text()).toContain('启用后浏览器同步的数据也将是密文')
    const enabled = mount(SecurityCard, { props: { platform: makePlatform({ security: unlockedSecurity() }) } })
    expect(enabled.text()).not.toContain('浏览器同步的数据也将是密文')
  })

  it('已启用解锁态：渲染换口令与关闭加密按钮；换口令一致后调用 changePassphrase', async () => {
    const p = makePlatform({ security: unlockedSecurity() })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.find('button.change-pw').exists()).toBe(true)
    expect(w.find('button.disable-enc').exists()).toBe(true)
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('n1')
    await inputs[1]!.setValue('n1')
    await w.find('button.change-pw').trigger('click')
    await vi.waitFor(() => expect(p.security!.changePassphrase).toHaveBeenCalledWith('n1'))
  })

  it('C18：解锁方式区显示"口令 默认解锁方式，不可移除"明示文案', async () => {
    // 注入 passkey ops 让「解锁方式」区渲染；不解锁 passkey 探测以聚焦口令行
    const passkey = { sources: computed(() => []), prfSupported: vi.fn().mockResolvedValue(true), add: vi.fn(), remove: vi.fn() }
    const p = makePlatform({ security: makeSecurity({ hasEncryption: computed(() => true), locked: ref(false), passkey }) })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.text()).toContain('解锁方式')
    expect(w.text()).toContain('口令')
    expect(w.text()).toContain('默认解锁方式，不可移除')
  })

  it('关闭加密：先显示明文警示，确认后才调用 disableEncryption', async () => {
    const p = makePlatform({ security: unlockedSecurity() })
    const w = mount(SecurityCard, { props: { platform: p } })
    await w.find('button.disable-enc').trigger('click')
    expect(p.security!.disableEncryption).not.toHaveBeenCalled()
    expect(w.text()).toContain('明文存储')
    const confirm = w.findAll('button').find((b) => b.text() === '确认关闭')!
    await confirm.trigger('click')
    await vi.waitFor(() => expect(p.security!.disableEncryption).toHaveBeenCalled())
  })

  it('锁定态：显示已锁定提示且不渲染加密操作入口', () => {
    const p = makePlatform({ security: unlockedSecurity({ locked: ref(true) }) })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.text()).toContain('已锁定')
    expect(w.find('button.enable-enc').exists()).toBe(false)
    expect(w.find('button.change-pw').exists()).toBe(false)
    expect(w.find('button.disable-enc').exists()).toBe(false)
  })

  it('剪贴板 checkbox 触发 setClipboardClear', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    await w.find('input.clipboard-clear').setValue(false)
    expect(p.setClipboardClear).toHaveBeenCalledWith(false)
  })

  it('popupCloseDelayMs：platform 提供时渲染数字输入并触发 setPopupCloseDelay；未提供时不渲染', async () => {
    const without = mount(SecurityCard, { props: { platform: makePlatform() } })
    expect(without.find('input.delay-ms').exists()).toBe(false)

    const setPopupCloseDelay = vi.fn().mockResolvedValue(undefined)
    const p = makePlatform({ popupCloseDelayMs: computed(() => 2000), setPopupCloseDelay })
    const w = mount(SecurityCard, { props: { platform: p } })
    const input = w.find('input.delay-ms')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('2000')
    await input.setValue(3500)
    expect(setPopupCloseDelay).toHaveBeenCalledWith(3500)
  })

  it('platform 无 dpapi 能力：不渲染 DPAPI 行与启用按钮', () => {
    const w = mount(SecurityCard, { props: { platform: makePlatform({ security: unlockedSecurity() }) } })
    expect(w.find('button.enable-dpapi').exists()).toBe(false)
    expect(w.find('.dpapi-row').exists()).toBe(false)
  })

  it('dpapi 未绑定：显示启用按钮；点击走 getCurrentDek→protect→add 并提示成功', async () => {
    const dek = new Uint8Array(32).fill(7)
    const dpapi = makeDpapi({ getCurrentDek: vi.fn(() => dek) })
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) },
    })
    expect(w.text()).toContain('解锁方式')
    const btn = w.find('button.enable-dpapi')
    expect(btn.exists()).toBe(true)
    expect(w.find('.dpapi-row').exists()).toBe(false)
    await btn.trigger('click')
    await vi.waitFor(() => expect(dpapi.add).toHaveBeenCalledWith('WRAPPED-DEK'))
    expect(dpapi.protect).toHaveBeenCalledWith(dek)
    expect(w.text()).toContain('Windows 自动解锁已启用')
  })

  it('dpapi 已绑定：显示 DPAPI 行与移除按钮，点击调用 remove', async () => {
    const dpapi = makeDpapi({ source: computed(() => ({ wrappedDekD: 'WRAPPED-DEK' })) })
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) },
    })
    expect(w.find('button.enable-dpapi').exists()).toBe(false)
    expect(w.find('.dpapi-row').exists()).toBe(true)
    expect(w.text()).toContain('Windows 自动解锁（DPAPI）')
    await w.find('button.remove-dpapi').trigger('click')
    await vi.waitFor(() => expect(dpapi.remove).toHaveBeenCalled())
    expect(w.text()).toContain('Windows 自动解锁已移除')
  })

  it('dpapi 启用时无可用 DEK（锁定态残留）：提示错误且不调用 protect', async () => {
    const dpapi = makeDpapi({ getCurrentDek: vi.fn(() => null) })
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) },
    })
    await w.find('button.enable-dpapi').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('需先解锁'))
    expect(dpapi.protect).not.toHaveBeenCalled()
    expect(dpapi.add).not.toHaveBeenCalled()
  })

  it('dpapi protect 失败：展示错误消息且不调用 add', async () => {
    const dpapi = makeDpapi({ protect: vi.fn().mockRejectedValue(new Error('仅 Windows 支持')) })
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) },
    })
    await w.find('button.enable-dpapi').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('仅 Windows 支持'))
    expect(dpapi.add).not.toHaveBeenCalled()
  })
})
