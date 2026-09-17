/** idle/锁屏自动锁定执行器（plan16 设计 §1 锁定策略·extension 端）：
 *  options 页存活期 30s 轮询 chrome.idle，按 lockPrefs 偏好执行锁定。
 *
 *  勘误（审查 2026-09-18 C3，推翻计划 Task 12 原裁定）：setDetectionInterval 的
 *  阈值只作用于 onStateChanged 事件路径；queryState 只认本次调用的入参——故「空闲
 *  N 分钟」必须把钳制后的用户阈值直接传 queryState（原实现传常量 15 导致约 15s 即锁）。
 *  'locked' 态表示系统锁屏（screensaver/OS lock），对应 lockOnSystemLock 触发器。
 *
 *  注意：watcher 只调 deps.lock()（store.lock() 已同步清 dekPersist——T7 语义
 *  「锁=丢弃 DEK 含宿主会话存储」），不自清 chrome.storage.session。
 *  chrome API 异常经 onError 上报、不向上抛（轮询失败静默到下个 tick）。
 *  chrome.idle 不存在（如 Firefox 未获得 idle 权限）时 start() 上报一次并不启用。 */

const TICK_MS = 30_000
/** chrome.idle 硬下限 15s；上限 4h（Chromium 对超限阈值静默钳到 14400s） */
const MIN_DETECTION_S = 15
const MAX_DETECTION_S = 14_400

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
      const threshold = clampDetection(prefs.idleMinutes * 60)
      if (prefs.idleMinutes >= 1 && threshold !== lastDetectionInterval) {
        chrome.idle.setDetectionInterval(threshold)
        lastDetectionInterval = threshold // 成功下发才更新缓存（抛错则下 tick 重试）
      }
      chrome.idle.queryState(threshold, (s) => {
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
      // globalThis 取值而非裸 typeof：测试（node 环境）与无 chrome 宿主下不产生 ReferenceError，
      // 也避免打包器对 chrome 标识符的编译期替换掩盖运行时真实可用性（Firefox 无 idle 权限，N1）
      const idleApi = (globalThis as { chrome?: { idle?: { queryState?: unknown } } }).chrome?.idle
      if (!idleApi || typeof idleApi.queryState !== 'function') {
        deps.onError?.(new Error('chrome.idle 不可用（缺少 idle 权限或宿主不支持），空闲/锁屏自动锁定未启用'))
        return
      }
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
