/**
 * 拖拽边缘自动滚动控制器（R2-M5）：pointer 长按拖拽长列表时，指针接近滚动容器上/下缘
 * 触发 rAF 驱动的匀速滚动，离开边缘或 drop/cancel 停止——否则长列表中拖动条目到视口外
 * 不可达（真机触屏/鼠标均受限，列表高于视口时无法跨屏移动）。
 *
 * - 滚动宿主由调用方解析注入（CodesPage 在 pointerdown 时从把手向上找最近可滚动祖先，
 *   见 findScrollHost；jsdom 无布局恒 null → 控制器 no-op，组件测试不受影响）；
 * - update 按 clientY 相对容器 rect 的边缘带（默认 24px）判定方向：上缘 -1 / 下缘 +1 /
 *   中间 0；方向或容器变化时重启 rAF 循环，同向同容器不动（避免每 move 重挂 rAF）；
 * - 速度按帧固定（默认 8px/帧 ~60fps ≈ 480px/s），离开边缘或 stop 立即停。
 * 宿主抽象为最小结构面（rect + scrollBy），单测可注入 fake 宿主与 fake rAF 确定性驱动。
 */
export const AUTO_SCROLL_EDGE_PX = 24
export const AUTO_SCROLL_SPEED_PX = 8

/** 滚动宿主最小结构面（HTMLElement 结构兼容；fake 注入用） */
export interface ScrollHostLike {
  getBoundingClientRect(): { top: number; bottom: number }
  scrollBy(x: number, y: number): void
}

export interface EdgeAutoScrollController {
  /** pointermove 中调用：按指针纵坐标相对宿主边缘带启停/换向滚动 */
  update(clientY: number): void
  /** drop/cancel：停止 rAF 循环并清容器 */
  stop(): void
}

export function createEdgeAutoScroll(
  getHost: () => ScrollHostLike | null,
  opts: { edge?: number; speed?: number; raf?: (cb: FrameRequestCallback) => number; caf?: (handle: number) => void } = {},
): EdgeAutoScrollController {
  const edge = opts.edge ?? AUTO_SCROLL_EDGE_PX
  const speed = opts.speed ?? AUTO_SCROLL_SPEED_PX
  const raf = opts.raf ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb))
  const caf = opts.caf ?? ((handle: number) => cancelAnimationFrame(handle))

  let handle = 0
  let dir = 0
  let host: ScrollHostLike | null = null
  function step(): void {
    if (dir === 0 || host === null) return
    host.scrollBy(0, dir * speed)
    handle = raf(step)
  }
  function halt(): void {
    if (handle !== 0) caf(handle)
    handle = 0
    dir = 0
    host = null
  }
  return {
    update(clientY: number): void {
      const h = getHost()
      // 宿主不可测（无滚动祖先/测试环境）→ 停；指针离开边缘带 → 停
      let next = 0
      if (h !== null) {
        const rect = h.getBoundingClientRect()
        if (clientY < rect.top + edge) next = -1
        else if (clientY > rect.bottom - edge) next = 1
      }
      if (next === dir && h === host) return
      halt()
      if (next === 0 || h === null) return
      dir = next
      host = h
      handle = raf(step)
    },
    stop: halt,
  }
}

/** 从起始元素向上找最近的可滚动祖先（overflow-y auto/scroll 且内容实际溢出）；
 *  找不到返回 null（控制体 no-op）。jsdom 无布局（scrollHeight=clientHeight=0）恒 null */
export function findScrollHost(el: HTMLElement | null): ScrollHostLike | null {
  let cur = el?.parentElement ?? null
  while (cur !== null) {
    const oy = getComputedStyle(cur).overflowY
    if ((oy === 'auto' || oy === 'scroll') && cur.scrollHeight > cur.clientHeight) return cur
    cur = cur.parentElement
  }
  return null
}
