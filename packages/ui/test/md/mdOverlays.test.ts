import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import MdDialog from '../../src/components/md/MdDialog.vue'
import MdMenu from '../../src/components/md/MdMenu.vue'

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
  it('外点（document mousedown）emit close；容器内 mousedown 不关；open=false 后监听随移除', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const w = mount(MdMenu, { props: { open: true, x: 0, y: 0 }, attachTo: document.body })
    // 容器内 mousedown 不关
    w.find('.md-menu').element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(w.emitted('close')).toBeUndefined()
    // 外点 mousedown 关闭
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(w.emitted('close')).toHaveLength(1)
    // open 翻转为 false 后监听移除（宿主收起后不再响应）
    await w.setProps({ open: false })
    expect(removeSpy).toHaveBeenCalledWith('mousedown', expect.any(Function))
    w.unmount()
  })

  // ---- 批 6 a11y：方向键导航 / menuitem role / 开启聚焦首项 / Tab 关闭 / Esc 焦点回触发点 ----

  /** 挂载含 3 个真实 button 菜单项的开启态菜单（需 attachTo 才能聚焦） */
  function mountMenu(props: Record<string, unknown> = {}) {
    const w = mount(MdMenu, {
      props: { open: true, x: 0, y: 0, ...props },
      slots: { default: '<button id="m-a">A</button><button id="m-b">B</button><button id="m-c">C</button>' },
      attachTo: document.body,
    })
    return w
  }
  function press(key: string): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key, cancelable: true })
    window.dispatchEvent(ev)
    return ev
  }
  const item = (id: string) => document.getElementById(id)!

  it('open 后首个菜单项获得焦点（APG menu 推荐）', async () => {
    const w = mountMenu()
    await nextTick()
    expect(document.activeElement).toBe(item('m-a'))
    w.unmount()
  })
  it('open 后菜单项带 role=menuitem（根已 role=menu）', async () => {
    const w = mountMenu()
    await nextTick()
    expect(w.findAll('.md-menu button').map((b) => b.attributes('role'))).toEqual(['menuitem', 'menuitem', 'menuitem'])
    w.unmount()
  })
  it('ArrowDown/ArrowUp 在菜单项间循环移动焦点', async () => {
    const w = mountMenu()
    await nextTick()
    expect(document.activeElement).toBe(item('m-a')) // 开启聚焦首项起步
    press('ArrowDown')
    expect(document.activeElement).toBe(item('m-b'))
    press('ArrowDown')
    expect(document.activeElement).toBe(item('m-c'))
    press('ArrowDown')
    expect(document.activeElement).toBe(item('m-a')) // 末项循环回首项
    press('ArrowUp')
    expect(document.activeElement).toBe(item('m-c')) // 反向循环
    w.unmount()
  })
  it('Home 跳首项 / End 跳末项；空菜单键盘不抛错', async () => {
    const w = mountMenu()
    await nextTick()
    item('m-b').focus()
    press('Home')
    expect(document.activeElement).toBe(item('m-a'))
    press('End')
    expect(document.activeElement).toBe(item('m-c'))
    w.unmount()
    // 无可聚焦项：方向键静默跳过不抛错
    const empty = mount(MdMenu, { props: { open: true, x: 0, y: 0 }, attachTo: document.body })
    await nextTick()
    expect(() => press('ArrowDown')).not.toThrow()
    expect(() => press('End')).not.toThrow()
    empty.unmount()
  })
  it('Tab 关闭：emit close、不 preventDefault、焦点不被组件拉回', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const w = mountMenu({ triggerEl: trigger })
    await nextTick()
    expect(document.activeElement).toBe(item('m-a')) // 焦点在菜单内
    const ev = press('Tab')
    expect(w.emitted('close')).toHaveLength(1)
    expect(ev.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(item('m-a')) // 未被拉回 trigger（焦点随 Tab 自然走）
    w.unmount()
    trigger.remove()
  })
  it('Esc 关闭：triggerEl 存在且焦点在菜单内时焦点回触发元素', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const w = mountMenu({ triggerEl: trigger })
    await nextTick()
    press('Escape')
    expect(w.emitted('close')).toHaveLength(1)
    expect(document.activeElement).toBe(trigger)
    w.unmount()
    trigger.remove()
  })
  it('导航跳过 disabled 菜单项：聚焦首项与方向键循环均不含 disabled（边界）', async () => {
    const w = mount(MdMenu, {
      props: { open: true, x: 0, y: 0 },
      slots: { default: '<button id="m-x">X</button><button id="m-d" disabled>D</button><button id="m-y">Y</button>' },
      attachTo: document.body,
    })
    await nextTick()
    expect(document.activeElement).toBe(item('m-x')) // 首个可聚焦项不含 disabled
    press('ArrowDown')
    expect(document.activeElement).toBe(item('m-y')) // 跳过 disabled 的 m-d
    press('ArrowDown')
    expect(document.activeElement).toBe(item('m-x')) // 循环回首项
    press('ArrowUp')
    expect(document.activeElement).toBe(item('m-y')) // 反向同样跳过
    w.unmount()
  })
  it('Esc 关闭：焦点不在菜单内或 triggerEl 未接文档时不抢焦点', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    const w = mountMenu({ triggerEl: trigger })
    await nextTick()
    item('m-a').blur() // 焦点已离开菜单（如用户 Tab 走后 Esc 被动触发）
    press('Escape')
    expect(w.emitted('close')).toHaveLength(1)
    expect(document.activeElement).not.toBe(trigger)
    w.unmount()
    // triggerEl 未在文档中（已移除）：静默跳过不抛错
    const detached = document.createElement('button')
    const w2 = mountMenu({ triggerEl: detached })
    await nextTick()
    expect(() => press('Escape')).not.toThrow()
    w2.unmount()
    trigger.remove()
  })
  it('位置越界夹取：x/y 超出视口时钳回视口内边距（EST 尺寸推算）', () => {
    const w = mount(MdMenu, { props: { open: true, x: 5000, y: 5000 } })
    const style = w.find('.md-menu').attributes('style')!
    const left = Number(/left: (\d+)px/.exec(style)![1])
    const top = Number(/top: (\d+)px/.exec(style)![1])
    expect(left).toBeLessThanOrEqual(window.innerWidth)
    expect(top).toBeLessThanOrEqual(window.innerHeight)
    w.unmount()
  })
  it('menuItems 过滤 aria-disabled 与 hidden 项；焦点不在项上时 ArrowUp 落末项', async () => {
    const w = mount(MdMenu, {
      props: { open: true, x: 0, y: 0 },
      slots: {
        default:
          '<button id="m-a2">A</button>' +
          '<button id="m-aria" aria-disabled="true">ARIA</button>' +
          '<button id="m-hidden" hidden>Hidden</button>' +
          '<button id="m-z">Z</button>',
      },
      attachTo: document.body,
    })
    await nextTick()
    item('m-a2').blur()
    press('ArrowUp') // 焦点不在项上：ArrowUp 落末个可聚焦项（跳过 aria-disabled/hidden）
    expect(document.activeElement).toBe(item('m-z'))
    w.unmount()
  })
})

