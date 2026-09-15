import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MdTextField from '../../src/components/md/MdTextField.vue'
import MdSwitch from '../../src/components/md/MdSwitch.vue'
import MdCheckbox from '../../src/components/md/MdCheckbox.vue'
import MdSegmentedButton from '../../src/components/md/MdSegmentedButton.vue'

describe('MdTextField', () => {
  it('v-model 双向', async () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '名称' } })
    await w.find('input').setValue('abc')
    expect(w.emitted('update:modelValue')![0]).toEqual(['abc'])
  })
  it('error 文案渲染', () => {
    expect(mount(MdTextField, { props: { modelValue: '', label: 'x', error: '必填' } }).text()).toContain('必填')
  })
  it('无 error 时不渲染错误行', () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: 'x' } })
    expect(w.find('.md-text-field__error').exists()).toBe(false)
  })
  it('type 与 placeholder 透传', () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '密码', type: 'password', placeholder: '请输入' } })
    expect(w.find('input').attributes('type')).toBe('password')
    expect(w.find('input').attributes('placeholder')).toBe('请输入')
  })
})
describe('MdSwitch', () => {
  it('点击翻转并发 update', async () => {
    const w = mount(MdSwitch, { props: { modelValue: false } })
    await w.find('input[type=checkbox]').setValue(true)
    expect(w.emitted('update:modelValue')![0]).toEqual([true])
    expect(w.classes()).toContain('md-switch--checked')
  })
  it('disabled 时不触发 update', async () => {
    const w = mount(MdSwitch, { props: { modelValue: false, disabled: true } })
    expect(w.classes()).toContain('md-switch--disabled')
    await w.find('input[type=checkbox]').setValue(true)
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
})
describe('MdCheckbox', () => {
  it('点击勾选并发 update,渲染 label', async () => {
    const w = mount(MdCheckbox, { props: { modelValue: false, label: '记住我' } })
    expect(w.text()).toContain('记住我')
    await w.find('input[type=checkbox]').setValue(true)
    expect(w.emitted('update:modelValue')![0]).toEqual([true])
    expect(w.classes()).toContain('md-checkbox--checked')
  })
  it('无 label 时不渲染文字节点', () => {
    const w = mount(MdCheckbox, { props: { modelValue: false } })
    expect(w.find('.md-checkbox__label').exists()).toBe(false)
  })
})
describe('MdSegmentedButton', () => {
  const options = [
    { value: 'auto', label: '自动' },
    { value: 'light', label: '浅色' },
    { value: 'dark', label: '深色' },
  ]
  it('单选切换', async () => {
    const w = mount(MdSegmentedButton, { props: { modelValue: 'auto', options } })
    await w.findAll('button')[2]!.trigger('click')
    expect(w.emitted('update:modelValue')![0]).toEqual(['dark'])
  })
  it('选中段类名与未选中无选中类', () => {
    const w = mount(MdSegmentedButton, { props: { modelValue: 'light', options } })
    const items = w.findAll('.md-seg__item')
    expect(items).toHaveLength(3)
    expect(items[1]!.classes()).toContain('md-seg__item--selected')
    expect(items[0]!.classes()).not.toContain('md-seg__item--selected')
  })
  it('modelValue 不在 options 中时无选中段', () => {
    const w = mount(MdSegmentedButton, { props: { modelValue: 'na', options } })
    expect(w.find('.md-seg__item--selected').exists()).toBe(false)
  })
})
