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
  it('any/all 分段按钮：选中 <2 禁用（aria-disabled + 守卫不外抛），≥2 可直接点选目标模式', async () => {
    const w = mount(TagFilterRow, { global: { plugins: [createTestI18n()] }, props: { tags, selectedIds: ['t1'], mode: 'any' } })
    const seg = w.find('.md-seg')
    expect(seg.exists()).toBe(true)
    // 禁用态：mode-seg--disabled 视觉降级 + aria-disabled 标注；点击不外抛（守卫）
    expect(seg.classes()).toContain('mode-seg--disabled')
    expect(seg.attributes('aria-disabled')).toBe('true')
    const items = w.findAll('button.md-seg__item')
    expect(items.map((b) => b.text())).toEqual(['任一', '全部'])
    await items[1]!.trigger('click')
    expect(w.emitted('update:mode')).toBeUndefined()
    // 选中 ≥2 解禁，点「全部」直接切换到 all（替代原翻转钮的一次点击语义）
    await w.setProps({ selectedIds: ['t1', 't2'] })
    expect(seg.classes()).not.toContain('mode-seg--disabled')
    expect(seg.attributes('aria-disabled')).toBeUndefined()
    await items[1]!.trigger('click')
    expect(w.emitted('update:mode')![0]).toEqual(['all'])
    // 已在目标模式时重复点选不外抛
    await w.setProps({ mode: 'all' })
    await items[1]!.trigger('click')
    expect(w.emitted('update:mode')).toHaveLength(1)
  })
})
