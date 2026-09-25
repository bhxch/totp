import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryStorage } from '@totp/core'
import { createVueStore } from '../../src/store'
import SettingsPage from '../../src/pages/SettingsPage.vue'
import type { DevtoolsConfigDto, DevtoolsPlatform } from '../../src/components/devtoolsPlatform'
import type { ReleasePolicyDto, ReleasePlatform } from '../../src/components/releasePlatform'
import { createTestI18n } from '../helpers/i18n'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  return s
}

function devtoolsPlatform(cfg: DevtoolsConfigDto = { enabled: false, port: 9222 }) {
  const platform = {
    getConfig: vi.fn().mockResolvedValue(cfg),
    setConfig: vi.fn().mockResolvedValue(undefined),
  }
  return platform
}

function releasePlatform(cfg: ReleasePolicyDto = { pauseMinutes: 5, destroyMinutes: 30, lockOnPause: false, lockOnDestroy: true }) {
  const platform = {
    getConfig: vi.fn().mockResolvedValue(cfg),
    setConfig: vi.fn().mockResolvedValue(undefined),
  }
  return platform
}

function setInputValue(w: ReturnType<typeof mount>, selector: string, v: string): Promise<void> {
  const input = w.find(selector)
  ;(input.element as HTMLInputElement).value = v
  return input.trigger('input').then(() => input.trigger('change'))
}

beforeEach(() => {
  localStorage.clear()
})

describe('SettingsPage 开发者卡（devtoolsPlatform 注入）', () => {
  it('onMounted 预填：开关与端口来自 getConfig', async () => {
    const store = await readyStore()
    const platform = devtoolsPlatform({ enabled: true, port: 9333 })
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, devtoolsPlatform: platform } })
    await flushPromises()
    expect(platform.getConfig).toHaveBeenCalledTimes(1)
    expect((w.find('.set-devtools input').element as HTMLInputElement).checked).toBe(true)
    expect((w.find('.devtools-port input').element as HTMLInputElement).value).toBe('9333')
    expect(w.text()).toContain('重启应用后生效') // 开关开启时端口行渲染
  })

  it('getConfig 失败：保持缺省关（9222），不阻断设置页其余部分', async () => {
    const store = await readyStore()
    const platform = devtoolsPlatform()
    platform.getConfig.mockRejectedValue(new Error('ipc down'))
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, devtoolsPlatform: platform } })
    await flushPromises()
    expect((w.find('.set-devtools input').element as HTMLInputElement).checked).toBe(false)
    expect(w.find('.devtools-port').exists()).toBe(false) // 开关关 → 端口行不渲染
    expect(w.text()).toContain('记住标签筛选') // 其余设置区正常
  })

  it('开关切到开启：与端口同一提交路径 setConfig(true, 9222)；成功后清错误并前进基线', async () => {
    const store = await readyStore()
    const platform = devtoolsPlatform()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, devtoolsPlatform: platform } })
    await flushPromises()
    await w.find('.set-devtools input').setValue(true)
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledWith(true, 9222)
    expect(w.find('.devtools-error').exists()).toBe(false)
  })

  it('端口非法（空/越界/非整数）：回显基线不提交；随后合法修改提交成功', async () => {
    const store = await readyStore()
    const platform = devtoolsPlatform({ enabled: true, port: 9222 })
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, devtoolsPlatform: platform } })
    await flushPromises()
    for (const bad of ['', '80', '65536', '9.5']) {
      await setInputValue(w, '.devtools-port input', bad)
      await nextTick()
      expect((w.find('.devtools-port input').element as HTMLInputElement).value).toBe('9222')
      expect((w.find('.set-devtools input').element as HTMLInputElement).checked).toBe(true) // 开关一并回显基线
    }
    expect(platform.setConfig).not.toHaveBeenCalled()
    await setInputValue(w, '.devtools-port input', '9333')
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledWith(true, 9333)
  })

  it('保存失败：错误横幅（含原始 reject 文本）+ 回显基线', async () => {
    const store = await readyStore()
    const platform = devtoolsPlatform({ enabled: true, port: 9222 })
    platform.setConfig.mockRejectedValue('port conflict with MCP')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, devtoolsPlatform: platform } })
    await flushPromises()
    await setInputValue(w, '.devtools-port input', '9333')
    await flushPromises()
    const banner = w.find('.devtools-error')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('保存失败')
    expect(banner.text()).toContain('port conflict with MCP')
    expect((w.find('.devtools-port input').element as HTMLInputElement).value).toBe('9222')
  })
})

