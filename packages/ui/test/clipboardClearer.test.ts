import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClipboardClearer } from '../src/clipboardClearer'

const CLEAR_DELAY_MS = 30_000

describe('createClipboardClearer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('启用时 notifyCopied 后 30s 调用 clear', () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const clearer = createClipboardClearer(() => true, clear)
    clearer.notifyCopied()
    expect(clear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CLEAR_DELAY_MS - 1)
    expect(clear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(clear).toHaveBeenCalledTimes(1)
    clearer.dispose()
  })

  it('禁用时不调用 clear', () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const clearer = createClipboardClearer(() => false, clear)
    clearer.notifyCopied()
    vi.advanceTimersByTime(CLEAR_DELAY_MS * 2)
    expect(clear).not.toHaveBeenCalled()
    clearer.dispose()
  })

  it('重复复制重置计时（最近一次复制起 30s 才清空）', () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const clearer = createClipboardClearer(() => true, clear)
    clearer.notifyCopied()
    vi.advanceTimersByTime(CLEAR_DELAY_MS - 1000)
    clearer.notifyCopied() // 重置：旧的 29s 定时器应失效
    vi.advanceTimersByTime(CLEAR_DELAY_MS - 1000)
    expect(clear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(clear).toHaveBeenCalledTimes(1)
    clearer.dispose()
  })

  it('dispose 清除定时器，clear 不再被调用', () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const clearer = createClipboardClearer(() => true, clear)
    clearer.notifyCopied()
    clearer.dispose()
    vi.advanceTimersByTime(CLEAR_DELAY_MS * 2)
    expect(clear).not.toHaveBeenCalled()
  })
})
