import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed } from 'vue'
import { createMemoryStorage } from '@totp/core'
import { createVueStore } from '../../src/store'
import SettingsPage from '../../src/pages/SettingsPage.vue'
import { createTestI18n } from '../helpers/i18n'
import type { SecurityPlatform } from '../../src/components/securityPlatform'

async function readyStore(themeMode: 'auto' | 'light' | 'dark' = 'auto') {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  s.settings.themeMode = themeMode
  return s
}

function secPlatform(): SecurityPlatform {
  return {
    security: null,
    clipboardClearEnabled: computed(() => true),
    setClipboardClear: vi.fn(async () => {}),
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('SettingsPage 外观区', () => {
  it('色板渲染 10 个圆点（title=色名，默认 blue 选中）', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    const dots = w.findAll('button.theme-dot')
    expect(dots).toHaveLength(10)
    expect(w.find('button.theme-dot[data-color-id="blue"].theme-dot--selected').exists()).toBe(true)
    expect(w.find('button.theme-dot[data-color-id="teal"]').attributes('style')).toContain('rgb(0, 121, 107)') // teal #00796B
  })

  it('点 teal 圆点 → settings.themeColor=teal + commitSettings 调用 + localStorage 镜像写入', async () => {
    const s = await readyStore()
    const commit = vi.spyOn(s, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('button.theme-dot[data-color-id="teal"]').trigger('click')
    expect(s.settings.themeColor).toBe('teal')
    expect(commit).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('themePref')!)).toMatchObject({ mode: 'auto', color: 'teal' })
    expect(w.find('button.theme-dot--selected[data-color-id="teal"]').exists()).toBe(true)
  })

  it('模式分段点「深色」→ settings.themeMode=dark + 镜像写入', async () => {
    const s = await readyStore()
    const commit = vi.spyOn(s, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.findAll('.md-seg__item').find((b) => b.text() === '深色')!.trigger('click')
    expect(s.settings.themeMode).toBe('dark')
    expect(commit).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('themePref')!)).toMatchObject({ mode: 'dark' })
    expect(w.find('.md-seg__item--selected').text()).toContain('深色')
  })

  it('resolvedMode 展示当前生效模式（themeMode=dark → 深色）', async () => {
    const s = await readyStore('dark')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    expect(w.find('.theme-resolved').text()).toContain('深色')
  })

  it('语言选择：点选 English → settings.locale=en + commitSettings 调用（D1）', async () => {
    const s = await readyStore()
    const commit = vi.spyOn(s, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    // 默认 auto：「跟随浏览器」为当前选中项
    expect(w.find('.set-locale .md-select__value').text()).toBe('跟随浏览器')
    await w.find('.set-locale .md-select__trigger').trigger('click')
    await w.findAll('.set-locale .md-select__option').find((o) => o.text() === 'English')!.trigger('click')
    expect(s.settings.locale).toBe('en')
    expect(commit).toHaveBeenCalled()
    expect(w.find('.set-locale .md-select__value').text()).toBe('English')
  })
})

describe('SettingsPage 通用区', () => {
  it('showDesktop=false 不渲染失焦自动隐藏开关；true 渲染且切换写 settings + commitSettings', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: false } })
    expect(w.find('.set-blur-hide').exists()).toBe(false)
    const w2 = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: true } })
    const commit = vi.spyOn(s, 'commitSettings')
    expect(s.settings.blurHideEnabled).toBe(false)
    await w2.find('.set-blur-hide input').setValue(true)
    expect(s.settings.blurHideEnabled).toBe(true)
    expect(commit).toHaveBeenCalled()
  })

  it('showExtension=false 不渲染 URL 过滤与弹窗延迟；true 渲染且写入生效', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: true, showExtension: false } })
    expect(w.find('.set-url-filter').exists()).toBe(false)
    expect(w.find('.set-popup-delay').exists()).toBe(false)
    const w2 = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: true, showExtension: true } })
    // 默认 urlFilterEnabled=true、popupCloseDelayMs=2000（DEFAULT_SETTINGS）
    expect((w2.find('.set-url-filter input').element as HTMLInputElement).checked).toBe(true)
    await w2.find('.set-url-filter input').setValue(false)
    expect(s.settings.urlFilterEnabled).toBe(false)
    await w2.find('.set-popup-delay input').setValue('3000')
    expect(s.settings.popupCloseDelayMs).toBe(3000)
  })

  it('弹窗延迟：空串/负值忽略不落盘不调 commitSettings；小数四舍五入取整', async () => {
    const s = await readyStore()
    const commit = vi.spyOn(s, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, showDesktop: true, showExtension: true } })
    await w.find('.set-popup-delay input').setValue('   ')
    expect(s.settings.popupCloseDelayMs).toBe(2000) // 默认值未被空串清成 0
    expect(commit).not.toHaveBeenCalled()
    await w.find('.set-popup-delay input').setValue('12.7')
    expect(s.settings.popupCloseDelayMs).toBe(13)
    await w.find('.set-popup-delay input').setValue('-5')
    expect(s.settings.popupCloseDelayMs).toBe(13)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('记住标签筛选开关写入 settings', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('input.set-remember-tag-filter, .set-remember-tag-filter input').setValue(true)
    await vi.waitFor(() => expect(s.settings.rememberTagFilter).toBe(true))
  })

  it('剪贴板开关：securityPlatform.setClipboardClear 缺失不渲染；存在则渲染且切换写 settings', async () => {
    const s = await readyStore()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    expect(w.find('.set-clipboard-clear').exists()).toBe(false)
    const w2 = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store: s, securityPlatform: secPlatform() } })
    expect(w2.find('.set-clipboard-clear').exists()).toBe(true)
    expect(s.settings.clipboardClearEnabled).toBe(true)
    await w2.find('.set-clipboard-clear input').setValue(false)
    expect(s.settings.clipboardClearEnabled).toBe(false)
  })
})
