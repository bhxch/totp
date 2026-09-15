import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MdNavigationRail from '../../src/components/md/MdNavigationRail.vue'
import MdTabs from '../../src/components/md/MdTabs.vue'

const items = [
  { name: 'codes', label: '验证码', icon: 'M3 5h18v2H3zM3 11h18v2H3zM3 17h18v2H3z', to: '/codes' },
  { name: 'settings', label: '设置', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8z', to: '/settings' },
]

describe('MdNavigationRail', () => {
  it('渲染 items,active 指示,select 事件,actions slot', async () => {
    const w = mount(MdNavigationRail, { props: { items, active: 'codes' }, slots: { actions: '<button class="x">托盘</button>' } })
    expect(w.findAll('.md-rail__item')).toHaveLength(2)
    expect(w.find('.md-rail__item--active').text()).toContain('验证码')
    await w.findAll('.md-rail__item')[1]!.trigger('click')
    expect(w.emitted('select')![0]).toEqual(['settings'])
    expect(w.find('.x').text()).toBe('托盘')
  })
  it('icon path 透传到 fill=currentColor 的 SVG', () => {
    const w = mount(MdNavigationRail, { props: { items, active: 'codes' } })
    expect(w.find('.md-rail__item path').attributes('d')).toBe(items[0]!.icon)
    expect(w.find('.md-rail__item path').attributes('fill')).toBe('currentColor')
  })
})

describe('MdTabs', () => {
  it('渲染 items,active 指示,select 事件(与 Rail 同构)', async () => {
    const w = mount(MdTabs, { props: { items, active: 'settings' } })
    expect(w.findAll('.md-tabs__item')).toHaveLength(2)
    expect(w.find('.md-tabs__item--active').text()).toContain('设置')
    await w.findAll('.md-tabs__item')[0]!.trigger('click')
    expect(w.emitted('select')![0]).toEqual(['codes'])
  })
})
