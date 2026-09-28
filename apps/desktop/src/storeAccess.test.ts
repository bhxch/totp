/**
 * storeAccess 单元补测（dispose 健壮性）：DisposableBag.dispose 原先 splice(0) 先清队再遍历，
 * 某个 unlisten 抛错则余项已出队、永不再执行——改为逐项 shift + 逐项 try/catch 后，抛错项不
 * 阻断余项清算（warn 留痕不放大），全部尝试完毕数组必空，幂等语义不变。
 * why：desktopShell.test 的 dispose 幂等用例注入不了抛错 unlisten（监听经 tauri mock 注册均
 * 不抛），此处直测 DisposableBag 以抛错项钉住「余项仍执行」。
 */
import { describe, expect, it, vi } from 'vitest'
import { DisposableBag } from './storeAccess'

// storeAccess 顶部运行时导入 @tauri-apps/api/event（仅 safeListen 用），node 环境以桩替身
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))

describe('DisposableBag：unlisten 清算健壮性', () => {
  it('单项抛错不阻断余项：全部 unlisten 均被尝试，抛错项 warn 留痕', () => {
    const bag = new DisposableBag()
    const calls: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bag.track(() => calls.push('a'))
    bag.track(() => {
      calls.push('boom')
      throw new Error('unlisten failed')
    })
    bag.track(() => calls.push('c'))
    expect(() => bag.dispose()).not.toThrow()
    expect(calls).toEqual(['a', 'boom', 'c'])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('抛错后队列已排干：重复 dispose 不重复执行（幂等语义不变）', () => {
    const bag = new DisposableBag()
    const fn = vi.fn(() => {
      throw new Error('x')
    })
    bag.track(fn)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bag.dispose()
    expect(() => bag.dispose()).not.toThrow()
    expect(fn).toHaveBeenCalledTimes(1) // 第二次 dispose 无项可执行
    warn.mockRestore()
  })

  it('track(null/undefined) 为 no-op；dispose 按登记顺序执行', () => {
    const bag = new DisposableBag()
    const calls: number[] = []
    bag.track(null)
    bag.track(undefined)
    bag.track(() => calls.push(1))
    bag.track(() => calls.push(2))
    bag.dispose()
    expect(calls).toEqual([1, 2])
  })
})
