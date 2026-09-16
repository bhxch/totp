export type AutoRunReason = 'change' | 'interval'

/** 定时轮询粒度：每 30s 醒来一次并按「距上次到点 ≥ 间隔」判断，牺牲秒级精度换取与宿主定时器解耦的轻量实现 */
const TICK_MS = 30_000

export interface SchedulerOptions {
  debounceMs: number
  /** 当前定时间隔毫秒；null=未启用。每次 tick 重新求值（支持运行中改配置） */
  intervalMs: () => number | null
  run: (reason: AutoRunReason) => Promise<void>
  /** run 抛错/拒绝时的宿主回调；不提供则错误被吞（记录与告警职责在宿主） */
  onError?: (err: unknown, reason: AutoRunReason) => void
}

export interface AutoRunScheduler {
  notifyChanged(): void
  start(): void
  stop(): void
}

/** 定时策略与宿主解耦：desktop 传真定时器，测试传 fake；extension 仅用 change 通道 */
export function createAutoRunScheduler(opts: SchedulerOptions): AutoRunScheduler {
  let changeTimer: ReturnType<typeof setTimeout> | undefined
  let intervalTimer: ReturnType<typeof setInterval> | undefined
  let running = false
  let pendingChange = false
  let lastIntervalRunAt = 0

  function rescheduleChange() {
    if (changeTimer !== undefined) clearTimeout(changeTimer)
    changeTimer = setTimeout(() => {
      changeTimer = undefined
      void invoke('change')
    }, opts.debounceMs)
  }

  async function invoke(reason: AutoRunReason): Promise<void> {
    if (running) {
      if (reason === 'change') pendingChange = true // 尾部合并：当前 run 结束后补跑一次
      return
    }
    running = true
    try {
      await opts.run(reason)
    } catch (err) {
      opts.onError?.(err, reason)
    } finally {
      running = false
      if (pendingChange) {
        pendingChange = false
        rescheduleChange() // 清掉 running 期间可能新挂的防抖 timer，保证只补跑一次
      }
    }
  }

  return {
    notifyChanged() {
      rescheduleChange()
    },
    /** 启动定时刻度。lastIntervalRunAt 从当前时刻起算，宿主如需立即检查请先 notifyChanged() */
    start() {
      if (intervalTimer !== undefined) return
      lastIntervalRunAt = Date.now()
      intervalTimer = setInterval(() => {
        const ms = opts.intervalMs()
        if (ms === null) return
        const now = Date.now()
        if (now - lastIntervalRunAt >= ms) {
          lastIntervalRunAt = now
          void invoke('interval')
        }
      }, TICK_MS)
    },
    stop() {
      pendingChange = false // 在途 run 的 finally 不再补跑，保证 stop 后彻底静默
      if (changeTimer !== undefined) {
        clearTimeout(changeTimer)
        changeTimer = undefined
      }
      if (intervalTimer !== undefined) {
        clearInterval(intervalTimer)
        intervalTimer = undefined
      }
    },
  }
}
