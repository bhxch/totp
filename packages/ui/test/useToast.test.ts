import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useToast } from '../src/composables/useToast'

const DURATION_MS = 3_000

describe('useToast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    // 模块级单例状态：逐条 dismiss 复位，避免测试间泄漏
    // （fake timers 换回 real 后遗留项的在途计时被丢弃，永不自动过期）
    const { toasts, dismiss } = useToast()
    for (const t of [...toasts.value]) dismiss(t.key)
    vi.useRealTimers()
  })

  it('show 入队（默认 success），3s 后自动过期', async () => {
    const { show, toasts } = useToast()
    show('已复制')
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]).toMatchObject({ message: '已复制', kind: 'success' })
    await vi.advanceTimersByTimeAsync(DURATION_MS - 1)
    expect(toasts.value).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(toasts.value).toHaveLength(0)
  })

  it("show(…, 'error') 入队 error 态", () => {
    const { show, toasts } = useToast()
    show('复制失败', 'error')
    expect(toasts.value[0]).toMatchObject({ message: '复制失败', kind: 'error' })
  })

  it('不同 message 排队追加（多条并存，按序）', () => {
    const { show, toasts } = useToast()
    show('A')
    show('B')
    expect(toasts.value.map((t) => t.message)).toEqual(['A', 'B'])
  })

  it('同 message 替换：key 复用、不新增条目、计时刷新', async () => {
    const { show, toasts } = useToast()
    show('A')
    const first = toasts.value[0]
    await vi.advanceTimersByTimeAsync(DURATION_MS - 1_000) // 已过 2s
    show('A', 'error') // 替换（kind 一并更新）
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]?.key).toBe(first?.key) // key 复用
    expect(toasts.value[0]?.kind).toBe('error')
    await vi.advanceTimersByTimeAsync(DURATION_MS - 1_000) // 替换后 2s：若未刷新计时此处已过期
    expect(toasts.value).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000) // 替换起算满 3s → 过期
    expect(toasts.value).toHaveLength(0)
  })

  it('同屏最多 3 条：第 4 条挤掉最旧', () => {
    const { show, toasts } = useToast()
    show('A')
    show('B')
    show('C')
    show('D')
    expect(toasts.value.map((t) => t.message)).toEqual(['B', 'C', 'D'])
  })

  it('满屏时同 message 替换刷新：不移除其他条目且不超限', async () => {
    const { show, toasts } = useToast()
    show('A')
    show('B')
    show('C')
    await vi.advanceTimersByTimeAsync(DURATION_MS - 1_000)
    show('B', 'error') // 满屏下替换既有项
    expect(toasts.value.map((t) => t.message)).toEqual(['A', 'B', 'C'])
    await vi.advanceTimersByTimeAsync(DURATION_MS - 1_000) // t=4s：A/C 的 3s 计时（t=3s）已过期，B 计时被刷新仍存活
    expect(toasts.value.map((t) => t.message)).toEqual(['B'])
    await vi.advanceTimersByTimeAsync(1_000) // t=5s：B 自替换起算满 3s → 过期
    expect(toasts.value).toHaveLength(0)
  })

  it('dismiss 立即移除且清除计时', async () => {
    const { show, toasts, dismiss } = useToast()
    show('X')
    const key = toasts.value[0]?.key
    expect(key).toBeDefined()
    dismiss(key!)
    expect(toasts.value).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(DURATION_MS) // 计时已清：推进无副作用
    expect(toasts.value).toHaveLength(0)
  })

  it('dismiss 未知 key 不抛错', () => {
    const { dismiss, toasts } = useToast()
    expect(() => dismiss(99_999)).not.toThrow()
    expect(toasts.value).toHaveLength(0)
  })

  it('模块级单例：多调用方共享同一 toasts', () => {
    const a = useToast()
    const b = useToast()
    a.show('共享')
    expect(b.toasts.value.map((t) => t.message)).toContain('共享')
    const key = b.toasts.value[0]?.key
    b.dismiss(key!)
    expect(a.toasts.value).toHaveLength(0)
  })
})
