/** idle/锁屏自动锁定执行器（plan16 设计 §1 锁定策略·extension 端）：
 *  options 页存活期 30s 轮询 chrome.idle，按 lockPrefs 偏好执行锁定。
 *
 *  裁定（计划 Task 12）：chrome.idle 的 'idle' 态即宿主已按 setDetectionInterval
 *  判定无操作超时达成——直接等价「空闲 N 分钟」条件，无需自算 lastActivity。
 *  'locked' 态表示系统锁屏（screensaver/OS lock），对应 lockOnSystemLock 触发器。
 *
 *  注意：watcher 只调 deps.lock()（store.lock() 已同步清 dekPersist——T7 语义
 *  「锁=丢弃 DEK 含宿主会话存储」），不自清 chrome.storage.session。
 *  chrome API 异常经 onError 上报、不向上抛（轮询失败静默到下个 tick）。 */

const TICK_MS = 30_000
/** chrome.idle 硬下限 15s；上限取 24h（86_400s）防用户输入超大值 */
const MIN_DETECTION_S = 15
const MAX_DETECTION_S = 86_400
/** queryState 的探测粒度：只关心已达成 idle/locked 态，取 API 最小值 15 即可 */
const QUERY_S = 15

export interface IdleLockPrefs {
  /** 空闲锁定分钟数（0=禁用空闲触发器） */
  idleMinutes: number
  /** 系统锁屏时锁定 */
  lockOnSystemLock: boolean
}

export function createIdleLockWatcher(deps: {
  /** 每 tick 现读偏好；null=加密未启用 → 本 tick 不动作（锁定策略仅对加密库有意义） */
  getPrefs(): Promise<IdleLockPrefs | null>
  lock(): void
  onError?(e: unknown): void
}): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | null = null
  /** 上次成功下发的 detectionInterval：仅在值变化时调 setDetectionInterval，避免每 30s 重设 */
  let lastDetectionInterval: number | null = null

  function clampDetection(seconds: number): number {
    return Math.min(MAX_DETECTION_S, Math.max(MIN_DETECTION_S, seconds))
  }

  async function tick(): Promise<void> {
    try {
      const prefs = await deps.getPrefs()
      if (!prefs) return
      if (prefs.idleMinutes >= 1) {
        const seconds = clampDetection(prefs.idleMinutes * 60)
        if (seconds !== lastDetectionInterval) {
          chrome.idle.setDetectionInterval(seconds)
          lastDetectionInterval = seconds // 成功下发才更新缓存（抛错则下 tick 重试）
        }
      }
      chrome.idle.queryState(QUERY_S, (s) => {
        if (s === 'locked' && prefs.lockOnSystemLock) deps.lock()
        else if (s === 'idle' && prefs.idleMinutes >= 1) deps.lock()
      })
    } catch (e) {
      deps.onError?.(e)
    }
  }

  return {
    start() {
      if (timer !== null) return // 幂等：重复 start 不叠定时器
      timer = setInterval(() => {
        void tick()
      }, TICK_MS)
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
