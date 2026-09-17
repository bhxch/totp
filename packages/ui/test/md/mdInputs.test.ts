import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
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
  it('error 时 input 标记 aria-invalid 且 aria-describedby 指向错误文案 id', () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: 'x', error: '必填' } })
    const input = w.find('input')
    expect(input.attributes('aria-invalid')).toBe('true')
    const described = input.attributes('aria-describedby')
    expect(described).toBeTruthy()
    const errorLine = w.find('.md-text-field__error')
    expect(errorLine.attributes('id')).toBe(described)
    expect(errorLine.text()).toContain('必填')
  })
  it('error id 跨实例唯一', () => {
    const a = mount(MdTextField, { props: { modelValue: '', label: 'x', error: 'a' } })
    const b = mount(MdTextField, { props: { modelValue: '', label: 'x', error: 'b' } })
    const idA = a.find('input').attributes('aria-describedby')!
    const idB = b.find('input').attributes('aria-describedby')!
    expect(idA).not.toBe(idB)
    expect(a.find('.md-text-field__error').attributes('id')).toBe(idA)
    expect(b.find('.md-text-field__error').attributes('id')).toBe(idB)
  })
  it('无 error 时不渲染 aria-invalid/aria-describedby', () => {
    const input = mount(MdTextField, { props: { modelValue: '', label: 'x' } }).find('input')
    expect(input.attributes('aria-invalid')).toBeUndefined()
    expect(input.attributes('aria-describedby')).toBeUndefined()
  })
  it('ariaLabel 落到内部 input 的 aria-label;不传则不加', () => {
    const withLabel = mount(MdTextField, { props: { modelValue: '', label: 'x', ariaLabel: '搜索' } })
    expect(withLabel.find('input').attributes('aria-label')).toBe('搜索')
    const withoutLabel = mount(MdTextField, { props: { modelValue: '', label: 'x' } })
    expect(withoutLabel.find('input').attributes('aria-label')).toBeUndefined()
  })
  it('非 class/style 属性透传内部 input（autocomplete/min/max/disabled/data-*）', () => {
    const w = mount(MdTextField, {
      props: { modelValue: '3', label: '位数', type: 'number' },
      attrs: { autocomplete: 'off', min: '1', max: '8', disabled: true, 'data-field': 'digits' },
    })
    const input = w.find('input')
    expect(input.attributes('autocomplete')).toBe('off')
    expect(input.attributes('min')).toBe('1')
    expect(input.attributes('max')).toBe('8')
    expect(input.attributes('disabled')).toBeDefined()
    expect(input.attributes('data-field')).toBe('digits')
  })
  it('class/style 落根元素（消费方布局依赖），不进内部 input', () => {
    const w = mount(MdTextField, {
      props: { modelValue: '', label: 'x' },
      attrs: { class: 'grow', style: 'flex: 1' },
    })
    expect(w.find('.md-text-field').classes()).toContain('grow')
    expect(w.find('input').classes()).not.toContain('grow')
  })
  it('onKeydown 监听透传内部 input（回车提交等键盘交互依赖）', async () => {
    const onKeydown = vi.fn()
    const w = mount(MdTextField, {
      props: { modelValue: '', label: 'x' },
      attrs: { onKeydown },
    })
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(onKeydown).toHaveBeenCalled()
  })
  it('disabled 透传时根带 md-text-field--disabled 降级类（视觉对齐其他 md 组件）', () => {
    const on = mount(MdTextField, { props: { modelValue: '', label: 'x' }, attrs: { disabled: true } })
    expect(on.classes()).toContain('md-text-field--disabled')
    const off = mount(MdTextField, { props: { modelValue: '', label: 'x' }, attrs: { disabled: false } })
    expect(off.classes()).not.toContain('md-text-field--disabled')
    const none = mount(MdTextField, { props: { modelValue: '', label: 'x' } })
    expect(none.classes()).not.toContain('md-text-field--disabled')
  })
  it('disabled 动态移除后降级类消失（$attrs 响应式）', async () => {
    const Harness = defineComponent({
      props: { disabled: Boolean },
      setup: props => () => h(MdTextField, { modelValue: '', label: 'x', disabled: props.disabled || undefined }),
    })
    const w = mount(Harness, { props: { disabled: true } })
    expect(w.find('.md-text-field').classes()).toContain('md-text-field--disabled')
    await w.setProps({ disabled: false })
    expect(w.find('.md-text-field').classes()).not.toContain('md-text-field--disabled')
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
  it('input 带 role=switch;ariaLabel 落到 input 的 aria-label;不传则不加', () => {
    const withLabel = mount(MdSwitch, { props: { modelValue: false, ariaLabel: '启用同步' } })
    const input = withLabel.find('input')
    expect(input.attributes('role')).toBe('switch')
    expect(input.attributes('aria-label')).toBe('启用同步')
    const withoutLabel = mount(MdSwitch, { props: { modelValue: false } })
    expect(withoutLabel.find('input').attributes('aria-label')).toBeUndefined()
  })
  it('未选中拇指 16dp/选中 24dp（M3 拇指随状态缩放）：thumb 样式钩子存在且随 checked 切换类', async () => {
    const w = mount(MdSwitch, { props: { modelValue: false } })
    // 未选中：thumb 节点存在、容器无 checked 类（拇指缩放样式挂载点）
    expect(w.find('.md-switch__thumb').exists()).toBe(true)
    expect(w.classes()).not.toContain('md-switch--checked')
    await w.find('input[type=checkbox]').setValue(true)
    expect(w.classes()).toContain('md-switch--checked')
    // jsdom 不应用 SFC 样式，16dp/24dp 档位以源码断言（同 themeTypescale 读 tokens.css 模式）
    const src = readFileSync(join(__dirname, '../../src/components/md/MdSwitch.vue'), 'utf8')
    expect(src).toMatch(/\.md-switch__thumb\s*\{[^}]*width:\s*16px/)
    expect(src).toMatch(/\.md-switch--checked \.md-switch__thumb\s*\{[^}]*width:\s*24px/)
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
  it('ariaLabel 落到内部 input 的 aria-label;不传则不加', () => {
    const withLabel = mount(MdCheckbox, { props: { modelValue: false, ariaLabel: '搜索密钥' } })
    expect(withLabel.find('input').attributes('aria-label')).toBe('搜索密钥')
    const withoutLabel = mount(MdCheckbox, { props: { modelValue: false } })
    expect(withoutLabel.find('input').attributes('aria-label')).toBeUndefined()
  })
  it('disabled 时 input 带 disabled 且不触发 update', async () => {
    const w = mount(MdCheckbox, { props: { modelValue: false, disabled: true } })
    expect(w.find('input').attributes('disabled')).toBeDefined()
    expect(w.classes()).toContain('md-checkbox--disabled')
    await w.find('input[type=checkbox]').setValue(true)
    expect(w.emitted('update:modelValue')).toBeUndefined()
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
  it('ArrowRight/ArrowLeft 移动选中 emit,焦点跟随选中段', async () => {
    const w = mount(MdSegmentedButton, { props: { modelValue: 'light', options }, attachTo: document.body })
    const btns = w.findAll('button')
    ;(btns[1]!.element as HTMLElement).focus()
    await btns[1]!.trigger('keydown', { key: 'ArrowRight' })
    expect(w.emitted('update:modelValue')![0]).toEqual(['dark'])
    expect(document.activeElement).toBe(btns[2]!.element)
    await w.setProps({ modelValue: 'dark' })
    expect(btns[2]!.attributes('tabindex')).toBe('0')
    expect(btns[0]!.attributes('tabindex')).toBe('-1')
    expect(btns[1]!.attributes('tabindex')).toBe('-1')
    await btns[2]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(w.emitted('update:modelValue')![1]).toEqual(['light'])
    expect(document.activeElement).toBe(btns[1]!.element)
    w.unmount()
  })
  it('边界夹取:首段 ArrowLeft、末段 ArrowRight 不移动不 emit', async () => {
    const w = mount(MdSegmentedButton, { props: { modelValue: 'auto', options } })
    await w.findAll('button')[0]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(w.emitted('update:modelValue')).toBeUndefined()
    await w.setProps({ modelValue: 'dark' })
    await w.findAll('button')[2]!.trigger('keydown', { key: 'ArrowRight' })
    expect(w.emitted('update:modelValue')).toBeUndefined()
    await w.findAll('button')[2]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(w.emitted('update:modelValue')![0]).toEqual(['light'])
  })
  it('选中段 roving tabindex=0 其余 -1', () => {
    const w = mount(MdSegmentedButton, { props: { modelValue: 'dark', options } })
    const btns = w.findAll('button')
    expect(btns[2]!.attributes('tabindex')).toBe('0')
    expect(btns[0]!.attributes('tabindex')).toBe('-1')
    expect(btns[1]!.attributes('tabindex')).toBe('-1')
  })
})
