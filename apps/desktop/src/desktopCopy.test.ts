/**
 * desktopCopy 直测（P4，盘点 B9.31/32 装配层缺口）：复制编排——stage 成功武装 30s 清空
 * （开关关闭不武装）、stage 失败（第三方独占剪贴板）resolve false 且不武装清空。
 * fake timers 驱动 createClipboardClearer 30s 定时。R3-I1：成败反馈（toast）由调用方按
 * 返回值提示，本模块不再持有横幅状态。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopCopy } from '../src/desktopCopy'

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
  it('stage 成功 → resolve true + notifyCopied 武装清空：开关开启时 30s 后调 clipboard_clear_if_staged 通道', async () => {
    const { deps, clearIfStaged } = makeDeps({ enabled: true })
    const { copyToClipboard } = createDesktopCopy(deps)
    await expect(copyToClipboard('123456')).resolves.toBe(true)
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
  it('stage 拒绝 → resolve false、不武装清空（码未复制成功不得清走用户原剪贴板）', async () => {
    const { deps, clearIfStaged } = makeDeps({ stageOk: false, enabled: true })
    const { copyToClipboard } = createDesktopCopy(deps)
    await expect(copyToClipboard('123456')).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    expect(clearIfStaged).not.toHaveBeenCalled() // 码未复制成功，不得清空/隐藏
  })

  it('stage 失败不调用 onStaged 收尾（HOTP 递增/自动隐藏武装只在成功路径）', async () => {
    const { deps } = makeDeps({ stageOk: false })
    const { copyToClipboard } = createDesktopCopy(deps)
    const onStaged = vi.fn()
    await copyToClipboard('123456', { onStaged })
    expect(onStaged).not.toHaveBeenCalled()
  })

  it('成功路径 onStaged 在武装清空前调用（收尾完成才 notifyCopied）', async () => {
    const { deps, clearIfStaged } = makeDeps({ enabled: true })
    const { copyToClipboard } = createDesktopCopy(deps)
    const order: string[] = []
    await copyToClipboard('123456', { onStaged: () => { order.push('staged') } })
    await vi.advanceTimersByTimeAsync(CLEAR_DELAY_MS)
    expect(clearIfStaged).toHaveBeenCalledOnce() // 武装生效
    expect(order).toEqual(['staged'])
  })
})
