/**
 * syncScheduler 单测（跨端同步 T1）：纯调度逻辑，网络依赖全部 mock 注入：
 * - 解锁边沿触发 syncNow（runPull 恰好一次）
 * - 锁定态 syncNow 与解锁钩子均不触发网络（安全承诺：锁定禁云请求）
 * - 自动跟随开关关闭：钩子与轮询均不动作
 * - interval 到点触发拉取，stop 后停止
 * - runPull 抛错走 onError，不中断调度
 */
import { describe, expect, it, vi } from 'vitest'
import { createSyncScheduler } from '../src/syncScheduler'

function makeDeps(overrides: Partial<Parameters<typeof createSyncScheduler>[0]> = {}) {
  const unlockCbs: Array<() => void> = []
  return {
    deps: {
      isUnlocked: vi.fn(() => true),
      onUnlocked: (cb: () => void) => { unlockCbs.push(cb); return () => {} },
      runPull: vi.fn().mockResolvedValue(undefined),
      autoFollowEnabled: vi.fn(() => true),
      intervalMs: () => null,
      onError: vi.fn(),
      ...overrides,
    },
    fireUnlock: () => unlockCbs.forEach((cb) => cb()),
  }
}

describe('syncScheduler', () => {
  it('解锁边沿触发 syncNow', async () => {
    const { deps, fireUnlock } = makeDeps()
    const s = createSyncScheduler(deps)
    s.start()
    fireUnlock()
    await vi.waitFor(() => expect(deps.runPull).toHaveBeenCalledOnce())
  })

  it('锁定态 syncNow 与解锁钩子均不触发网络', async () => {
    const { deps, fireUnlock } = makeDeps({ isUnlocked: vi.fn(() => false) })
    const s = createSyncScheduler(deps)
    s.start()
    await s.syncNow()
    fireUnlock()
    await new Promise((r) => setTimeout(r, 0))
    expect(deps.runPull).not.toHaveBeenCalled()
  })

  it('开关关闭：钩子与轮询均不动作', async () => {
    const { deps, fireUnlock } = makeDeps({ autoFollowEnabled: vi.fn(() => false) })
    const s = createSyncScheduler(deps)
    s.start()
    fireUnlock()
    await s.syncNow()
    expect(deps.runPull).not.toHaveBeenCalled()
  })

  it('interval 到点触发拉取，stop 后停止', async () => {
    vi.useFakeTimers()
    const { deps } = makeDeps({ intervalMs: () => 180_000 })
    const s = createSyncScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(deps.runPull).toHaveBeenCalledOnce()
    s.stop()
    await vi.advanceTimersByTimeAsync(360_000)
    expect(deps.runPull).toHaveBeenCalledOnce() // 不再增长
    vi.useRealTimers()
  })

  it('runPull 抛错走 onError 不中断调度', async () => {
    const { deps, fireUnlock } = makeDeps({ runPull: vi.fn().mockRejectedValue(new Error('boom')) })
    const s = createSyncScheduler(deps)
    s.start()
    fireUnlock()
    await vi.waitFor(() => expect(deps.onError).toHaveBeenCalled())
  })
})
