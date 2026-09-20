import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClipboardClearer } from '../src/clipboardClearer'

const CLEAR_DELAY_MS = 30_000

describe('createClipboardClearer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('启用时 notifyCopied 后 30s 调用 clear', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const clearer = createClipboardClearer(() => true, clear)
    clearer.notifyCopied()
    expect(clear).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS - 1)
    expect(clear).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(clear).toHaveBeenCalledTimes(1)
    clearer.dispose()
  })

  it('禁用时不调用 clear', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const clearer = createClipboardClearer(() => false, clear)
    clearer.notifyCopied()
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS * 2)
    expect(clear).not.toHaveBeenCalled()
    clearer.dispose() // 无清除义务：dispose 也不补清
    expect(clear).not.toHaveBeenCalled()
  })

  it('重复复制重置计时（最近一次复制起 30s 才清空）', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const clearer = createClipboardClearer(() => true, clear)
    clearer.notifyCopied()
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS - 1000)
    clearer.notifyCopied() // 重置：旧的 29s 定时器应失效
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS - 1000)
    expect(clear).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(clear).toHaveBeenCalledTimes(1)
    clearer.dispose()
  })

  it('F16 dispose：欠清除时尽力补清一次', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const clearer = createClipboardClearer(() => true, clear)
    clearer.notifyCopied()
    clearer.dispose()
    expect(clear).toHaveBeenCalledTimes(1) // 补清（原实现此处取消定时器不清除）
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    expect(clear).toHaveBeenCalledTimes(1) // 义务已解除，不再重复
  })

  it('F16 清除失败重试 2 次后 warn 恰一次（固定字面量，不含内容）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clear = vi.fn().mockRejectedValue(new Error('boom'))
    const clearer = createClipboardClearer(() => true, clear)
    clearer.notifyCopied()
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    await vi.advanceTimersByTimeAsync(250) // 重试 1
    await vi.advanceTimersByTimeAsync(250) // 重试 2
    expect(clear).toHaveBeenCalledTimes(3) // 首试 + 2 次重试
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe('[clipboardClearer] 自动清除剪贴板失败（含重试）')
    warn.mockRestore()
    clearer.dispose() // owed 保持 true（清除未成功）：dispose 再尽力一次，义务未解除不重复 warn 计数干扰
  })

  it('F16 重试成功不 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clear = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const clearer = createClipboardClearer(() => true, clear)
    clearer.notifyCopied()
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    await vi.advanceTimersByTimeAsync(250)
    expect(clear).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
    clearer.dispose()
    expect(clear).toHaveBeenCalledTimes(2) // 义务已解除：dispose 不补清
    warn.mockRestore()
  })

  it('F16 generation：旧重试链作废，不清新复制内容', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let rejectFirst: ((e: unknown) => void) | null = null
    const clear = vi.fn().mockImplementation(() => new Promise<void>((resolve, reject) => {
      if (clear.mock.calls.length === 1) rejectFirst = reject
      else resolve()
    }))
    const clearer = createClipboardClearer(() => true, clear)
    clearer.notifyCopied() // 复制 A：30s 定时
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    // clear 第 1 次调用 rejected 挂起中（A 的重试链待触发重试 1）
    clearer.notifyCopied() // 复制 B：generation 前进，A 的链作废
    rejectFirst!(new Error('stale'))
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    // 只有 B 的清除成功；A 的失败被作废不 warn、不重试
    expect(clear).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
    clearer.dispose()
    expect(clear).toHaveBeenCalledTimes(2) // B 已清除（义务解除）：dispose 不再清
    warn.mockRestore()
  })
})
