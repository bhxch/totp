// sql.js 懒加载执行器（计划 8 Task 3；SQLite 类导入的 ui 侧执行层）。
// 裁定口径：
// - sql.js 仅进 ui 包 dependencies，动态 import 保证不进主 chunk（vite/wxt 按 chunk 分离）
// - wasm 经 locateFile 指向 jsdelivr CDN（版本固定 1.14.2，与 dependencies 严格一致）；
//   离线（桌面/插件无网）时 wasm 下载失败 → 明确中文报错，SQLite 类导入不可用
// - SQLite 文件为二进制，经文本读取管道会损坏：字节级检测与 openSqlite 接线由 ImportCard
//   层在 Task 5 完成（platform 提供 readImportFileBytes）；本模块只负责 bytes → query
// - 行转换纯函数（msAuthRowsToEntries 等）在 @totp/core import/sqlite.ts，此处不涉及

const SQLJS_VERSION = '1.14.2' // 与 ui/package.json dependencies 固定版本一致
const SQLJS_WASM_CDN = `https://cdn.jsdelivr.net/npm/sql.js@${SQLJS_VERSION}/dist/`

export interface SqliteDb {
  /** 执行只读查询（SqlImporterHelper 口径：SELECT * FROM <table>），返回列名→值行数组 */
  query(sql: string, params?: unknown[]): Array<Record<string, unknown>>
  /** 释放 wasm 内存（用完必须调用） */
  close(): void
}

/**
 * 打开内存中的 SQLite 数据库（sql.js 懒加载：首次调用才拉取 js/wasm）。
 * 打开失败（文件损坏/非 SQLite）或 wasm 加载失败（离线）→ 中文报错。
 */
export async function openSqlite(bytes: Uint8Array): Promise<SqliteDb> {
  let initSqlJs: typeof import('sql.js')['default']
  try {
    ;({ default: initSqlJs } = await import('sql.js'))
  } catch {
    throw new Error('sql.js 模块加载失败，SQLite 类导入不可用')
  }

  let SQL: import('sql.js').SqlJsStatic
  try {
    // wasm 二进制不在 npm js 内联，经 locateFile 指向 CDN；离线时此处失败
    SQL = await initSqlJs({ locateFile: (file: string) => SQLJS_WASM_CDN + file })
  } catch {
    throw new Error(`sql.js wasm 加载失败（需联网下载 ${SQLJS_WASM_CDN}）；离线时 SQLite 类导入不可用`)
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
