/**
 * mini 窗口「复制后 500ms 自动隐藏」控制器（审查 I-1 武装竞态守卫）。
 *
 * 背景：copy() 是 async——await IPC 落地之后才武装 hide timer；双击揭示（OtpListItem 内部 8s）
 * 须取消该 timer，否则揭示 0.5s 后窗口即被隐藏，「双击显示 8 秒」不可达。单纯的 clearTimeout
 * 取消存在武装竞态：若双击先于 IPC promise resolve 派发（慢机器可复现），cancel 执行时 timer
 * 还是 null，取消落空，随后武装的 timer 照常触发，揭示仍被截断。
 *
 * 守卫语义（揭示代次快照）：onDblclick 递增代次；copy 在开始（首个 await 前）经 beginCopy
 * 快照代次，await 全部落地后 completeCopy 比对——失配说明 await 期间发生过双击，跳过武装。
 * 相比一次性置位标志（读到即清），快照天然覆盖双击序列 click→click→dblclick 产生的两次在途
 * copy（两次 copy 各持旧快照，都会检出失配），也不会被陈旧标志误伤后续普通单击 copy
 * （新 copy 快照到递增后的当前代次，照常武装自动隐藏）。
 */
export interface CopyAutoHideController {
  /** copy 开始时调用（首个 await 之前）：快照当前揭示代次 */
  beginCopy(): number
  /** copy 全部 await 落地后调用：代次未变则（重）武装 delayMs 后 hide；失配则跳过 */
  completeCopy(generation: number): void
  /** 双击揭示：清已武装 timer 并递增代次（使在途 copy 的快照失配） */
  onDblclick(): void
}

export function createCopyAutoHide(delayMs: number, hide: () => void): CopyAutoHideController {
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  return {
    beginCopy: () => generation,
    completeCopy(gen) {
      // 后写优先：连续两次 copy 只保留最后一个 timer（对齐 popup copy 先清后武装的口径）
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // I-1 竞态守卫：await 期间发生过双击（cancel 先于 timer 武装到达）→ 不武装，让位揭示
      if (gen !== generation) return
      timer = setTimeout(() => {
        timer = null
        hide()
      }, delayMs)
    },
    onDblclick() {
      generation++
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
