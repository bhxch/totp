import { describe, expect, it, vi } from 'vitest'
import { toRaw, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import SettingsPage from '../src/pages/SettingsPage.vue'
import CodesPage from '../src/pages/CodesPage.vue'
import NavigationShell from '../src/pages/NavigationShell.vue'
import { themeRoutes } from '../src/pages/routes'
import { createTestI18n } from './helpers/i18n'

// SettingsPage 真实现(Task 11)消费 settings/useTheme:stub 补外观区所需
// 最小字段与 commitSettings;CodesPage 真实现消费 vault.entries/tags 与标签筛选三设置。
const stubStore = {
  vault: { entries: [], tags: [] },
  settings: {
    themeMode: 'auto', themeColor: 'blue',
    urlFilterEnabled: true, blurHideEnabled: false, clipboardClearEnabled: true,
    popupCloseDelayMs: 2000, syncEnabled: false, locale: 'auto',
    tagFilterMode: 'any', rememberTagFilter: false, lastTagFilterIds: [],
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
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] }, props: { store: stubStore } })
    expect(router.currentRoute.value.path).toBe('/codes')
    expect(w.findAll('.md-rail__item')).toHaveLength(5)
  })

  it('未匹配路径（catch-all）重定向 /codes（错误 hash 深链兜底）', async () => {
    const router = makeRouter()
    await router.push('/setings'); await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] }, props: { store: stubStore } })
    expect(router.currentRoute.value.path).toBe('/codes')
    expect(w.findAll('.md-rail__item')).toHaveLength(5)
    w.unmount()
  })

  it('router.push(/settings) 后 settings 页拿到 store(pageProps 分发)', async () => {
    const router = makeRouter()
    await router.push('/settings'); await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] }, props: { store: stubStore } })
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
      global: { plugins: [router, createTestI18n()] },
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
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] }, props: { store: stubStore } })
    await w.findAll('.md-rail__item')[4]!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/settings')
  })

  it('CodesPage copy 事件上抛为 Shell copy（宿主剪贴板链路）', async () => {
    const router = makeRouter()
    await router.push('/codes'); await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] }, props: { store: stubStore } })
    w.findComponent(CodesPage).vm.$emit('copy', '123456')
    await flushPromises()
    expect(w.emitted('copy')).toEqual([['123456']])
  })

  it('isNarrow setup 同步测量：matchMedia 命中时首帧即 Tabs 不闪变 Rail（审查 Minor）', async () => {
    // 回调经对象属性持有：裸 let 变量会被 TS 控制流收窄为 never（嵌套函数内赋值不放宽），调用处 TS2349
    const hooks: { change: ((e: { matches: boolean }) => void) | null } = { change: null }
    const mql = {
      matches: true,
      addEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => { hooks.change = cb },
      removeEventListener: () => { hooks.change = null },
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as unknown as MediaQueryList)
    const router = makeRouter()
    await router.push('/'); await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router, createTestI18n()] }, props: { store: stubStore } })
    // setup 初值同步生效：窄窗首帧直接渲染 Tabs（不先 Rail 再闪变）
    expect(w.find('.md-rail').exists()).toBe(false)
    expect(w.find('.md-tabs').exists()).toBe(true)
    // 断点变化监听仍在：matches 变 false 回宽窗 Rail
    hooks.change?.({ matches: false })
    await nextTick()
    expect(w.find('.md-rail').exists()).toBe(true)
    expect(w.find('.md-tabs').exists()).toBe(false)
    w.unmount()
    vi.restoreAllMocks()
  })
})
