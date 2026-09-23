/**
 * extApi 测试桥（批⑧ Task 10）：extApi 的 ext 是模块导入期快照（vitest 无宿主环境下
 * 固化为 undefined），而本套件沿既有 shim 模式逐用例向 globalThis.chrome 注入内存实现——
 * 两者时序错位（beforeEach 注入晚于模块求值）。各测试文件经
 * `vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())`
 * 取用本工厂：ext 以 getter 惰性解析 globalThis（browser ?? chrome），逐用例注入对
 * `import { ext }` 侧实时可见（与 lockEnforcer 既有「调用时 globalThis 探测」同口径）；
 * 能力探测函数按 extApi.ts 同语义复刻（getter 每次读取现值，不缓存）。
 */
type ExtLike = Record<string, unknown>

function currentExt(): ExtLike | undefined {
  const g = globalThis as unknown as { browser?: ExtLike; chrome?: ExtLike }
  return g.browser ?? g.chrome
}

export function extApiMock() {
  return {
    get ext() {
      return currentExt()
    },
    canOffscreen: (): boolean =>
      typeof (currentExt() as { offscreen?: unknown } | undefined)?.offscreen !== 'undefined',
    canIdle: (): boolean =>
      typeof (currentExt() as { idle?: { queryState?: unknown } } | undefined)?.idle?.queryState === 'function',
    canSetBadge: (): boolean =>
      typeof (currentExt() as { action?: { setBadgeText?: unknown } } | undefined)?.action?.setBadgeText === 'function',
    canOpenPopup: (): boolean =>
      typeof (currentExt() as { action?: { openPopup?: unknown } } | undefined)?.action?.openPopup === 'function',
  }
}
