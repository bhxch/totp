/**
 * mini 复制后自动隐藏控制器（审查 I-1 武装竞态守卫）行为级单测。
 *
 * MiniApp.vue 挂载在 node 测试环境不可行（jsdom/@vue/test-utils 未装入 desktop；且 mini store
 * 按 spec §7 设计恒锁定、模板不渲染条目，copy 无法触达），故守卫逻辑抽为纯模块、以 fake timers
 * 直接固化「cancel 与 timer 武装」三种到达时序；组件接线仅 3 行（beginCopy/completeCopy/onDblclick），
 * 由 vue-tsc 模板检查覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCopyAutoHide } from './miniAutoHide'

afterEach(() => vi.useRealTimers())

function setup() {
  const hide = vi.fn()
  return { hide, ctl: createCopyAutoHide(500, hide) }
}

describe('mini 复制后自动隐藏（审查 I-1 武装竞态守卫）', () => {
  it('普通单击 copy：500ms 后隐藏恰好一次', () => {
    vi.useFakeTimers()
    const { hide, ctl } = setup()
    ctl.completeCopy(ctl.beginCopy())
    vi.advanceTimersByTime(499)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('双击在 timer 已武装后到达：清除 timer 不隐藏（cancel 后到的常规时序）', () => {
    vi.useFakeTimers()
    const { hide, ctl } = setup()
    ctl.completeCopy(ctl.beginCopy())
    ctl.onDblclick()
    vi.advanceTimersByTime(1000)
    expect(hide).not.toHaveBeenCalled()
  })

  it('双击先于 copy 的 await 落地到达：completeCopy 检出代次失配不武装（cancel 先于武装到达的竞态核心）', () => {
    vi.useFakeTimers()
    const { hide, ctl } = setup()
    const gen = ctl.beginCopy() // copy 开始，await IPC 挂起中（timer 尚未武装）
    ctl.onDblclick() // 双击揭示先到：旧实现在此取消落空（timer 为 null）
    ctl.completeCopy(gen) // await 落地：旧实现在此武装 → 500ms 后隐藏截断 8s 揭示
    vi.advanceTimersByTime(1000)
    expect(hide).not.toHaveBeenCalled()
  })

  it('双击序列 click→click→dblclick 的两次在途 copy 均不武装；揭示期间全新单击 copy 照常隐藏（无陈旧守卫误伤）', () => {
    vi.useFakeTimers()
    const { hide, ctl } = setup()
    const gen1 = ctl.beginCopy() // 第一次 click → copy1（await 挂起）
    const gen2 = ctl.beginCopy() // 第二次 click → copy2（await 挂起）
    ctl.onDblclick() // dblclick 派发：代次递增
    ctl.completeCopy(gen1) // 旧快照：跳过武装（一次性标志位方案在此会被 copy1 消费掉、copy2 漏过）
    ctl.completeCopy(gen2) // 同一旧快照：同样跳过武装
    vi.advanceTimersByTime(1000)
    expect(hide).not.toHaveBeenCalled()

    // 揭示期间的全新普通单击 copy：新快照 = 当前代次 → 照常武装并隐藏
    ctl.completeCopy(ctl.beginCopy())
    vi.advanceTimersByTime(500)
    expect(hide).toHaveBeenCalledTimes(1)
  })

  it('连续两次普通 copy：后写优先只保留一个 timer，500ms 只隐藏一次', () => {
    vi.useFakeTimers()
    const { hide, ctl } = setup()
    ctl.completeCopy(ctl.beginCopy())
    vi.advanceTimersByTime(300)
    ctl.completeCopy(ctl.beginCopy()) // 清前一个 timer 重新计 500ms
    vi.advanceTimersByTime(499)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledTimes(1)
  })
})
