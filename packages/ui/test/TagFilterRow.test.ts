import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TagFilterRow from '../src/components/TagFilterRow.vue'

const tags = [
  { id: 't2', name: '个人' },
  { id: 't1', name: '工作' },
]

describe('TagFilterRow', () => {
  it('tag 按名称字母序渲染；「全部」chip 清空选择', async () => {
    const w = mount(TagFilterRow, { props: { tags, selectedIds: ['t1'], mode: 'any' } })
    const labels = w.findAll('button.md-chip').map((b) => b.text())
    expect(labels).toEqual(['全部', '个人', '工作'])
    await w.findAll('button.md-chip')[0]!.trigger('click')
    expect(w.emitted('update:selectedIds')![0]).toEqual([[]])
  })
  it('chip 点选切换选中集合（emit 全量数组）', async () => {
    const w = mount(TagFilterRow, { props: { tags, selectedIds: [], mode: 'any' } })
    await w.findAll('button.md-chip')[1]!.trigger('click')
    expect(w.emitted('update:selectedIds')![0]).toEqual([['t2']])
  })
  it('mode 切换按钮：选中 <2 禁用，≥2 可点并翻转模式', async () => {
    const w = mount(TagFilterRow, { props: { tags, selectedIds: ['t1'], mode: 'any' } })
    const btn = w.find('button.mode-toggle')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    await w.setProps({ selectedIds: ['t1', 't2'] })
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)
    await btn.trigger('click')
    expect(w.emitted('update:mode')![0]).toEqual(['all'])
  })
})
