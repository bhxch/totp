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

  it('manageable prop：默认 true 显示管理钮并 emit open-manage；false 隐藏', async () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: [], mode: 'any' } })
    const btn = w.find('button.manage-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBeTruthy() // 悬浮提示
    await btn.trigger('click')
    expect(w.emitted('open-manage')).toHaveLength(1)
    const w2 = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: [], mode: 'any', manageable: false } })
    expect(w2.find('button.manage-btn').exists()).toBe(false)
  })
})
