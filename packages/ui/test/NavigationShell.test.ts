import { describe, expect, it, vi } from 'vitest'
import { toRaw } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import SettingsPage from '../src/pages/SettingsPage.vue'
import NavigationShell from '../src/pages/NavigationShell.vue'
import { themeRoutes } from '../src/pages/routes'

// SettingsPage 真实现(Task 11)消费 settings/useTheme:stub 补外观区所需
// 最小字段与 commitSettings;CodesPage 真实现(Task 9)消费 vault.entries/groups。
const stubStore = {
  vault: { entries: [], groups: [] },
  settings: {
    themeMode: 'auto', themeColor: 'blue',
    urlFilterEnabled: true, blurHideEnabled: false, clipboardClearEnabled: true,
    popupCloseDelayMs: 2000, syncEnabled: false,
  },
  commitSettings: vi.fn(async () => {}),
} as never

function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes: themeRoutes })
}

describe('NavigationShell', () => {
  it('默认路由重定向 /codes 且渲染 Rail 5 项', async () => {
    const router = makeRouter()
    await router.push('/'); await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router] }, props: { store: stubStore } })
    expect(router.currentRoute.value.path).toBe('/codes')
    expect(w.findAll('.md-rail__item')).toHaveLength(5)
  })

  it('router.push(/settings) 后 settings 页拿到 store(pageProps 分发)', async () => {
    const router = makeRouter()
    await router.push('/settings'); await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router] }, props: { store: stubStore } })
    // SettingsPage 真实现已声明 store prop(pageProps 直传,不再落 $attrs);
    // 对象 prop 经挂载链路会包成 reactive 代理,toRaw 还原后比对引用
    const storeProp = w.findComponent(SettingsPage).props('store') as object
    expect(toRaw(storeProp)).toBe(stubStore)
  })

  it('railActions 透传到 Rail 底部 actions 区', async () => {
    const router = makeRouter()
    await router.push('/'); await router.isReady()
    const onClick = vi.fn()
    const w = mount(NavigationShell, {
      global: { plugins: [router] },
      props: { store: stubStore, railActions: [{ label: '托盘', onClick }] },
    })
    const btn = w.find('.nav-shell__rail-action')
    expect(btn.text()).toBe('托盘')
    await btn.trigger('click')
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('点击 Rail 项路由跳转', async () => {
    const router = makeRouter()
    await router.push('/'); await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router] }, props: { store: stubStore } })
    await w.findAll('.md-rail__item')[4]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/settings')
  })
})
