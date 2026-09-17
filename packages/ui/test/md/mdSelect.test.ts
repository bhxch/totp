import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import MdSelect from '../../src/components/md/MdSelect.vue'

const OPTIONS = [
  { value: 15, label: '15 分钟' },
  { value: 60, label: '1 小时' },
  { value: 360, label: '6 小时' },
  { value: 1440, label: '每天' },
]

describe('MdSelect', () => {
  afterEach(() => vi.restoreAllMocks())

  it('①渲染触发字段与 label；有选中值时 label 悬浮类', () => {
    const w = mount(MdSelect, { props: { label: '自动同步间隔', modelValue: 60, options: OPTIONS } })
    expect(w.find('.md-select__label').text()).toBe('自动同步间隔')
    expect(w.find('.md-select__label').classes()).toContain('md-select__label--floated')
    expect(w.find('.md-select__value').text()).toBe('1 小时')
    // 关闭态不渲染弹层
    expect(w.find('.md-select__menu').exists()).toBe(false)
  })

  it('②点击开启弹层：role=listbox/option，aria-selected 仅当前选中项', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS } })
    await w.find('button.md-select__trigger').trigger('click')
    const menu = w.find('[role="listbox"]')
    expect(menu.exists()).toBe(true)
    const opts = w.findAll('[role="option"]')
    expect(opts).toHaveLength(4)
    expect(opts.map((o) => o.text())).toEqual(['15 分钟', '1 小时', '6 小时', '每天'])
    expect(opts[1]!.attributes('aria-selected')).toBe('true')
    expect(opts[0]!.attributes('aria-selected')).toBe('false')
    expect(opts[1]!.classes()).toContain('md-select__option--selected')
    expect(opts[0]!.classes()).not.toContain('md-select__option--selected')
  })

  it('③点选 emit update:modelValue 并关闭弹层', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS } })
    await w.find('button.md-select__trigger').trigger('click')
    await w.findAll('[role="option"]').find((o) => o.text() === '每天')!.trigger('click')
    expect(w.emitted('update:modelValue')![0]).toEqual([1440])
    expect(w.find('[role="listbox"]').exists()).toBe(false)
  })

  it('④键盘：Enter 开启 → ArrowDown 移动高亮 → Enter 选中 → Esc 关闭且焦点回触发按钮', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS }, attachTo: document.body })
    const trigger = w.find('button.md-select__trigger')
    await trigger.trigger('keydown', { key: 'Enter' })
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    // 开启时高亮定位到当前选中项
    expect(w.findAll('[role="option"]')[1]!.classes()).toContain('md-select__option--active')
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    expect(w.findAll('[role="option"]')[2]!.classes()).toContain('md-select__option--active')
    await trigger.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('update:modelValue')![0]).toEqual([360])
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    // Esc 关闭（再开后）且焦点保持在触发按钮
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    await trigger.trigger('keydown', { key: 'Escape' })
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    // Space 也能开启
    await trigger.trigger('keydown', { key: ' ' })
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    w.unmount()
  })

  it('⑤触发按钮 aria-haspopup=listbox 且 aria-expanded 随开关翻转', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS } })
    const trigger = w.find('button.md-select__trigger')
    expect(trigger.attributes('aria-haspopup')).toBe('listbox')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })

  it('⑥点外部（document mousedown）关闭；卸载后监听器随移除', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS }, attachTo: document.body })
    await w.find('button.md-select__trigger').trigger('click')
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    // 组件内 mousedown 不关闭
    w.find('.md-select__box').element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    // 外部 mousedown 关闭（原生事件后需 nextTick 等响应式渲染）
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    // 卸载：document 监听器被移除，再派发外部 mousedown 无副作用
    w.unmount()
    expect(removeSpy).toHaveBeenCalledWith('mousedown', expect.any(Function))
    expect(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))).not.toThrow()
  })

  it('⑦disabled 不开启且根降级类；触发按钮带 disabled 属性', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS, disabled: true } })
    expect(w.classes()).toContain('md-select--disabled')
    expect((w.find('button.md-select__trigger').element as HTMLButtonElement).disabled).toBe(true)
    await w.find('button.md-select__trigger').trigger('click')
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    // 非 disabled 无降级类
    const w2 = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS } })
    expect(w2.classes()).not.toContain('md-select--disabled')
  })

  it('⑧初始选中项 aria-selected 与高亮类（不经开启直接断言挂载态）', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 360, options: OPTIONS } })
    await w.find('button.md-select__trigger').trigger('click')
    const opts = w.findAll('[role="option"]')
    expect(opts[2]!.attributes('aria-selected')).toBe('true')
    expect(opts[2]!.classes()).toContain('md-select__option--selected')
    expect(opts[2]!.classes()).toContain('md-select__option--active') // 开启时高亮定位选中项
  })

  it('⑨options 为空：渲染安全不崩，弹层为空且键盘不抛错', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: '', options: [] } })
    await w.find('button.md-select__trigger').trigger('click')
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    expect(w.findAll('[role="option"]')).toHaveLength(0)
    // 空列表键盘移动/选中不抛错
    const trigger = w.find('button.md-select__trigger')
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    await trigger.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('⑩value 为 number：点选往返保持 number 不转字符串', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 15, options: OPTIONS } })
    await w.find('button.md-select__trigger').trigger('click')
    await w.findAll('[role="option"]').find((o) => o.text() === '每天')!.trigger('click')
    const emitted = w.emitted('update:modelValue')![0]!
    expect(emitted[0]).toBe(1440)
    expect(typeof emitted[0]).toBe('number')
  })

  it('⑪开启后窗口 resize/scroll 关闭（简化策略）', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS }, attachTo: document.body })
    const trigger = w.find('button.md-select__trigger')
    await trigger.trigger('click')
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    await trigger.trigger('click')
    window.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    w.unmount()
  })

  it('⑫弹层内滚动（scroll 捕获收到弹层自身）不误关', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS }, attachTo: document.body })
    await w.find('button.md-select__trigger').trigger('click')
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    // scroll 派发到弹层元素（捕获阶段 window 会收到，target=弹层且在组件内 → 排除）
    w.find('.md-select__menu').element.dispatchEvent(new Event('scroll', { bubbles: true }))
    await nextTick()
    expect(w.find('[role="listbox"]').exists()).toBe(true)
    // 弹层外滚动仍关闭
    document.body.dispatchEvent(new Event('scroll', { bubbles: true }))
    await nextTick()
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    w.unmount()
  })

  it('⑬resize 被动关闭不抢焦点；Tab 关闭不 preventDefault', async () => {
    const w = mount(MdSelect, { props: { label: '间隔', modelValue: 60, options: OPTIONS }, attachTo: document.body })
    const trigger = w.find('button.md-select__trigger')
    await trigger.trigger('click')
    // 焦点已移走（模拟用户 Tab 离开后滚动页面）
    ;(trigger.element as HTMLElement).blur()
    expect(document.activeElement).not.toBe(trigger.element)
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    expect(document.activeElement).not.toBe(trigger.element) // 不回焦
    // Tab 关闭：不 preventDefault，焦点随 Tab 自然走
    await trigger.trigger('click')
    const ev = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    trigger.element.dispatchEvent(ev)
    await nextTick()
    expect(ev.defaultPrevented).toBe(false)
    expect(w.find('[role="listbox"]').exists()).toBe(false)
    w.unmount()
  })
})
