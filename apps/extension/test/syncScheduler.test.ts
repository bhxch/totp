/**
 * syncScheduler 单测（跨端同步 T1）：纯调度逻辑，网络依赖全部 mock 注入：
 * - 解锁边沿触发 syncNow（runPull 恰好一次）
 * - 锁定态 syncNow 与解锁钩子均不触发网络（安全承诺：锁定禁云请求）
 * - 自动跟随开关关闭：钩子与轮询均不动作
 * - interval 到点触发拉取，stop 后停止
 * - runPull 抛错走 onError，不中断调度
 */
import { describe, expect, it, vi } from 'vitest'
import { CloudHttpError } from '@totp/core'
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

  // ---- 跨端同步 T4：凭据失效分类（401/403 → 暂停轮询 + onAuthFailed 上抛）----

  it('T4 401 错误触发 onAuthFailed 且后续 interval 不再拉取（停轮询防风暴重试）', async () => {
    vi.useFakeTimers()
    const onAuthFailed = vi.fn()
    const { deps } = makeDeps({
      intervalMs: () => 1000,
      runPull: vi.fn().mockRejectedValue(new Error('WebDAV 请求失败（HTTP 401）')),
      onAuthFailed,
    })
    const s = createSyncScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(deps.runPull).toHaveBeenCalledOnce()
    expect(onAuthFailed).toHaveBeenCalledOnce()
    expect(s.authFailed()).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(deps.runPull).toHaveBeenCalledOnce() // interval 已停，不再增长
    s.stop()
    vi.useRealTimers()
  })

  it('T4 403 错误同样触发 onAuthFailed', async () => {
    const onAuthFailed = vi.fn()
    const { deps } = makeDeps({ runPull: vi.fn().mockRejectedValue(new Error('S3 请求失败（HTTP 403）')), onAuthFailed })
    const s = createSyncScheduler(deps)
    s.start()
    await s.syncNow()
    expect(onAuthFailed).toHaveBeenCalledOnce()
    expect(s.authFailed()).toBe(true)
  })

  it('T4 手动同步成功复位 authFailed（凭据恢复后可继续跟随）', async () => {
    let fail = true
    const { deps } = makeDeps({ runPull: vi.fn(() => (fail ? Promise.reject(new Error('WebDAV 请求失败（HTTP 401）')) : Promise.resolve(undefined))) })
    const s = createSyncScheduler(deps)
    s.start()
    await s.syncNow()
    expect(s.authFailed()).toBe(true)
    fail = false
    await s.syncNow()
    expect(s.authFailed()).toBe(false)
  })

  it('T4 start() 复位 authFailed（下次启动恢复轮询资格）', async () => {
    const { deps } = makeDeps({ runPull: vi.fn().mockRejectedValue(new Error('WebDAV 请求失败（HTTP 401）')) })
    const s = createSyncScheduler(deps)
    s.start()
    await s.syncNow()
    expect(s.authFailed()).toBe(true)
    s.stop()
    s.start()
    expect(s.authFailed()).toBe(false)
    s.stop()
  })

  it('T4 非认证错误不触发 onAuthFailed 且轮询不中断', async () => {
    vi.useFakeTimers()
    const onAuthFailed = vi.fn()
    const { deps } = makeDeps({ intervalMs: () => 1000, runPull: vi.fn().mockRejectedValue(new Error('网络超时')), onAuthFailed })
    const s = createSyncScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(deps.runPull).toHaveBeenCalledTimes(3) // 调度照常
    expect(onAuthFailed).not.toHaveBeenCalled()
    expect(s.authFailed()).toBe(false)
    s.stop()
    vi.useRealTimers()
  })

  it('T4 已置位期间重复 401 不重复通知 onAuthFailed（置位语义，复位后可再通知）', async () => {
    const onAuthFailed = vi.fn()
    const { deps } = makeDeps({ runPull: vi.fn().mockRejectedValue(new Error('WebDAV 请求失败（HTTP 401）')), onAuthFailed })
    const s = createSyncScheduler(deps)
    s.start()
    await s.syncNow()
    await s.syncNow()
    expect(onAuthFailed).toHaveBeenCalledOnce()
    s.stop()
    s.start()
    s.stop()
    s.start()
    await s.syncNow()
    expect(onAuthFailed).toHaveBeenCalledTimes(2) // start() 复位后再次通知
    s.stop()
  })

  // ---- 跨端同步审查 I1：手动同步成功恢复闭环（resume 复位 + 重启轮询）----

  it('I1 resume()：authFailed 暂停后 resume 复位标志并重启 interval 轮询（用户重新授权+手动同步成功闭环）', async () => {
    vi.useFakeTimers()
    let fail = true
    const onAuthFailed = vi.fn()
    const { deps } = makeDeps({
      intervalMs: () => 1000,
      runPull: vi.fn(() => (fail ? Promise.reject(new Error('WebDAV 请求失败（HTTP 401）')) : Promise.resolve(undefined))),
      onAuthFailed,
    })
    const s = createSyncScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.authFailed()).toBe(true)
    expect(onAuthFailed).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    expect(deps.runPull).toHaveBeenCalledOnce() // 暂停中不轮询（防风暴重试）
    fail = false
    s.resume() // 宿主经 CloudPlatform.onManualSynced 调用
    expect(s.authFailed()).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(deps.runPull).toHaveBeenCalledTimes(2) // 轮询已按原间隔重启
    s.stop()
    vi.useRealTimers()
  })

  it('I1 resume() 幂等：未置位时调用不产生双 interval（重建前先清旧 timer）', async () => {
    vi.useFakeTimers()
    const { deps } = makeDeps({ intervalMs: () => 1000 })
    const s = createSyncScheduler(deps)
    s.start()
    s.resume() // 未置位直接 resume
    await vi.advanceTimersByTimeAsync(3000)
    expect(deps.runPull).toHaveBeenCalledTimes(3) // 单一 interval，每秒恰好一次
    s.stop()
    vi.useRealTimers()
  })

  it('I1 resume() 不重复注册解锁钩子（与 start() 的差异）：resume 后解锁边沿仍只触发一次拉取', async () => {
    const { deps, fireUnlock } = makeDeps()
    const s = createSyncScheduler(deps)
    s.start()
    s.resume()
    fireUnlock()
    await vi.waitFor(() => expect(deps.runPull).toHaveBeenCalledOnce())
    s.stop()
  })

  // ---- 跨端同步审查 I2：凭据失效判定结构化 status 优先 + 消息定界兜底 ----

  it('I2 结构化 status 优先：错误对象携带 status=401 即判定（消息不含 401 也命中）；500 不误判', async () => {
    const structured401 = Object.assign(new Error('令牌已刷新，请重试'), { status: 401 })
    const onAuthFailed = vi.fn()
    const { deps } = makeDeps({ runPull: vi.fn().mockRejectedValue(structured401), onAuthFailed })
    const s = createSyncScheduler(deps)
    s.start()
    await s.syncNow()
    expect(onAuthFailed).toHaveBeenCalledOnce()
    expect(s.authFailed()).toBe(true)
    s.stop()

    const structured500 = Object.assign(new Error('服务器内部错误'), { status: 500 })
    const onAuthFailed2 = vi.fn()
    const { deps: deps2 } = makeDeps({ runPull: vi.fn().mockRejectedValue(structured500), onAuthFailed: onAuthFailed2 })
    const s2 = createSyncScheduler(deps2)
    s2.start()
    await s2.syncNow()
    expect(onAuthFailed2).not.toHaveBeenCalled()
    expect(s2.authFailed()).toBe(false)
    s2.stop()
  })

  it('I2 消息兜底收紧：仅「（HTTP 401）/（HTTP 403）」定界形式命中；裸数字文本（配额/统计文案含 403）不误判', async () => {
    // CloudHttpError 消息形态命中（GDrive 403 配额类与凭据失效 HTTP 层同码，同判为已知边界）
    const onAuthFailed = vi.fn()
    const { deps } = makeDeps({ runPull: vi.fn().mockRejectedValue(new CloudHttpError('Google Drive', 403)), onAuthFailed })
    const s = createSyncScheduler(deps)
    s.start()
    await s.syncNow()
    expect(s.authFailed()).toBe(true)
    s.stop()

    // 裸数字不再误判（旧 /401|403/ 会把「同步了 403 个条目」当凭据失效停轮询）
    const onAuthFailed2 = vi.fn()
    const { deps: deps2 } = makeDeps({ runPull: vi.fn().mockRejectedValue(new Error('同步了 403 个条目，含 401 个重复项')), onAuthFailed: onAuthFailed2 })
    const s2 = createSyncScheduler(deps2)
    s2.start()
    await s2.syncNow()
    expect(onAuthFailed2).not.toHaveBeenCalled()
    expect(s2.authFailed()).toBe(false)
    s2.stop()
  })
})
