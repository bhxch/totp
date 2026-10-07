/**
 * edgeAutoScroll 单测（R2-M5）：拖拽边缘自动滚动状态机——近上/下缘启停换向、速度注入、
 * fake rAF 确定性驱动；findScrollHost 溢出 overflow-y 祖先解析（jsdom 无布局恒 null）。
 * CodesPage 仅接线（pointerdown 解析宿主 / move 转发 / clearDrag 停），逻辑全在本模块。
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { AUTO_SCROLL_SPEED_PX, createEdgeAutoScroll, findScrollHost, type ScrollHostLike } from '../src/edgeAutoScroll'

/** fake 宿主：rect 上下缘可配，scrollBy 调用被记录 */
function fakeHost(top = 0, bottom = 600): ScrollHostLike & { calls: number[] } {
  const calls: number[] = []
  return {
    getBoundingClientRect: () => ({ top, bottom }),
    scrollBy: (_x: number, y: number) => { calls.push(y) },
    calls,
  }
}

/** fake rAF：句柄自增；flush(n) 手动推进 n 帧（每帧快照执行后清空——真 rAF 帧级消费语义） */
function fakeRaf() {
  let seq = 0
  const cbs = new Map<number, FrameRequestCallback>()
  const raf = vi.fn((cb: FrameRequestCallback) => { seq += 1; cbs.set(seq, cb); return seq })
  const caf = vi.fn((h: number) => { cbs.delete(h) })
  const flush = (n: number) => {
    for (let i = 0; i < n; i++) {
      const snapshot = [...cbs.values()]
      cbs.clear() // 真实 rAF：回调执行即消费，执行中注册的进入下一帧
      for (const cb of snapshot) cb(0)
    }
  }
  const pending = () => cbs.size
  return { raf, caf, flush, pending }
}

describe('createEdgeAutoScroll', () => {
  it('近上缘（clientY < top+edge）→ dir=-1：rAF 帧驱动 scrollBy 负速度', () => {
    const host = fakeHost(0, 600)
    const t = fakeRaf()
    const c = createEdgeAutoScroll(() => host, { raf: t.raf, caf: t.caf })
    c.update(10) // 上缘 24px 带内
    expect(t.pending()).toBe(1)
    t.flush(3)
    expect(host.calls).toEqual([-8, -8, -8]) // 默认速度 8px/帧
    c.stop()
    expect(t.pending()).toBe(0)
  })

  it('近下缘（clientY > bottom-edge）→ dir=+1 正向滚动；中间离开边缘即停', () => {
    const host = fakeHost(0, 600)
    const t = fakeRaf()
    const c = createEdgeAutoScroll(() => host, { raf: t.raf, caf: t.caf })
    c.update(590) // 下缘带内
    t.flush(2)
    expect(host.calls).toEqual([AUTO_SCROLL_SPEED_PX, AUTO_SCROLL_SPEED_PX])
    c.update(300) // 中间：停
    expect(t.pending()).toBe(0)
    t.flush(3)
    expect(host.calls).toHaveLength(2)
  })

  it('同向同容器重复 update 不重启 rAF；换向重启（先取消旧帧）', () => {
    const host = fakeHost(0, 600)
    const t = fakeRaf()
    const c = createEdgeAutoScroll(() => host, { raf: t.raf, caf: t.caf })
    c.update(10)
    const h1 = t.raf.mock.results.at(-1)!.value
    c.update(5) // 仍上缘：不重启
    expect(t.raf).toHaveBeenCalledTimes(1)
    c.update(590) // 换向下缘：重启
    expect(t.caf).toHaveBeenCalledWith(h1)
    expect(t.raf).toHaveBeenCalledTimes(2)
    c.stop()
  })

  it('宿主 null（无滚动祖先/测试环境）→ update no-op；stop 幂等', () => {
    const t = fakeRaf()
    const c = createEdgeAutoScroll(() => null, { raf: t.raf, caf: t.caf })
    c.update(0)
    c.update(999)
    expect(t.raf).not.toHaveBeenCalled()
    expect(() => c.stop()).not.toThrow()
    expect(() => c.stop()).not.toThrow()
  })

  it('stop 后不再滚动（rAF 循环已取消，flush 无副作用）', () => {
    const host = fakeHost(0, 600)
    const t = fakeRaf()
    const c = createEdgeAutoScroll(() => host, { raf: t.raf, caf: t.caf })
    c.update(10)
    c.stop()
    t.flush(5)
    expect(host.calls).toEqual([])
  })
})

describe('findScrollHost', () => {
  it('最近溢出的 overflow-y auto 祖先被选中；无溢出祖先返回 null（jsdom 无布局恒 null）', () => {
    document.body.innerHTML = '<div class="outer"><div class="inner"><span class="leaf"></span></div></div>'
    const leaf = document.querySelector('.leaf') as HTMLElement
    // 无溢出：null
    expect(findScrollHost(leaf)).toBeNull()
    // mock outer 为溢出滚动容器
    const outer = document.querySelector('.outer') as HTMLElement
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => ({
      overflowY: el === outer ? 'auto' : 'visible',
    }) as CSSStyleDeclaration)
    Object.defineProperty(outer, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(outer, 'clientHeight', { value: 400, configurable: true })
    expect(findScrollHost(leaf)).toBe(outer)
    vi.restoreAllMocks()
  })
})
