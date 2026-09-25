import { openSqlite } from '../src/sqliteLoader'
import { describe, expect, it, vi } from 'vitest'

// 动态 import('sql.js') 直接失败（chunk 缺失/构建漂移）：mock 工厂抛错使 import 整体 reject
vi.mock('sql.js', () => {
  throw new Error('Cannot find module sql.js chunk')
})

describe('openSqlite 动态 import 失败分支', () => {
  it('sql.js 模块加载失败 → 中文报错且不触碰 fetch/实例化', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(openSqlite(new Uint8Array([1]))).rejects.toThrow('sql.js 模块加载失败')
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
