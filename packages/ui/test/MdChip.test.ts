import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { close } from '../src/components/iconPaths'
import MdChip from '../src/components/md/MdChip.vue'

// removable close 的命中区是 scoped CSS 几何（jsdom 无布局不可实测），按 tokens.test.ts 先例读源码断言
const chipSfc = readFileSync(join(__dirname, '../src/components/md/MdChip.vue'), 'utf8')

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
  it('aria-pressed 随 selected 落 true/false（读屏可辨选中态）', () => {
    expect(mount(MdChip, { props: { label: '工作', selected: true } }).attributes('aria-pressed')).toBe('true')
    expect(mount(MdChip, { props: { label: '全部' } }).attributes('aria-pressed')).toBe('false')
  })
  it('compact 档渲染紧凑类', () => {
    const w = mount(MdChip, { props: { label: 'tag', compact: true } })
    expect(w.classes()).toContain('md-chip--compact')
    expect(mount(MdChip, { props: { label: 'tag' } }).classes()).not.toContain('md-chip--compact')
  })
  it('非 removable 根保持 button（消费方 button.md-chip 选择器契约不变）', () => {
    expect(mount(MdChip, { props: { label: 'x' } }).element.tagName).toBe('BUTTON')
  })
  it('removable：根为非交互 span 胶囊，主/删两兄弟 button，无嵌套 button', async () => {
    const w = mount(MdChip, { props: { label: 'My Pack', removable: true, removeLabel: '删除' } })
    expect(w.element.tagName).toBe('SPAN') // 根改非交互容器：消除 button 嵌 button（HTML 内容模型）
    expect(w.classes()).toContain('md-chip--removable')
    expect(w.element.querySelector('button button')).toBeNull() // 嵌套交互禁断言
    const main = w.find('.md-chip__main')
    expect(main.element.tagName).toBe('BUTTON') // 主区承接原根 click/aria
    expect(main.text()).toBe('My Pack')
    expect(main.attributes('aria-pressed')).toBe('false')
    const closeBtn = w.find('.md-chip__remove')
    expect(closeBtn.element.tagName).toBe('BUTTON') // 真 button 天然可聚焦，无 tabindex 补丁
    expect(closeBtn.attributes('aria-label')).toBe('删除')
    expect(closeBtn.find('path').attributes('d')).toBe(close.d) // 图标走 iconPaths 注册表
    await main.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
    await closeBtn.trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
    expect(w.emitted('click')).toHaveLength(1) // 兄弟结构：close 点击不触发主区 click
  })
  it('removable selected：aria-pressed 落主区（读屏可辨选中态）', () => {
    const main = mount(MdChip, { props: { label: 'x', removable: true, selected: true } }).find('.md-chip__main')
    expect(main.attributes('aria-pressed')).toBe('true')
  })
  it('removable disabled：主/删两钮齐禁', () => {
    const w = mount(MdChip, { props: { label: 'x', removable: true, disabled: true } })
    expect((w.find('.md-chip__main').element as HTMLButtonElement).disabled).toBe(true)
    expect((w.find('.md-chip__remove').element as HTMLButtonElement).disabled).toBe(true)
  })
  it('非 removable 不渲染 close', () => {
    expect(mount(MdChip, { props: { label: '全部' } }).find('.md-chip__remove').exists()).toBe(false)
  })
  it('compact/removable 叠加：close 命中 ≥44（28px 视觉 + ::after inset -8px；标准档 24px + -8px = 40 同步覆盖 Phase 1 ≥40）', () => {
    const w = mount(MdChip, { props: { label: 'x', compact: true, removable: true } })
    expect(w.classes()).toContain('md-chip--compact')
    expect(w.find('.md-chip__remove').exists()).toBe(true)
    expect(chipSfc).toMatch(/\.md-chip__remove::after\s*\{[^}]*inset:\s*-8px/)
    expect(chipSfc).toMatch(/\.md-chip--compact \.md-chip__remove\s*\{[^}]*28px/)
  })
  it('disabled 透传（busy 等宿主禁用态）', () => {
    expect(mount(MdChip, { props: { label: 'x', disabled: true } }).attributes('disabled')).toBeDefined()
    expect(mount(MdChip, { props: { label: 'x' } }).attributes('disabled')).toBeUndefined()
  })
})
