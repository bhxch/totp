import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MdButton from '../../src/components/md/MdButton.vue'
import MdChip from '../../src/components/md/MdChip.vue'
import MdFab from '../../src/components/md/MdFab.vue'
import MdIconButton from '../../src/components/md/MdIconButton.vue'
import MdCard from '../../src/components/md/MdCard.vue'

describe('MdButton', () => {
  it('默认 filled,variant 类名生效,click 透传', async () => {
    const w = mount(MdButton, { slots: { default: '保存' } })
    expect(w.classes()).toContain('md-btn--filled')
    await w.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })
  it('tonal/outlined/text/elevated 类名', () => {
    const variants = ['tonal', 'outlined', 'text', 'elevated'] as const
    for (const v of variants) {
      expect(mount(MdButton, { props: { variant: v } }).classes()).toContain(`md-btn--${v}`)
    }
  })
  it('disabled 与 type 属性', () => {
    const w = mount(MdButton, { props: { disabled: true, type: 'submit' }, slots: { default: '删除' } })
    expect(w.attributes('disabled')).toBeDefined()
    expect(w.attributes('type')).toBe('submit')
  })
  it('danger 形态:danger 类优先于 variant(text 形+error 色),未传时不加', () => {
    const w = mount(MdButton, { props: { variant: 'filled', danger: true }, slots: { default: '确认删除？' } })
    expect(w.classes()).toContain('md-btn--danger')
    expect(w.classes()).not.toContain('md-btn--filled')
    expect(w.text()).toBe('确认删除？')
    expect(mount(MdButton, { slots: { default: '普通' } }).classes()).not.toContain('md-btn--danger')
  })
})

describe('MdIconButton', () => {
  it('ariaLabel 落到 aria-label,title 同名透传', () => {
    const w = mount(MdIconButton, { props: { ariaLabel: '复制验证码', title: '复制' } })
    expect(w.attributes('aria-label')).toBe('复制验证码')
    expect(w.attributes('title')).toBe('复制')
  })
  it('variant 类名与 disabled', () => {
    const w = mount(MdIconButton, { props: { variant: 'filled', disabled: true } })
    expect(w.classes()).toContain('md-icon-btn--filled')
    expect(w.attributes('disabled')).toBeDefined()
  })
  it('standard 默认类名', () => {
    expect(mount(MdIconButton).classes()).toContain('md-icon-btn--standard')
  })
})

describe('MdFab', () => {
  it('扩展形渲染 label', () => {
    expect(mount(MdFab, { props: { label: '添加' } }).text()).toContain('添加')
  })
  it('默认形渲染 slot 图标,无 label 不加扩展类', () => {
    const w = mount(MdFab, { slots: { default: '+' } })
    expect(w.text()).toContain('+')
    expect(w.classes()).not.toContain('md-fab--extended')
  })
  it('有 label 时加扩展类', () => {
    expect(mount(MdFab, { props: { label: '添加' } }).classes()).toContain('md-fab--extended')
  })
})

describe('MdChip', () => {
  it('selected 态与 click 事件', async () => {
    const w = mount(MdChip, { props: { label: '工作', selected: true } })
    expect(w.classes()).toContain('md-chip--selected')
    expect(w.text()).toContain('工作')
    await w.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })
  it('未选中无 selected 类', () => {
    expect(mount(MdChip, { props: { label: '全部' } }).classes()).not.toContain('md-chip--selected')
  })
})

describe('MdCard', () => {
  it('默认 outlined,具名 header slot 渲染标题行', () => {
    const w = mount(MdCard, { slots: { header: '标题', default: '<p>正文</p>' } })
    expect(w.classes()).toContain('md-card--outlined')
    expect(w.find('.md-card__header').text()).toBe('标题')
    expect(w.text()).toContain('正文')
  })
  it('header slot 缺省时不渲染 header 行', () => {
    const w = mount(MdCard, { slots: { default: '内容' } })
    expect(w.find('.md-card__header').exists()).toBe(false)
  })
  it('elevated 变体与 compact padding 类', () => {
    const w = mount(MdCard, { props: { variant: 'elevated', padding: 'compact' } })
    expect(w.classes()).toContain('md-card--elevated')
    expect(w.classes()).toContain('md-card--compact')
  })
})
