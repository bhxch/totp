/**
 * lockEnforcer（idle/锁屏自动锁定执行器）单测（plan16 T12）：
 * chrome.idle 以假实现注入 globalThis.chrome + vitest fake timers，验证编排逻辑：
 * - 30s tick；idleMinutes>=1 时 setDetectionInterval(clamp(idleMinutes*60))，且仅值变化时调用一次
 * - queryState(clamp(idleMinutes*60))（勘误 审查C3：queryState 只认入参阈值，不认 setDetectionInterval）
 * - queryState 'locked'+lockOnSystemLock → lock；'idle'+idleMinutes>=1 → lock
 * - 'idle'+idleMinutes=0 / 'active' / prefs null → 不 lock
 * - chrome API 抛错经 onError 上报不向上抛；stop 后不再 tick
 * （真实 chrome.idle 行为需浏览器，此处验证轮询判定编排）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIdleLockWatcher, type IdleLockPrefs } from '../src/lockEnforcer'

type IdleState = 'active' | 'idle' | 'locked'

function installChromeIdle(overrides: { setDetectionInterval?: () => void; queryState?: (cb: (s: IdleState) => void) => void } = {}) {
  const calls = { setDetectionInterval: [] as number[], queryState: [] as number[] }
  const idle = {
    setDetectionInterval(seconds: number): void {
      calls.setDetectionInterval.push(seconds)
      overrides.setDetectionInterval?.()
    },
    queryState(_detectionIntervalInSeconds: number, cb: (s: `${IdleState}`) => void): void {
      calls.queryState.push(_detectionIntervalInSeconds)
      // 默认 active；用例经 overrides 注入目标态（同步回调，与真实 API 的 callback 形状一致）
      if (overrides.queryState) overrides.queryState(cb)
      else cb('active')
    },
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = { idle }
  return { calls, idle }
}

beforeEach(() => {
  vi.useFakeTimers()
  delete (globalThis as unknown as { chrome?: unknown }).chrome
})
afterEach(() => {
  vi.useRealTimers()
})

/** 组装 watcher：prefs/lock 由测试闭包控制，返回各探针 */
function setup(initialPrefs: IdleLockPrefs | null) {
  const calls = { getPrefs: 0, lock: 0, onError: [] as unknown[] }
  let prefs = initialPrefs
  const watcher = createIdleLockWatcher({
    getPrefs: async () => {
      calls.getPrefs++
      return prefs
    },
    lock: () => {
      calls.lock++
    },
    onError: (e) => {
      calls.onError.push(e)
    },
  })
  return {
    watcher,
    calls,
    setPrefs(p: IdleLockPrefs | null) {
      prefs = p
    },
    /** 前进 n 个 tick 并 flush 异步 tick 体 */
    async tick(n = 1): Promise<void> {
      for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(30_000)
    },
  }
}

describe('setDetectionInterval 调度', () => {
  it('idleMinutes=5 → 首个 tick 下发 300，后续 tick 值未变不再重设', async () => {
    const chrome = installChromeIdle()
    const t = setup({ idleMinutes: 5, lockOnSystemLock: true })
    t.watcher.start()
    await t.tick(2)
    expect(chrome.calls.setDetectionInterval).toEqual([300]) // 恰好一次
  })

  it('值变化时重设：5 分钟 → 10 分钟，第二 tick 下发 600', async () => {
    const chrome = installChromeIdle()
    const t = setup({ idleMinutes: 5, lockOnSystemLock: true })
    t.watcher.start()
    await t.tick(1)
    t.setPrefs({ idleMinutes: 10, lockOnSystemLock: true })
    await t.tick(1)
    expect(chrome.calls.setDetectionInterval).toEqual([300, 600])
  })

  it('超大值钳制到 14400（Chromium 4h 上限）；idleMinutes=0（禁用）不调 setDetectionInterval', async () => {
    const chrome = installChromeIdle()
    const t = setup({ idleMinutes: 999_999, lockOnSystemLock: false })
    t.watcher.start()
    await t.tick(1)
    expect(chrome.calls.setDetectionInterval).toEqual([14_400])
    t.setPrefs({ idleMinutes: 0, lockOnSystemLock: true })
    await t.tick(1)
    expect(chrome.calls.setDetectionInterval).toEqual([14_400]) // 未追加
  })

  it('queryState 收到钳制后的用户阈值：5 分钟 → 300（审查 C3 勘误），0 分钟 → 15（探测系统锁屏用下限）', async () => {
    const chrome = installChromeIdle()
    const t = setup({ idleMinutes: 5, lockOnSystemLock: false })
    t.watcher.start()
    await t.tick(2)
    expect(chrome.calls.queryState).toEqual([300, 300])
    t.setPrefs({ idleMinutes: 0, lockOnSystemLock: true })
    await t.tick(1)
    expect(chrome.calls.queryState).toEqual([300, 300, 15])
  })
})