describe('MdDialog 焦点陷阱边界', () => {
  function pressOnDialog(key: string): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key, cancelable: true })
    window.dispatchEvent(ev)
    return ev
  }
  it('非 Tab/Escape 按键：不触发 close 也不 preventDefault', () => {
    const w = mount(MdDialog, { props: { open: true }, slots: { default: '<button id="md-a">A</button>' }, attachTo: document.body })
    const ev = pressOnDialog('Enter')
    expect(ev.defaultPrevented).toBe(false)
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })
  it('无可聚焦内容：Tab 被 preventDefault（焦点守卫兜底）', () => {
    const w = mount(MdDialog, { props: { open: true }, attachTo: document.body })
    const ev = pressOnDialog('Tab')
    expect(ev.defaultPrevented).toBe(true)
    w.unmount()
  })
  it('焦点在容器外时 Tab：拉回容器内（preventDefault + root.focus）', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const w = mount(MdDialog, { props: { open: true }, slots: { default: '<button id="md-b">B</button>' }, attachTo: document.body })
    await nextTick()
    outside.focus() // nextTick 后 dialog 抢焦，再显式移回外部
    const ev = pressOnDialog('Tab')
    expect(ev.defaultPrevented).toBe(true)
    w.unmount()
    outside.remove()
  })
})
