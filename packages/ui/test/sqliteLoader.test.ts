import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '@totp/core'
import { openSqlite, sqlWasmAssetUrl, verifyWasmBytes } from '../src/sqliteLoader'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// jsdom 环境的 crypto 无 subtle：以 Node webcrypto 替身提供真实 SHA-256（afterAll 统一还原）
beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const wasmBytes = new Uint8Array(readFileSync(join(__dirname, '../src/assets/sql-wasm.wasm')))

describe('sqliteLoader（本地 wasm 资产 + 固定 sha256 强校验）', () => {
  it('资产 URL 为本地打包路径：不含远程 http(s)/CDN 地址', () => {
    expect(sqlWasmAssetUrl).not.toMatch(/^https?:/i)
    expect(sqlWasmAssetUrl.toLowerCase()).not.toContain('cdn')
  })

  it('打包字节通过完整性校验（资产与固定 sha256 常量不脱节）', async () => {
    await expect(verifyWasmBytes(wasmBytes)).resolves.toBeUndefined()
    await expect(sha256Hex(wasmBytes)).resolves.toMatch(/^[0-9a-f]{64}$/)
  })

  it('任一字节被篡改 → 校验失败拒绝实例化', async () => {
    const tampered = wasmBytes.slice()
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    await expect(verifyWasmBytes(tampered)).rejects.toThrow('完整性校验失败')
  })

  it('截断的字节 → 同样拒绝', async () => {
    await expect(verifyWasmBytes(wasmBytes.slice(0, 4096))).rejects.toThrow('完整性校验失败')
  })

  it('openSqlite 端到端：本地字节注入 wasmBinary → 打开数据库 → 查询 → 关闭', async () => {
    // fetch 替身回源本地打包字节（vitest 无宿主产物同源 URL 可 fetch，语义与运行时一致）
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wasmBytes)))
    const { default: initSqlJs } = await import('sql.js')
    const bootstrap = await initSqlJs({ wasmBinary: wasmBytes.slice().buffer as ArrayBuffer })
    const src = new bootstrap.Database()
    src.run('CREATE TABLE t(v); INSERT INTO t VALUES (42);')
    const dbBytes = new Uint8Array(src.export())
    src.close()

    const db = await openSqlite(dbBytes)
    try {
      expect(db.query('SELECT * FROM t')).toEqual([{ v: 42 }])
    } finally {
      db.close()
    }
  })
})
