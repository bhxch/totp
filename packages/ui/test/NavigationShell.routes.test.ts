import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick, toRaw } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createMemoryStorage } from '@totp/core'
import ImportPage from '../src/pages/ImportPage.vue'
import CodesPage from '../src/pages/CodesPage.vue'
import NavigationShell from '../src/pages/NavigationShell.vue'
import SecurityPage from '../src/pages/SecurityPage.vue'
import SyncPage from '../src/pages/SyncPage.vue'
import SettingsPage from '../src/pages/SettingsPage.vue'
import { themeRoutes } from '../src/pages/routes'
import { createVueStore, type VueStore } from '../src/store'
import { createTestI18n } from './helpers/i18n'

async function makeShellDeps(): Promise<{ router: Router; store: VueStore }> {
  const router = createRouter({ history: createMemoryHistory(), routes: themeRoutes })
  const store = createVueStore(createMemoryStorage())
  await store.initStore()
  return { router, store }
}

/** CloudCard 挂载即读接口做回填/孤儿凭据对账：fake 需齐备成员（否则 unhandled rejection） */
function fullCloudFake(): Record<string, unknown> {
  return {
    loadSources: vi.fn(async () => []),
    saveSources: vi.fn(async () => {}),
    saveCred: vi.fn(async () => {}),
    removeCred: vi.fn(async () => {}),
    creds: {},
    readVaultJson: vi.fn(() => ''),
    persistDownloaded: vi.fn(async () => {}),
    loadSourceState: vi.fn(async () => ({ lastKnownRemoteRev: null, baseSnapshot: null })),
    saveSourceState: vi.fn(async () => {}),
    deviceId: vi.fn(async () => 'dev-test'),
    autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
  }
}

describe('NavigationShell pageProps 精确分发（五路由全走查，真实 store）', () => {
  it.each([
    ['/codes', CodesPage],
    ['/import', ImportPage],
    ['/sync', SyncPage],
    ['/security', SecurityPage],
    ['/settings', SettingsPage],
  ])('路由 %s 渲染对应页面组件（pageProps 计算求值）', async (path, page) => {
    const { router, store } = await makeShellDeps()
    await router.push(path)
    await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] }, props: { store } })
    await flushPromises()
    expect(w.findComponent(page as never).exists()).toBe(true)
    w.unmount()
  })

  it('sync 页分发五项 props（platform/cloudPlatform/syncPlatform/cloudAuthFailed/store）', async () => {
    const { router, store } = await makeShellDeps()
    await router.push('/sync')
    await router.isReady()
    const cloud = fullCloudFake()
    const sync = { syncEnabled: false, setSyncEnabled: vi.fn(), readStatus: vi.fn(async () => null), canSync: true }
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] },
      props: { store, cloudPlatform: cloud as never, syncPlatform: sync as never, cloudAuthFailed: true } })
    await flushPromises()
    const page = w.findComponent(SyncPage)
    expect(toRaw(page.props('cloudPlatform') as object)).toBe(cloud)
    expect(toRaw(page.props('syncPlatform') as object)).toBe(sync)
    expect(page.props('cloudAuthFailed')).toBe(true)
    w.unmount()
  })

  it('settings 页 showDesktop/showExtension 由 railActions/syncPlatform 推导', async () => {
    const { router, store } = await makeShellDeps()
    await router.push('/settings')
    await router.isReady()
    const sync = { syncEnabled: false, setSyncEnabled: vi.fn(), readStatus: vi.fn(async () => null), canSync: true }
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] },
      props: { store, syncPlatform: sync as never, railActions: [{ label: '托盘', onClick: () => {} }] } })
    await flushPromises()
    const page = w.findComponent(SettingsPage)
    expect(page.props('showDesktop')).toBe(true)
    expect(page.props('showExtension')).toBe(true)
    w.unmount()
  })
})

describe('NavigationShell matchMedia 监听清理', () => {
  it('onMqlChange 运行时翻转：宽→窄 Rail 切 Tabs，再翻回 Rail（断点跨过即时响应）', async () => {
    const hooks: { change: ((e: { matches: boolean }) => void) | null } = { change: null }
    const mql = {
      matches: false,
      addEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => { hooks.change = cb },
      removeEventListener: () => { hooks.change = null },
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList)
    const { router, store } = await makeShellDeps()
    await router.push('/')
    await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] }, props: { store } })
    await nextTick()
    expect(w.find('.md-rail').exists()).toBe(true) // 初值宽窗 Rail
    expect(w.find('.md-tabs').exists()).toBe(false)
    hooks.change?.({ matches: true }) // 视口跨入 <600px：Rail→Tabs
    await nextTick()
    expect(w.find('.md-tabs').exists()).toBe(true)
    expect(w.find('.md-rail').exists()).toBe(false)
    hooks.change?.({ matches: false }) // 再跨回宽窗：Tabs→Rail
    await nextTick()
    expect(w.find('.md-rail').exists()).toBe(true)
    expect(w.find('.md-tabs').exists()).toBe(false)
    w.unmount()
    vi.restoreAllMocks()
  })

  it('卸载时移除 mql change 监听（不残留全局回调）', async () => {
    const hooks: { change: ((e: { matches: boolean }) => void) | null } = { change: null }
    const mql = {
      matches: false,
      addEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => { hooks.change = cb },
      removeEventListener: () => { hooks.change = null },
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList)
    const { router, store } = await makeShellDeps()
    await router.push('/')
    await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] }, props: { store } })
    expect(hooks.change).not.toBeNull()
    w.unmount()
    expect(hooks.change).toBeNull() // onBeforeUnmount 移除监听并置空 mql
    await nextTick()
    vi.restoreAllMocks()
  })
})
