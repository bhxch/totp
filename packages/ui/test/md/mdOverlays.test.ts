import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import MdDialog from '../../src/components/md/MdDialog.vue'
import MdMenu from '../../src/components/md/MdMenu.vue'
import MdListItem from '../../src/components/md/MdListItem.vue'

describe('MdDialog', () => {
  it('open=false 不渲染', () => {
    expect(mount(MdDialog, { props: { open: false } }).find('.md-dialog').exists()).toBe(false)
  })
  it('Esc 关闭;actions 内 data-md-close 点击关闭', async () => {
    const w = mount(MdDialog, { props: { open: true, headline: '确认' }, slots: { actions: '<button data-md-close>好</button>' }, attachTo: document.body })
    await w.find('.md-dialog__scrim').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    await w.find('[data-md-close]').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
  })
  it('Tab 在末个可聚焦元素上循环回首元素,Shift+Tab 反向', async () => {
    const w = mount(MdDialog, {
      props: { open: true },
      slots: { default: '<button id="trap-a">A</button><button id="trap-b">B</button>' },
      attachTo: document.body,
    })
    await nextTick()
    const a = document.getElementById('trap-a')!
    const b = document.getElementById('trap-b')!
    b.focus()
    expect(document.activeElement).toBe(b)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(document.activeElement).toBe(a)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }))
    expect(document.activeElement).toBe(b)
    w.unmount()
  })
  it('焦点在容器上按 Tab 进入首个可聚焦元素', async () => {
    const w = mount(MdDialog, {
      props: { open: true },
      slots: { default: '<button id="trap-c">C</button><button id="trap-d">D</button>' },
      attachTo: document.body,
    })
    await nextTick()
    const dialog = w.find('.md-dialog').element as HTMLElement
    expect(document.activeElement).toBe(dialog)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(document.activeElement).toBe(document.getElementById('trap-c'))
    w.unmount()
  })
  it('open=false 时 Tab keydown 不被拦截(preventDefault 未发生)', async () => {
    const w = mount(MdDialog, {
      props: { open: false },
      slots: { default: '<button id="trap-e">E</button>' },
      attachTo: document.body,
    })
    await nextTick()
    const e = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(document.body)
    w.unmount()
  })
})
describe('MdMenu', () => {
  it('定位到 x/y 且 open=false 不渲染', () => {
    const closed = mount(MdMenu, { props: { open: false, x: 0, y: 0 } })
    expect(closed.find('.md-menu').exists()).toBe(false)
    const w = mount(MdMenu, { props: { open: true, x: 40, y: 60 } })
    expect(w.find('.md-menu').attributes('style')).toContain('left: 40px')
    expect(w.find('.md-menu').attributes('style')).toContain('top: 60px')
  })
  it('根 wrapper 带 role=menu', () => {
    const w = mount(MdMenu, { props: { open: true, x: 0, y: 0 } })
    expect(w.find('.md-menu').attributes('role')).toBe('menu')
  })
})
describe('MdListItem', () => {
  it('danger 类与 click', async () => {
    const w = mount(MdListItem, { props: { label: '删除', danger: true } })
    expect(w.classes()).toContain('md-list-item--danger')
    await w.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })
})
