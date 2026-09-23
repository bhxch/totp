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
