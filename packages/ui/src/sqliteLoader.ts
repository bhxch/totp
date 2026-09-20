// sql.js 懒加载执行器（计划 8 Task 3；SQLite 类导入的 ui 侧执行层）。
// 裁定口径：
// - sql.js 仅进 ui 包 dependencies，动态 import 保证不进主 chunk（vite/wxt 按 chunk 分离）
// - wasm 二进制随应用打包为本地资产 src/assets/sql-wasm.wasm（自 sql.js@1.14.2 dist 复制），
//   实例化前按固定 SHA-256 强校验；运行时无任何远程可执行代码下载路径（桌面/插件一致，
//   且满足 MV3 默认 CSP 禁远程代码）。刷新流程：用新版 dist/sql-wasm.wasm 覆盖资产文件、
//   同步更新 SQL_WASM_SHA256，并保持 dependencies 的 sql.js 版本与之一致
// - SQLite 文件为二进制，经文本读取管道会损坏：字节级检测与 openSqlite 接线由 ImportCard
//   层在 Task 5 完成（platform 提供 readImportFileBytes）；本模块只负责 bytes → query
// - 行转换纯函数（msAuthRowsToEntries 等）在 @totp/core import/sqlite.ts，此处不涉及

import { sha256Hex } from '@totp/core'
import wasmUrl from './assets/sql-wasm.wasm?url'

/** src/assets/sql-wasm.wasm（sql.js@1.14.2 dist 原件）的固定 SHA-256，实例化前强校验 */
const SQL_WASM_SHA256 = '38c14f6e379210bc942bdc4ebca44e7bfdb4318ecc1c72ca666a28fdce96670a'

/** 本地打包的 wasm 资产 URL（Vite ?url 注入，与宿主产物同源分发；导出供测试断言非远程） */
export const sqlWasmAssetUrl = wasmUrl

export interface SqliteDb {
  /** 执行只读查询（SqlImporterHelper 口径：SELECT * FROM <table>），返回列名→值行数组 */
  query(sql: string, params?: unknown[]): Array<Record<string, unknown>>
  /** 释放 wasm 内存（用完必须调用） */
  close(): void
}

/**
 * wasm 字节完整性校验：与固定 SHA-256 不一致（被篡改/损坏/换版本未同步常量）→ 抛错拒绝实例化。
 */
export async function verifyWasmBytes(bytes: Uint8Array): Promise<void> {
  const hex = await sha256Hex(bytes)
  if (hex !== SQL_WASM_SHA256) throw new Error(`sql.js wasm 完整性校验失败（sha256=${hex}），已拒绝实例化`)
}

/**
 * 打开内存中的 SQLite 数据库（sql.js 懒加载：首次调用才拉取 js/wasm）。
 * 打开失败（文件损坏/非 SQLite）或 wasm 本地资产缺失/校验不过 → 中文报错。
 */
export async function openSqlite(bytes: Uint8Array): Promise<SqliteDb> {
  let initSqlJs: typeof import('sql.js')['default']
  try {
    ;({ default: initSqlJs } = await import('sql.js'))
  } catch {
    throw new Error('sql.js 模块加载失败，SQLite 类导入不可用')
  }

  let wasmBinary: ArrayBuffer
  try {
    // 同源获取本地打包资产（无网络依赖）；失败即资产缺失或宿主构建异常
    const resp = await fetch(sqlWasmAssetUrl)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    wasmBinary = await resp.arrayBuffer()
  } catch {
    throw new Error(`sql.js wasm 本地资产加载失败（${sqlWasmAssetUrl}），SQLite 类导入不可用`)
  }
  await verifyWasmBytes(new Uint8Array(wasmBinary))

  let SQL: import('sql.js').SqlJsStatic
  try {
    // wasmBinary 直注字节：emscripten 跳过 locateFile，不做任何远程获取
    SQL = await initSqlJs({ wasmBinary })
  } catch {
    throw new Error('sql.js wasm 实例化失败，SQLite 类导入不可用')
  }

  let db: import('sql.js').Database
  try {
    db = new SQL.Database(bytes)
  } catch {
    throw new Error('无法打开 SQLite 数据库：文件已损坏或不是 SQLite 数据库')
  }

  return {
    query(sql: string, params?: unknown[]): Array<Record<string, unknown>> {
      try {
        const stmt = db.prepare(sql)
        try {
          if (params !== undefined) stmt.bind(params as never)
          const rows: Array<Record<string, unknown>> = []
          while (stmt.step()) rows.push({ ...stmt.getAsObject() })
          return rows
        } finally {
          stmt.free()
        }
      } catch (e) {
        throw new Error(`SQL 查询失败：${e instanceof Error ? e.message : String(e)}`)
      }
    },
    close(): void {
      db.close()
    },
  }
}
