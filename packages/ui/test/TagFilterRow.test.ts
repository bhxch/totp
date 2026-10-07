import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TagFilterRow from '../src/components/TagFilterRow.vue'
import { createTestI18n } from './helpers/i18n'

const tags = [
  { id: 't2', name: '个人' },
  { id: 't1', name: '工作' },
]

describe('TagFilterRow', () => {
  it('tag 按名称字母序渲染；「全部」chip 清空选择', async () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: ['t1'], mode: 'any' } })
    const labels = w.findAll('button.md-chip').map((b) => b.text())
    expect(labels).toEqual(['全部', '个人', '工作'])
    await w.findAll('button.md-chip')[0]!.trigger('click')
    expect(w.emitted('update:selectedIds')![0]).toEqual([[]])
  })
  it('chip 点选切换选中集合（emit 全量数组）', async () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: [], mode: 'any' } })
    await w.findAll('button.md-chip')[1]!.trigger('click')
    expect(w.emitted('update:selectedIds')![0]).toEqual([['t2']])
  })
  it('模式切换：∧/∨ 单钮，单击翻转模式；<2 禁用不外抛', async () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: ['t1'], mode: 'any' } })
    const btn = w.find('button.mode-toggle')
    expect(btn.exists()).toBe(true)
    expect(w.find('.md-seg').exists()).toBe(false)
    expect(btn.text()).toBe('∨') // any → 逻辑或
    expect(btn.classes()).toContain('mode-toggle--disabled')
    expect(btn.attributes('aria-disabled')).toBe('true')
    await btn.trigger('click')
    expect(w.emitted('update:mode')).toBeUndefined()
    // ≥2 解禁：单击 any → all；再单击 all → any
    await w.setProps({ selectedIds: ['t1', 't2'] })
    await btn.trigger('click')
    expect(w.emitted('update:mode')![0]).toEqual(['all'])
    await w.setProps({ mode: 'all' })
    expect(btn.text()).toBe('∧') // all → 逻辑与
    await btn.trigger('click')
    expect(w.emitted('update:mode')![1]).toEqual(['any'])
  })

  it('说明气泡：点击切换钮弹出当前模式说明；组件外 pointerdown 折叠', async () => {
    const w = mount(TagFilterRow, {
      global: { plugins: [createTestI18n()] },
      props: { tags, selectedIds: ['t1', 't2'], mode: 'any' },
      attachTo: document.body,
    })
    expect(w.find('.mode-pop').exists()).toBe(false)
    await w.find('button.mode-toggle').trigger('click')
    expect(w.find('.mode-pop').exists()).toBe(true)
    expect(w.find('.mode-pop').text()).toContain('任一匹配')
    // 组件外任意 pointerdown（capture 监听）→ 气泡折叠
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(w.find('.mode-pop').exists()).toBe(false)
    // 再点按钮重新弹出；组件卸载不残留监听（不抛错即通过）
    await w.find('button.mode-toggle').trigger('click')
    expect(w.find('.mode-pop').exists()).toBe(true)
    w.unmount()
  })

  it('R3-M6：气泡开启时按钮 aria-describedby 关联气泡 id（关闭时不声明）', async () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: ['t1', 't2'], mode: 'any' } })
    const btn = w.find('button.mode-toggle')
    expect(btn.attributes('aria-describedby')).toBeUndefined()
    await btn.trigger('click')
    const pop = w.find('.mode-pop')
    expect(pop.exists()).toBe(true)
    expect(btn.attributes('aria-describedby')).toBe(pop.attributes('id'))
  })

  it('R3-I2：切换标签选择致选中 <2（按钮转 disabled）→ 说明气泡收起，禁用态不挂泡', async () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: ['t1', 't2'], mode: 'any' } })
    await w.find('button.mode-toggle').trigger('click')
    expect(w.find('.mode-pop').exists()).toBe(true)
    // 点掉一个标签（宿主回写 selectedIds）：modeDisabled 成立的同时气泡必须收起
    await w.setProps({ selectedIds: ['t1'] })
    expect(w.find('button.mode-toggle').classes()).toContain('mode-toggle--disabled')
    expect(w.find('.mode-pop').exists()).toBe(false)
  })

  it('manageable prop：默认 true 显示管理钮并 emit open-manage；false 隐藏', async () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: [], mode: 'any' } })
    const btn = w.find('button.manage-btn')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(w.emitted('open-manage')).toHaveLength(1)
    const w2 = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: [], mode: 'any', manageable: false } })
    expect(w2.find('button.manage-btn').exists()).toBe(false)
    expect(w2.find('button.mode-toggle').exists()).toBe(true)
  })

  it('R3-M5：管理标签钮提示为自绘 tooltip 气泡（pointerenter/focus 显示、leave/blur/点击收起），不再用原生 :title', async () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: [], mode: 'any' } })
    const btn = w.find('button.manage-btn')
    expect(btn.attributes('title')).toBeUndefined() // 原生 :title 已移除（触屏不可用）
    expect(w.find('.manage-pop').exists()).toBe(false)
    // hover 显示 + aria-describedby 关联
    await btn.trigger('pointerenter')
    const pop = w.find('.manage-pop')
    expect(pop.exists()).toBe(true)
    expect(pop.attributes('role')).toBe('tooltip')
    expect(btn.attributes('aria-describedby')).toBe(pop.attributes('id'))
    // 移开收起；聚焦同样显示（键盘可达）
    await btn.trigger('pointerleave')
    expect(w.find('.manage-pop').exists()).toBe(false)
    await btn.trigger('focus')
    expect(w.find('.manage-pop').exists()).toBe(true)
    await btn.trigger('blur')
    expect(w.find('.manage-pop').exists()).toBe(false)
    // 点击（open-manage）：打开管理弹层的同时收起 tooltip，注意力移交对话框
    await btn.trigger('pointerenter')
    expect(w.find('.manage-pop').exists()).toBe(true)
    await btn.trigger('click')
    expect(w.find('.manage-pop').exists()).toBe(false)
    expect(w.emitted('open-manage')).toHaveLength(1)
  })

  it('空 tags：chips 段（「全部」+ tag chips）不渲染；mode 钮（<2 天然禁用）与管理钮仍渲染（管理入口是创建首个标签的途径）', () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags: [], selectedIds: [], mode: 'any' } })
    expect(w.findAll('button.md-chip')).toHaveLength(0)
    const mode = w.find('button.mode-toggle')
    expect(mode.exists()).toBe(true)
    expect(mode.classes()).toContain('mode-toggle--disabled')
    expect(mode.attributes('aria-disabled')).toBe('true')
    expect(w.find('button.manage-btn').exists()).toBe(true)
  })

  it('compact 档：行紧凑类渲染，chips 经 MdChip compact prop 全量透传', () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: [], mode: 'any', compact: true } })
    expect(w.find('.tag-filter-row').classes()).toContain('tag-filter-row--compact')
    const chips = w.findAll('button.md-chip')
    expect(chips.length).toBe(3) // 「全部」+ 2 tags
    expect(chips.every((c) => c.classes().includes('md-chip--compact'))).toBe(true)
    // 非 compact 对照：chip 不带紧凑类
    const w2 = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: [], mode: 'any' } })
    expect(w2.find('.tag-filter-row').classes()).not.toContain('tag-filter-row--compact')
    expect(w2.findAll('button.md-chip').every((c) => !c.classes().includes('md-chip--compact'))).toBe(true)
  })
})
