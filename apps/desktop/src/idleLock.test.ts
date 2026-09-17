import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITY_THROTTLE_MS, IDLE_TICK_MS, createIdleLockExecutor } from './idleLock'

const MIN = 60_000

/** 测试骨架：时钟/偏好/锁定态全部可控，lock 记录命中时刻 */
function harness() {
  const state = { t: 1_000_000, idle: 0, locked: true }
  const locks: number[] = []
  const ex = createIdleLockExecutor({
    getIdleMinutes: () => state.idle,
    isLocked: () => state.locked,
    lock: () => {
      state.locked = true
      locks.push(state.t)
    },
    now: () => state.t,
  })
  return { ex, state, locks }
}

describe('空闲锁定执行器（plan16 T15 desktop 原生实现，语义对齐 extension lockEnforcer）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('lockIdleMinutes=0（默认禁用）恒不锁定', () => {
    const { ex, state, locks } = harness()
    state.idle = 0
    state.locked = false
    state.t += 30 * MIN
    ex.tick()
    expect(locks).toEqual([])
  })

  it('空闲未达阈值不锁；达阈值（now-lastActivityAt ≥ N 分钟）锁定', () => {
    const { ex, state, locks } = harness()
    state.idle = 5
    state.locked = false
    state.t += 5 * MIN - 1
    ex.tick()
    expect(locks).toEqual([])
    state.t += 1
    ex.tick()
    expect(locks).toEqual([1_000_000 + 5 * MIN])
    expect(state.locked).toBe(true)
  })

  it('锁定态（含 store 未就绪兜底）不重复调 lock', () => {
    const { ex, state, locks } = harness()
    state.idle = 5
    state.locked = true // 已锁定 / store 未就绪
    state.t += 10 * MIN
    ex.tick()
    expect(locks).toEqual([])
  })

  it('非整数/负数 idleMinutes 由 core 判定禁用（宿主不重复校验）', () => {
    const { ex, state, locks } = harness()
    state.locked = false
    for (const bad of [-1, 2.5]) {
      state.idle = bad
      state.t += 10 * MIN
      ex.tick()
      expect(locks).toEqual([])
    }
  })

  it('notifyActivity 刷新活动时间戳：活动后重新计空闲', () => {
    const { ex, state, locks } = harness()
    state.idle = 5
    state.locked = false
    state.t += 4 * MIN
    ex.notifyActivity() // 活动时刻 = 1_240_000，lastActivityAt 据此重置
    state.t += 4 * MIN // 距活动仅 4 分钟
    ex.tick()
    expect(locks).toEqual([])
    state.t += MIN // 距活动满 5 分钟
    ex.tick()
    expect(locks).toEqual([1_000_000 + 4 * MIN + 4 * MIN + MIN])
  })

  it(`notifyActivity 节流：${ACTIVITY_THROTTLE_MS}ms 窗口内的后续活动按首次时间计`, () => {
    const { ex, state, locks } = harness()
    state.idle = 5
    state.locked = false
    state.t += 2_000
    ex.notifyActivity() // 首次活动生效：lastActivityAt = 1_002_000
    state.t += 500
    ex.notifyActivity() // 落在节流窗内：不得刷新（否则 lastActivityAt = 1_002_500）
    // 推进到距首次活动恰好 5 分钟（距第二次活动仅 4:59.5）：命中锁定 ⇔ 第二次活动确实被节流
    state.t += 5 * MIN - 500
    ex.tick()
    expect(locks).toEqual([1_000_000 + 2_000 + 500 + 5 * MIN - 500])
  })

  it('start 按粒度驱动 tick 并锁定；stop 后不再 tick；start 幂等不叠定时器', () => {
    const { ex, state, locks } = harness()
    vi.useFakeTimers()
    const wall = (): number => Date.now() // vitest 假时钟同时伪造 Date.now
    const exTimed = createIdleLockExecutor({
      getIdleMinutes: () => 5,
      isLocked: () => state.locked,
      lock: () => {
        state.locked = true
        locks.push(wall())
      },
      now: wall,
    })
    state.locked = false
    exTimed.start()
    exTimed.start() // 幂等：不叠定时器
    // 9 次 tick（4.5 分钟）空闲未达阈值：不锁
    vi.advanceTimersByTime(IDLE_TICK_MS * 9)
    expect(locks).toEqual([])
    // 第 10 次 tick（5.0 分钟）：达阈值锁定
    vi.advanceTimersByTime(IDLE_TICK_MS)
    expect(locks.length).toBe(1)
    expect(state.locked).toBe(true)
    exTimed.stop()
    state.locked = false
    vi.advanceTimersByTime(10 * IDLE_TICK_MS)
    expect(locks.length).toBe(1) // stop 后无新命中
  })

  it('创建即视为活动起点：创建后满 N 分钟才首次命中', () => {
    const { ex, state, locks } = harness()
    state.idle = 1
    state.locked = false
    state.t += MIN - 1
    ex.tick()
    expect(locks).toEqual([])
    state.t += 1
    ex.tick()
    expect(locks.length).toBe(1)
  })
})
