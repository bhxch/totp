export type AutoRunReason = 'change' | 'interval'

export interface SchedulerOptions {
  debounceMs: number
  /** 当前定时间隔毫秒；null=未启用。每次 tick 重新求值（支持运行中改配置） */
  intervalMs: () => number | null
  run: (reason: AutoRunReason) => Promise<void>
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
  let lastIntervalRunAt = 0
  const TICK_MS = 30_000

  async function invoke(reason: AutoRunReason): Promise<void> {
    if (running) return
    running = true
    try {
      await opts.run(reason)
    } finally {
      running = false
    }
  }

  return {
    notifyChanged() {
      if (changeTimer !== undefined) clearTimeout(changeTimer)
      changeTimer = setTimeout(() => {
        changeTimer = undefined
        void invoke('change')
      }, opts.debounceMs)
    },
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
