import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openSqlite } from '../src/sqliteLoader'
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'

// sql.js 整体替换为受控替身：initSqlJs 与 Database 均可逐用例注入失败/成功行为
const { initSqlJsMock } = vi.hoisted(() => ({ initSqlJsMock: vi.fn() }))
vi.mock('sql.js', () => ({ default: initSqlJsMock }))

// jsdom 环境的 crypto 无 subtle：以 Node webcrypto 替身提供真实 SHA-256（同 sqliteLoader.test.ts）
beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const wasmBytes = new Uint8Array(readFileSync(join(__dirname, '../src/assets/sql-wasm.wasm')))

/** 通过 wasm 完整性校验的 fetch 替身（后续失败注入聚焦 initSqlJs/Database 层） */
function stubFetchWasm(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(wasmBytes)))
}

/** 可注入行为的假 Database 工厂：stmt 行为逐用例覆盖 */
function stubSqlJs(database: { prepare?: ReturnType<typeof vi.fn>; close?: ReturnType<typeof vi.fn>; ctorThrows?: unknown }): ReturnType<typeof vi.fn> {
  const close = database.close ?? vi.fn()
  const Database = class {
    constructor() {
      if (database.ctorThrows !== undefined) throw database.ctorThrows
    }
    prepare = database.prepare
    close = close
  }
  initSqlJsMock.mockReset()
  initSqlJsMock.mockResolvedValue({ Database })
  return close
}

describe('openSqlite 失败分支（vi.mock sql.js + fetch stub 五类）', () => {
  it('fetch 网络失败（资产缺失/宿主构建异常）→「本地资产加载失败」，不进实例化', async () => {
    stubSqlJs({})
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(openSqlite(new Uint8Array([1]))).rejects.toThrow('本地资产加载失败')
    expect(initSqlJsMock).not.toHaveBeenCalled()
  })

  it('fetch 返回 HTTP 非 ok（如 404）→ 同「本地资产加载失败」', async () => {
    stubSqlJs({})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gone', { status: 404 })))
    await expect(openSqlite(new Uint8Array([1]))).rejects.toThrow('本地资产加载失败')
    expect(initSqlJsMock).not.toHaveBeenCalled()
  })

  it('initSqlJs 实例化失败（wasm 编译异常）→「wasm 实例化失败」', async () => {
    stubFetchWasm()
    initSqlJsMock.mockReset()
    initSqlJsMock.mockRejectedValue(new Error('abort(OOM). Build with -s ASSERTIONS=1'))
    await expect(openSqlite(new Uint8Array([1]))).rejects.toThrow('wasm 实例化失败')
  })

  it('new Database 对损坏字节抛错 →「已损坏或不是 SQLite 数据库」', async () => {
    stubFetchWasm()
    stubSqlJs({ ctorThrows: new Error('file is not a database') })
    await expect(openSqlite(new Uint8Array([1, 2, 3]))).rejects.toThrow('已损坏或不是 SQLite 数据库')
  })
})

describe('openSqlite 查询通道（假 Database 桩）', () => {
  it('query：SQL 执行抛错 → 包装为「SQL 查询失败：…」', async () => {
    stubFetchWasm()
    stubSqlJs({ prepare: vi.fn(() => { throw new Error('no such table: t') }) })
    const db = await openSqlite(new Uint8Array([1]))
    expect(() => db.query('SELECT * FROM t')).toThrow('SQL 查询失败：no such table: t')
    db.close()
  })

  it('query：params 走 stmt.bind（非 Error 抛出物也以 String 包装）；无 params 不调用 bind', async () => {
    stubFetchWasm()
    const binds: Array<ReturnType<typeof vi.fn>> = []
    const frees: Array<ReturnType<typeof vi.fn>> = []
    // 每次 prepare 产出独立 stmt：step 首次 true、其后 false（每 stmt 各自计数）
    const prepare = vi.fn(() => {
      const bind = vi.fn()
      const free = vi.fn()
      let stepped = false
      binds.push(bind)
      frees.push(free)
      return { bind, free, getAsObject: () => ({ v: 42 }), step: () => (stepped ? ((stepped = false), false) : ((stepped = true), true)) }
    })
    stubSqlJs({ prepare })
    const db = await openSqlite(new Uint8Array([1]))
    expect(db.query('SELECT * FROM t WHERE v > ?', [41])).toEqual([{ v: 42 }])
    expect(binds[0]).toHaveBeenCalledWith([41])
    expect(frees[0]).toHaveBeenCalledTimes(1)
    // 无 params：不 bind
    expect(db.query('SELECT * FROM t')).toEqual([{ v: 42 }])
    expect(binds[1]).not.toHaveBeenCalled()
    // 非 Error 抛出物（字符串 reject）同样收进「SQL 查询失败：…」
    prepare.mockImplementationOnce(() => { throw 'boom-string' })
    expect(() => db.query('SELECT 1')).toThrow('SQL 查询失败：boom-string')
    db.close()
  })

  it('close：透传 db.close 释放 wasm 内存', async () => {
    stubFetchWasm()
    const close = vi.fn()
    stubSqlJs({ prepare: vi.fn(), close })
    const db = await openSqlite(new Uint8Array([1]))
    db.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
