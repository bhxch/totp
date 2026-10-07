/**
 * dragDropGuard 直测（R2-I1）：全局 dragover/drop preventDefault 兜底注册——
 * - 派发到 window 的 dragover/drop 事件 defaultPrevented 置位（阻断 WebView2 默认 file:// 导航）；
 * - 元素级 drop 处理（BatchPastePanel 同型）先于 window 冒泡执行，兜底不吞事件本身；
 * - unlisten 反注册后不再干预（默认导航不再被兜底阻止）。
 * jsdom 无 DragEvent 构造器（未实现 DnD），以可取消 Event 派发——preventDefault/defaultPrevented
 * 语义与真实 DragEvent 一致；lib.rs 侧 disable_drag_drop_handler 联动为注释契约（R2-M6），不在此测。
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { installDragDropGuard } from '../src/dragDropGuard'

function fireWindowDragEvent(type: string): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  window.dispatchEvent(e)
  return e
}

describe('installDragDropGuard（R2-I1）', () => {
  it('window 级 dragover/drop 被 preventDefault（默认导航被兜底阻断）', () => {
    const unlisten = installDragDropGuard()
    try {
      expect(fireWindowDragEvent('dragover').defaultPrevented).toBe(true)
      expect(fireWindowDragEvent('drop').defaultPrevented).toBe(true)
    } finally {
      unlisten()
    }
  })

  it('元素级 drop 处理器照常收到事件并可自行处理（兜底只吞默认导航不吞事件）', () => {
    const unlisten = installDragDropGuard()
    try {
      const onDrop = vi.fn()
      const zone = document.createElement('div')
      document.body.appendChild(zone)
      zone.addEventListener('drop', onDrop)
      const e = new Event('drop', { bubbles: true, cancelable: true })
      zone.dispatchEvent(e)
      expect(onDrop).toHaveBeenCalledTimes(1)
      expect(e.defaultPrevented).toBe(true)
      zone.remove()
    } finally {
      unlisten()
    }
  })

  it('unlisten 反注册后不再干预（事件可保持未阻止状态）', () => {
    const unlisten = installDragDropGuard()
    unlisten()
    expect(fireWindowDragEvent('drop').defaultPrevented).toBe(false)
  })
})