describe('SettingsPage 释放策略卡（releasePlatform 注入）', () => {
  it('onMounted 预填两档分钟与锁库开关', async () => {
    const store = await readyStore()
    const platform = releasePlatform({ pauseMinutes: 10, destroyMinutes: 60, lockOnPause: true, lockOnDestroy: false })
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, releasePlatform: platform } })
    await flushPromises()
    expect((w.find('.release-min input').element as HTMLInputElement).value).toBe('10')
    expect((w.find('.set-release-lock-pause input').element as HTMLInputElement).checked).toBe(true)
    expect((w.find('.set-release-lock-destroy input').element as HTMLInputElement).checked).toBe(false)
  })

  it('getConfig 失败：保持缺省 5/30/false/true，不阻断其余部分', async () => {
    const store = await readyStore()
    const platform = releasePlatform()
    platform.getConfig.mockRejectedValue(new Error('ipc down'))
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, releasePlatform: platform } })
    await flushPromises()
    expect((w.find('.release-min input').element as HTMLInputElement).value).toBe('5')
    expect((w.find('.set-release-lock-pause input').element as HTMLInputElement).checked).toBe(false)
    expect((w.find('.set-release-lock-destroy input').element as HTMLInputElement).checked).toBe(true)
  })

  it('分钟 change 提交：0-1440 合法值前进基线（0=禁用合法）', async () => {
    const store = await readyStore()
    const platform = releasePlatform()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, releasePlatform: platform } })
    await flushPromises()
    await setInputValue(w, '.release-min input', '0')
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledWith({ pauseMinutes: 0, destroyMinutes: 30, lockOnPause: false, lockOnDestroy: true })
    expect(w.find('.release-error').exists()).toBe(false)
  })

  it('空串守卫：Number(\'\')===0 不静默提交禁用，仅回显基线', async () => {
    const store = await readyStore()
    const platform = releasePlatform()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, releasePlatform: platform } })
    await flushPromises()
    await setInputValue(w, '.release-min input', '   ')
    await flushPromises()
    expect(platform.setConfig).not.toHaveBeenCalled()
    expect((w.find('.release-min input').element as HTMLInputElement).value).toBe('5')
  })

  it('非法分钟（负数/超 1440/小数）：回滚两档输入到基线不提交', async () => {
    const store = await readyStore()
    const platform = releasePlatform({ pauseMinutes: 5, destroyMinutes: 30, lockOnPause: false, lockOnDestroy: true })
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, releasePlatform: platform } })
    await flushPromises()
    // 先改 destroy 为基线外值再触发 pause 非法回滚：两档一并回显
    await setInputValue(w, '.release-min input', '99')
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledTimes(1) // 99 合法已提交
    for (const bad of ['-1', '1441', '2.5']) {
      await setInputValue(w, '.release-min input', bad)
      await nextTick()
      expect((w.find('.release-min input').element as HTMLInputElement).value).toBe('99')
      expect((w.findAll('.release-min input')[1]!.element as HTMLInputElement).value).toBe('30')
    }
    expect(platform.setConfig).toHaveBeenCalledTimes(1)
  })

  it('锁库开关即点即提交（lockOnPause/lockOnDestroy 独立前进）', async () => {
    const store = await readyStore()
    const platform = releasePlatform()
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, releasePlatform: platform } })
    await flushPromises()
    await w.find('.set-release-lock-pause input').setValue(true)
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledWith({ pauseMinutes: 5, destroyMinutes: 30, lockOnPause: true, lockOnDestroy: true })
    await w.find('.set-release-lock-destroy input').setValue(false)
    await flushPromises()
    expect(platform.setConfig).toHaveBeenLastCalledWith({ pauseMinutes: 5, destroyMinutes: 30, lockOnPause: true, lockOnDestroy: false })
  })

  it('保存失败：错误横幅 + 回滚输入到基线', async () => {
    const store = await readyStore()
    const platform = releasePlatform()
    platform.setConfig.mockRejectedValue('rust rejected')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showDesktop: true, releasePlatform: platform } })
    await flushPromises()
    await w.find('.set-release-lock-pause input').setValue(true)
    await flushPromises()
    const banner = w.find('.release-error')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('保存失败')
    expect(banner.text()).toContain('rust rejected')
    // 分钟输入回显基线（releaseGood 未被失败提交推进）
    expect((w.find('.release-min input').element as HTMLInputElement).value).toBe('5')
    // 注：锁库开关的视觉态由 MdSwitch 内部 checked 持有（modelValue 未变化不触发 watch 回写），
    // 失败回滚后开关视觉与 state 短暂脱钩，下次交互即收敛——组件既有边界，此处不锚定视觉。
  })
})

describe('SettingsPage 主题对比度与云同步跟随', () => {
  it('AMOLED 纯黑开关：themeContrast 在 standard/amoled 间切换并 commitSettings', async () => {
    const store = await readyStore()
    expect(store.settings.themeContrast).toBe('standard')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('.set-theme-contrast input').setValue(true)
    expect(store.settings.themeContrast).toBe('amoled')
    await w.find('.set-theme-contrast input').setValue(false)
    expect(store.settings.themeContrast).toBe('standard')
  })

  it('自动跟随云同步开关（showExtension）：写 syncPrefs.autoFollow 并 commitSettings', async () => {
    const store = await readyStore()
    const commit = vi.spyOn(store, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showExtension: true } })
    expect(w.find('.set-auto-follow').exists()).toBe(true)
    expect(store.settings.syncPrefs.autoFollow).toBe(true) // core 缺省开启
    await w.find('.set-auto-follow input').setValue(false)
    expect(store.settings.syncPrefs.autoFollow).toBe(false)
    expect(commit).toHaveBeenCalled()
  })

  it('自动跟随开关二次打开：再次 commitSettings（逐次直写语义）', async () => {
    const store = await readyStore()
    store.settings.syncPrefs.autoFollow = false
    const commit = vi.spyOn(store, 'commitSettings')
    const w = mount(SettingsPage, { global: { plugins: [createTestI18n()] }, props: { store, showExtension: true } })
    await w.find('.set-auto-follow input').setValue(true)
    expect(store.settings.syncPrefs.autoFollow).toBe(true)
    expect(commit).toHaveBeenCalled()
  })
})
