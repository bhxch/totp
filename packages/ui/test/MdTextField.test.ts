import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MdTextField from '../src/components/md/MdTextField.vue'

describe('MdTextField multiline', () => {
  it('默认渲染 input，multiline 渲染 textarea 且 rows 生效', () => {
    const single = mount(MdTextField, { props: { modelValue: '', label: '备注' } })
    expect(single.find('input').exists()).toBe(true)
    const multi = mount(MdTextField, { props: { modelValue: '', label: '备注', multiline: true, rows: 3 } })
    const ta = multi.find('textarea')
    expect(ta.exists()).toBe(true)
    expect(ta.attributes('rows')).toBe('3')
  })
  it('textarea 双向绑定与输入事件', async () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '备注', multiline: true, 'onUpdate:modelValue': (v: string) => w.setProps({ modelValue: v }) } })
    await w.find('textarea').setValue('第一行\n第二行')
    expect(w.props('modelValue')).toBe('第一行\n第二行')
  })
  it('multiline 时 label 恒浮动（含空值，textarea 的 label 不再占行中）', () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '备注', multiline: true } })
    expect(w.find('.md-text-field__label').classes()).toContain('md-text-field__label--floated')
  })
})

describe('MdTextField dense', () => {
  it('dense 档渲染紧凑类', () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '搜索', dense: true } })
    expect(w.find('.md-text-field__box').classes()).toContain('md-text-field__box--dense')
  })
  it('默认非 dense：不渲染紧凑类', () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '搜索' } })
    expect(w.find('.md-text-field__box').classes()).not.toContain('md-text-field__box--dense')
  })
})

describe('MdTextField 浮动态内容行下移（浮动 label 与 input 行重叠回归修复）', () => {
  it('有值或占位符时 box 挂 --floated（CSS 钩子），空值无占位不挂', () => {
    const valued = mount(MdTextField, { props: { modelValue: 'abc', label: '搜索' } })
    expect(valued.find('.md-text-field__box').classes()).toContain('md-text-field__box--floated')
    const byPlaceholder = mount(MdTextField, { props: { modelValue: '', label: '搜索', placeholder: '输入…' } })
    expect(byPlaceholder.find('.md-text-field__box').classes()).toContain('md-text-field__box--floated')
    const empty = mount(MdTextField, { props: { modelValue: '', label: '搜索' } })
    expect(empty.find('.md-text-field__box').classes()).not.toContain('md-text-field__box--floated')
  })
  it('multiline 挂 --multiline 且不挂 --floated：首行留白由 textarea 自身 pad 承担，box 不双重加顶距', () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '备注', multiline: true } })
    expect(w.find('.md-text-field__box').classes()).toContain('md-text-field__box--multiline')
    expect(w.find('.md-text-field__box').classes()).not.toContain('md-text-field__box--floated')
  })
  it('源码断言：浮动态下移规则存在且排除 dense/multiline（jsdom 无布局，几何只能锁源码）', () => {
    const src = readFileSync(join(__dirname, '../src/components/md/MdTextField.vue'), 'utf8')
    expect(src).toMatch(/\.md-text-field__box--floated:not\(\.md-text-field__box--dense\):not\(\.md-text-field__box--multiline\),\s*\.md-text-field__box:focus-within:not\(\.md-text-field__box--dense\):not\(\.md-text-field__box--multiline\)\s*{[^}]*padding-top:\s*24px/)
    expect(src).toMatch(/\.md-text-field__label--floated,[\s\S]{0,200}?line-height:\s*16px/)
  })
})
