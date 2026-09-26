/**
 * desktopCopy 直测（P4，盘点 B9.31/32 装配层缺口）：复制编排——stage 成功武装 30s 清空
 * （开关关闭不武装）、stage 失败（第三方独占剪贴板）横幅 3s 自动复位且不武装清空、
 * 重复失败重置计时。fake timers 驱动 createClipboardClearer 30s 定时。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COPY_FAILED_BANNER_MS, createDesktopCopy } from '../src/desktopCopy'

const CLEAR_DELAY_MS = 30_000

function makeDeps(overrides: { enabled?: boolean; stageOk?: boolean } = {}) {
  const clearIfStaged = vi.fn(async () => {})
  const stage = overrides.stageOk === false
    ? vi.fn(async () => { throw new Error('clipboard busy') })
    : vi.fn(async () => {})
  const deps = {
    isEnabled: () => overrides.enabled ?? true,
    stage,
    clearIfStaged,
  }
  return { deps, stage, clearIfStaged }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('复制成功路径', () => {
  it('stage 成功 → notifyCopied 武装清空：开关开启时 30s 后调 clipboard_clear_if_staged 通道', async () => {
    const { deps, clearIfStaged } = makeDeps({ enabled: true })
    const { copyToClipboard } = createDesktopCopy(deps)
    await copyToClipboard('123456')
    expect(deps.stage).toHaveBeenCalledWith('123456')
    expect(clearIfStaged).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    expect(clearIfStaged).toHaveBeenCalledOnce()
  })

  it('开关关闭（store 未就绪读不到=关闭）→ 30s 后不清空', async () => {
    const { deps, clearIfStaged } = makeDeps({ enabled: false })
    const { copyToClipboard } = createDesktopCopy(deps)
    await copyToClipboard('123456')
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    expect(clearIfStaged).not.toHaveBeenCalled()
  })

  it('重复复制重置 30s 计时（首次到期不清洁，第二次到期才清）', async () => {
    const { deps, clearIfStaged } = makeDeps({ enabled: true })
    const { copyToClipboard } = createDesktopCopy(deps)
    await copyToClipboard('111111')
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS - 1000)
    await copyToClipboard('222222')
    await vi.advanceTimersByTimeAsync(1000)
    expect(clearIfStaged).not.toHaveBeenCalled() // 第一次计时已被重置
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS - 1000)
    expect(clearIfStaged).toHaveBeenCalledOnce()
  })
})

describe('复制失败路径（剪贴板被第三方进程独占）', () => {
  it('stage 拒绝 → copyFailed 横幅置真、不武装清空；3s 后自动复位', async () => {
    const { deps, clearIfStaged } = makeDeps({ stageOk: false, enabled: true })
    const { copyFailed, copyToClipboard } = createDesktopCopy(deps)
    await copyToClipboard('123456')
    expect(copyFailed.value).toBe(true)
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    expect(clearIfStaged).not.toHaveBeenCalled() // 码未复制成功，不得清空/隐藏
    await vi.advanceTimersByTimeAsync(COPY_FAILED_BANNER_MS)
    expect(copyFailed.value).toBe(false)
  })

  it('重复失败重置 3s 计时（横幅不闪断）', async () => {
    const { deps } = makeDeps({ stageOk: false })
    const { copyFailed, copyToClipboard } = createDesktopCopy(deps)
    await copyToClipboard('1')
    await vi.advanceTimersByTimeAsync(COPY_FAILED_BANNER_MS - 500)
    await copyToClipboard('2') // 2.5s 处再次失败 → 计时重置
    await vi.advanceTimersByTimeAsync(500)
    expect(copyFailed.value).toBe(true) // 距首次失败已 3s，但计时被重置仍显示
    await vi.advanceTimersByTimeAsync(COPY_FAILED_BANNER_MS)
    expect(copyFailed.value).toBe(false)
  })
})
