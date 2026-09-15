import { describe, expect, it, vi } from 'vitest'
import { toRaw } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import SettingsPage from '../src/pages/SettingsPage.vue'
import NavigationShell from '../src/pages/NavigationShell.vue'
import { themeRoutes } from '../src/pages/routes'

// 占位页不消费 props:stub 只需满足「页面组件不崩」的最小对象,不必满足完整
// VueStore/平台签名(Task 9-12 替换真实现时按完整签名接线;NavigationShell
// 自身 props 的 TS 类型已是完整签名)。CodesPage 真实现(Task 9)消费
// vault.entries 与 vault.groups,stub 需补 groups。
const stubStore = { vault: { entries: [], groups: [] } } as never

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
    // 占位页未声明 props,传入的 props 落入实例 $attrs,以此验证分发;
    // 对象 prop 在挂载链路上会被包成 reactive 代理,用 toRaw 还原后比对引用
    const attrs = w.findComponent(SettingsPage).vm.$attrs as Record<string, unknown>
    expect(toRaw(attrs.store as object)).toBe(stubStore)
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
