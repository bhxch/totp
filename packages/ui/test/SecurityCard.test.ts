import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import SecurityCard from '../src/components/SecurityCard.vue'
import type { SecurityOps, SecurityPlatform } from '../src/components/securityPlatform'

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
})