describe('锁定判定', () => {
  it("'locked' + lockOnSystemLock → lock（空闲分钟无关，0 也锁）", async () => {
    installChromeIdle({ queryState: (cb) => cb('locked') })
    const t = setup({ idleMinutes: 0, lockOnSystemLock: true })
    t.watcher.start()
    await t.tick(1)
    expect(t.calls.lock).toBe(1)
  })

  it("'locked' + lockOnSystemLock=false → 不 lock", async () => {
    installChromeIdle({ queryState: (cb) => cb('locked') })
    const t = setup({ idleMinutes: 5, lockOnSystemLock: false })
    t.watcher.start()
    await t.tick(1)
    expect(t.calls.lock).toBe(0)
  })

  it("'idle' + idleMinutes>=1 → lock（idle 态即宿主判定超时达成）", async () => {
    installChromeIdle({ queryState: (cb) => cb('idle') })
    const t = setup({ idleMinutes: 5, lockOnSystemLock: false })
    t.watcher.start()
    await t.tick(1)
    expect(t.calls.lock).toBe(1)
  })

  it("'idle' + idleMinutes=0 → 不 lock（空闲触发器已禁用）", async () => {
    installChromeIdle({ queryState: (cb) => cb('idle') })
    const t = setup({ idleMinutes: 0, lockOnSystemLock: false })
    t.watcher.start()
    await t.tick(1)
    expect(t.calls.lock).toBe(0)
  })

  it("'active' → 不 lock", async () => {
    installChromeIdle({ queryState: (cb) => cb('active') })
    const t = setup({ idleMinutes: 5, lockOnSystemLock: true })
    t.watcher.start()
    await t.tick(1)
    expect(t.calls.lock).toBe(0)
  })

  it('prefs null（加密未启用）→ 本 tick 完全不动作', async () => {
    const chrome = installChromeIdle()
    const t = setup(null)
    t.watcher.start()
    await t.tick(1)
    expect(chrome.calls.setDetectionInterval).toEqual([])
    expect(chrome.calls.queryState).toEqual([])
    expect(t.calls.lock).toBe(0)
  })

  it('锁定后下一 tick 重判（每次 tick 独立判定，恢复解锁且仍空闲会再锁）', async () => {
    installChromeIdle({ queryState: (cb) => cb('idle') })
    const t = setup({ idleMinutes: 5, lockOnSystemLock: true })
    t.watcher.start()
    await t.tick(2)
    expect(t.calls.lock).toBe(2)
  })
})

describe('容错与生命周期', () => {
  it('setDetectionInterval 抛错 → onError 上报、本 tick 中止（queryState 不执行）、不向上抛；下 tick 重试', async () => {
    let fail = true
    const chrome = installChromeIdle({
      setDetectionInterval: () => {
        if (fail) throw new Error('idle API unavailable')
      },
    })
    const t = setup({ idleMinutes: 5, lockOnSystemLock: true })
    t.watcher.start()
    await t.tick(1)
    expect(t.calls.onError).toHaveLength(1)
    expect(chrome.calls.queryState).toEqual([]) // 本 tick 中止
    fail = false
    await t.tick(1)
    expect(chrome.calls.setDetectionInterval).toEqual([300, 300]) // 抛错未更新缓存 → 下 tick 重试成功
    expect(chrome.calls.queryState).toEqual([300])
    expect(t.calls.onError).toHaveLength(1)
  })

  it('queryState 抛错 → onError 上报不向上抛', async () => {
    installChromeIdle({
      queryState: () => {
        throw new Error('queryState failed')
      },
    })
    const t = setup({ idleMinutes: 5, lockOnSystemLock: true })
    t.watcher.start()
    await t.tick(1)
    expect(t.calls.onError).toHaveLength(1)
    expect(t.calls.lock).toBe(0)
  })

  it('getPrefs 抛错 → onError 上报不向上抛', async () => {
    installChromeIdle()
    const t = setup({ idleMinutes: 5, lockOnSystemLock: true })
    const failing = createIdleLockWatcher({
      getPrefs: async () => {
        throw new Error('settings read failed')
      },
      lock: () => {},
      onError: (e) => t.calls.onError.push(e),
    })
    failing.start()
    await t.tick(1)
    expect(t.calls.onError).toHaveLength(1)
  })

  it('stop 后不再 tick；重复 start 不叠定时器', async () => {
    const chrome = installChromeIdle({ queryState: (cb) => cb('idle') })
    const t = setup({ idleMinutes: 5, lockOnSystemLock: true })
    t.watcher.start()
    t.watcher.start() // 幂等
    await t.tick(1)
    expect(t.calls.lock).toBe(1)
    t.watcher.stop()
    await t.tick(3)
    expect(t.calls.lock).toBe(1) // stop 后无新 tick
    expect(chrome.calls.queryState).toEqual([300])
  })

  it('chrome.idle 不存在（宿主无 idle 权限）→ start 上报一次错误且不启定时器（N1 降级）', async () => {
    const t = setup({ idleMinutes: 5, lockOnSystemLock: true })
    t.watcher.start()
    await t.tick(2)
    expect(t.calls.onError).toHaveLength(1)
    expect(t.calls.lock).toBe(0)
  })
})
