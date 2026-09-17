// 空闲锁定执行器（plan16 T15 / 设计 §1 锁定策略「空闲超时 N 分钟」desktop 端原生实现）。
// 与 extension lockEnforcer（chrome.idle 版，plan16 T12）语义对齐：tick 命中且解锁态才 lock。
// 差异：chrome.idle 由宿主浏览器判定空闲，desktop 无该 API——改由宿主 document 级
// pointerdown/keydown 刷新活动时间戳 + 30s tick 用 core shouldLockNow 判定（本模块为纯逻辑，
// DOM 监听在 App.vue 接线）。lockIdleMinutes < 1（含默认 0=禁用）由 core shouldLockNow 判 false。
import { shouldLockNow } from '@totp/core'

/** tick 粒度：与自动备份调度器同口径（最长 30s 的锁定延迟） */
export const IDLE_TICK_MS = 30_000

/** 活动时间戳更新节流：高频 pointerdown/keydown 下避免无谓写入（节流窗内的活动按首次时间计） */
export const ACTIVITY_THROTTLE_MS = 1_000

export interface IdleLockDeps {
  /** 每 tick 现读 settings.lockIdleMinutes（0=禁用；不缓存快照，开关变更即时生效） */
  getIdleMinutes(): number
  /** 仅解锁态执行锁定；store 未就绪时宿主兜底 true（与 autoRunner 同口径）恒不动作 */
  isLocked(): boolean
  lock(): void
  /** 时钟注入：单测固定时间，无需真等待 */
  now(): number
}

export function createIdleLockExecutor(deps: IdleLockDeps): {
  notifyActivity(): void
  tick(): void
  start(): void
  stop(): void
} {
  // 创建时刻（页面加载）视为最近活动；lastNotifiedAt 初值允许首次 notify 直接生效
  let lastActivityAt = deps.now()
  let lastNotifiedAt = deps.now() - ACTIVITY_THROTTLE_MS
  let timer: ReturnType<typeof setInterval> | null = null

  function tick(): void {
    if (deps.isLocked()) return
    if (shouldLockNow({ idleMinutes: deps.getIdleMinutes(), lastActivityAt, now: deps.now() })) {
      deps.lock()
    }
  }

  return {
    /** document 级 pointerdown/keydown 回调：节流刷新活动时间戳 */
    notifyActivity() {
      const t = deps.now()
      if (t - lastNotifiedAt < ACTIVITY_THROTTLE_MS) return
      lastNotifiedAt = t
      lastActivityAt = t
    },
    /** 单 tick 判定（start 的 interval 即调此函数；独立暴露供测试） */
    tick,
    /** 幂等启动 30s tick；重复 start 不叠定时器（与 extension watcher 同约定） */
    start() {
      if (timer !== null) return
      timer = setInterval(tick, IDLE_TICK_MS)
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}
