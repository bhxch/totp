import { afterEach, describe, expect, it, vi } from 'vitest'
import { setConflictBadge } from '../src/conflictBadge'

/** spec §4 extension action badge：冲突>0 →「!」，=0 → 清空；无 chrome.action 环境守卫不抛 */

afterEach(() => {
  vi.unstubAllGlobals()
  // @ts-expect-error 测试清理：jsdom 无 chrome，动态挂载的 stub 需手动摘除
  if (typeof globalThis.chrome !== 'undefined') delete globalThis.chrome
})

describe('setConflictBadge', () => {
  it('无 chrome 环境（jsdom/测试）：静默跳过不抛', () => {
    expect(() => setConflictBadge(3)).not.toThrow()
  })

  it('count>0 → setBadgeText({ text: "!" })', () => {
    const setBadgeText = vi.fn()
    vi.stubGlobal('chrome', { action: { setBadgeText } })
    setConflictBadge(2)
    expect(setBadgeText).toHaveBeenCalledWith({ text: '!' })
  })

  it('count=0 → 清空 badge（空串）', () => {
    const setBadgeText = vi.fn()
    vi.stubGlobal('chrome', { action: { setBadgeText } })
    setConflictBadge(0)
    expect(setBadgeText).toHaveBeenCalledWith({ text: '' })
  })

  it('缺 chrome.action（旧内核/无 action 权限）：守卫跳过不抛', () => {
    vi.stubGlobal('chrome', { storage: {} })
    expect(() => setConflictBadge(1)).not.toThrow()
  })

  it('setBadgeText 拒绝（上下文失效等）：吞错不外溢（badge 非关键路径）', () => {
    vi.stubGlobal('chrome', { action: { setBadgeText: () => Promise.reject(new Error('context invalidated')) } })
    expect(() => setConflictBadge(1)).not.toThrow()
  })
})
