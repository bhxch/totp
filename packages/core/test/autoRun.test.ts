import { afterEach, describe, expect, it, vi } from 'vitest'
import { decideAutoRun } from '../src/backup/autoRun'
import { createAutoRunScheduler } from '../src/backup/autoRunScheduler'

afterEach(() => {
  vi.useRealTimers()
})

describe('decideAutoRun', () => {
  const base = { currentHash: 'h2', lastHash: 'h1', locked: false, hasSecret: true }
  it('内容变化→run', () => expect(decideAutoRun(base)).toEqual({ action: 'run' }))
  it('内容未变→skip unchanged', () =>
    expect(decideAutoRun({ ...base, lastHash: 'h2' })).toEqual({ action: 'skip', cause: 'unchanged' }))
  it('无基线(首次)→run', () =>
    expect(decideAutoRun({ ...base, lastHash: null })).toEqual({ action: 'run' }))
  it('锁定→skip locked（优先于未变判断）', () =>
    expect(decideAutoRun({ ...base, lastHash: 'h2', locked: true })).toEqual({ action: 'skip', cause: 'locked' }))
  it('无会话口令→skip no-secret', () =>
    expect(decideAutoRun({ ...base, hasSecret: false })).toEqual({ action: 'skip', cause: 'no-secret' }))
})

describe('createAutoRunScheduler', () => {
  it('变更防抖合并：多次 notify 只在窗口后跑一次', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(undefined)
    const s = createAutoRunScheduler({ debounceMs: 10_000, intervalMs: () => null, run })
    s.notifyChanged(); s.notifyChanged(); s.notifyChanged()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('change')
  })
  it('防抖窗口内再次变更则重置计时', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(undefined)
    const s = createAutoRunScheduler({ debounceMs: 10_000, intervalMs: () => null, run })
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(5_000)
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('定时启用时按间隔触发 run(interval)，未启用不触发', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(undefined)
    let interval: number | null = 60_000
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => interval, run })
    s.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledWith('interval')
    expect(run.mock.calls.filter((c) => c[0] === 'interval').length).toBe(2)
    interval = null // 动态关闭
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run.mock.calls.filter((c) => c[0] === 'interval').length).toBe(2)
    s.stop()
  })
  it('stop 后变更不再触发', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(undefined)
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => null, run })
    s.notifyChanged(); s.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()
  })
  it('stop 清除 pendingChange：在途 run 完成后不再补跑', async () => {
    vi.useFakeTimers()
    let resolveRun!: () => void
    const run = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRun = r }))
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => null, run })
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1) // 在途
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(1_000) // 防抖到期被 running 挡下 → pendingChange 置位
    s.stop() // 此刻无 timer 可清，必须同时清 pendingChange
    resolveRun()
    await vi.advanceTimersByTimeAsync(31_000) // debounceMs + TICK_MS，足以暴露 stop 后补跑
    expect(run).toHaveBeenCalledTimes(1) // 不补跑
  })
  it('上一次 run 未结束时不重叠触发', async () => {
    vi.useFakeTimers()
    let resolveRun!: () => void
    const run = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRun = r }))
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => 1_000, run })
    s.start(); s.notifyChanged()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1)
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run).toHaveBeenCalledTimes(1) // 仍在执行，跳过
    resolveRun(); await vi.advanceTimersByTimeAsync(0)
  })
  it('run reject 后 onError 收到错误与 reason，后续 notifyChanged 仍能触发', async () => {
    vi.useFakeTimers()
    const err = new Error('boom')
    const onError = vi.fn()
    const run = vi.fn().mockRejectedValueOnce(err).mockResolvedValue(undefined)
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => null, run, onError })
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(err, 'change')
    s.notifyChanged() // running 已在 finally 复位，可正常再次调度
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('running 期间到期的 change 被延迟补跑一次', async () => {
    vi.useFakeTimers()
    let resolveRun!: () => void
    const run = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRun = r }))
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => null, run })
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1) // 第 1 次执行中（挂起）
    s.notifyChanged() // 防抖到期时将被 running 挡下 → 尾部合并
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
    s.notifyChanged() // running 期间又来一次变更（重挂防抖，验证 finally 重挂前清旧 timer）
    resolveRun()
    await vi.advanceTimersByTimeAsync(0) // finally：排期补跑
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2) // 仅补跑一次
  })
  it('intervalMs 从 null 恢复为值后下一 tick 触发', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(undefined)
    let interval: number | null = null
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => interval, run })
    s.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).not.toHaveBeenCalled()
    interval = 30_000
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('interval')
  })
})
