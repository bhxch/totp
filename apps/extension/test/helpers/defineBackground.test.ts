/**
 * defineBackground stub helper 自测（P0 验收）：stub 后回调体求值即执行并记录，
 * restore 按原始状态还原（原本不存在→删除；原本存在→还原原值）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { stubDefineBackground } from './defineBackground'

const g = globalThis as unknown as { defineBackground?: unknown }

afterEach(() => {
  delete g.defineBackground
})

describe('stubDefineBackground', () => {
  it('stub 后 defineBackground 可调用：回调立即执行并记录（WXT 求值期语义）', () => {
    const stub = stubDefineBackground()
    const sideEffects: string[] = []
    // 模拟 background.ts 的模块形态：export default defineBackground(() => { 注册副作用 })
    const registered = defineBackgroundLike(() => {
      sideEffects.push('contextMenus.create')
    })
    expect(sideEffects).toEqual(['contextMenus.create']) // 求值即执行，注册逻辑可测
    expect(stub.callbacks).toHaveLength(1)
    expect(registered).toBeUndefined() // 与 WXT 一致：default export 无值

    stub.callbacks[0]!() // 保留的引用可重放
    expect(sideEffects).toHaveLength(2)
    stub.restore()
    expect(g.defineBackground).toBeUndefined()
  })

  it('restore 还原本已存在的 defineBackground', () => {
    const original = () => {}
    g.defineBackground = original
    const stub = stubDefineBackground()
    expect(g.defineBackground).not.toBe(original)
    stub.restore()
    expect(g.defineBackground).toBe(original)
  })
})

/** background.ts 同构形态（defineBackground 为编译期全局，测试里以同签名局部复刻） */
function defineBackgroundLike(cb: () => void): unknown {
  return (g.defineBackground as (cb: () => void) => unknown)(cb)
}
