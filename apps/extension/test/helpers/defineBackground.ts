/**
 * WXT defineBackground stub（P0 基建）：defineBackground 是 WXT 编译期全局
 * （构建时被插件消解，测试环境不存在），stub 后 `export default defineBackground(() => {...})`
 * 的回调体在模块求值时立即执行——background 的注册逻辑（右键菜单/onMessage/alarm 监听）
 * 因此可执行、可断言。用法（先 stub 再动态 import，vi.mock 提升不影响）：
 *
 *   const stub = stubDefineBackground()
 *   const bg = await import('../../entrypoints/background') // 求值期即跑注册回调
 *   expect(stub.callbacks).toHaveLength(1)
 *   ...断言 chrome shim 收到的注册副作用...
 *   stub.restore()
 */
interface DefineBackgroundStub {
  /** 已执行的回调（WXT 真实语义为求值期执行一次；保留引用便于复查/重放） */
  callbacks: Array<() => void>
  /** 还原 globalThis.defineBackground（原本不存在则删除） */
  restore(): void
}

export function stubDefineBackground(): DefineBackgroundStub {
  const g = globalThis as unknown as { defineBackground?: unknown }
  const original = g.defineBackground
  const callbacks: Array<() => void> = []
  g.defineBackground = (cb: () => void) => {
    callbacks.push(cb)
    cb()
  }
  return {
    callbacks,
    restore() {
      const gg = globalThis as unknown as { defineBackground?: unknown }
      if (original === undefined) delete gg.defineBackground
      else gg.defineBackground = original
    },
  }
}
