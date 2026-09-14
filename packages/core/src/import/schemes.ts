import type { FieldMap, RowMapping } from './types'

/**
 * 通用导入映射方案：用户在 generic 映射页命名的 rowsPath+mapping 组合，
 * 以 JSON 数组存 storage 的 SCHEMES_KEY 键，跨端随 storage adapter 走（随设置同步）。
 */
export interface ImportScheme {
  id: string
  name: string
  rowsPath?: string
  mapping: RowMapping
  createdAt: number
}

/** storage 存储键：'importSchemes'（JSON 数组文本） */
export const SCHEMES_KEY = 'importSchemes'

/** matchSchemes 推荐列表上限 */
const MATCH_LIMIT = 3

/** mapping 目标字段（defaults 之外的 FieldMap 键），与 generic 映射页 FIELDS 对齐 */
const FIELD_KEYS = ['type', 'issuer', 'label', 'secret', 'algorithm', 'digits', 'period', 'counter', 'note'] as const

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** FieldMap 容错：path 必须非空字符串；transform 仅接受已知值 */
function normFieldMap(x: unknown): FieldMap | undefined {
  if (!isRecord(x)) return undefined
  const p = x['path']
  if (typeof p !== 'string' || p.trim() === '') return undefined
  const fm: FieldMap = { path: p }
  if (x['transform'] === 'uppercaseSecret') fm.transform = 'uppercaseSecret'
  return fm
}

/**
 * 容错解析存储中的方案数组（storage JSON.parse 后的任意值）：
 * - 非数组 → []
 * - 坏条目丢弃：非对象 / id 或 name 非非空字符串 / mapping.secret.path 非非空字符串
 * - 字段净化：rowsPath/createdAt 非法丢弃或兜底 0；mapping 仅保留合法 FieldMap 与 defaults 对象
 * - id 去重保留首个
 */
export function normalizeSchemes(x: unknown): ImportScheme[] {
  if (!Array.isArray(x)) return []
  const out: ImportScheme[] = []
  const seen = new Set<string>()
  for (const item of x) {
    if (!isRecord(item)) continue
    const { id, name } = item
    if (typeof id !== 'string' || id.trim() === '' || typeof name !== 'string' || name.trim() === '') continue
    const rawMapping = item['mapping']
    if (!isRecord(rawMapping)) continue
    const secret = normFieldMap(rawMapping['secret'])
    if (!secret) continue
    const mapping: RowMapping = { secret }
    for (const k of FIELD_KEYS) {
      if (k === 'secret') continue
      const fm = normFieldMap(rawMapping[k])
      if (fm) mapping[k] = fm
    }
    if (isRecord(rawMapping['defaults'])) mapping.defaults = rawMapping['defaults'] as RowMapping['defaults']
    const s: ImportScheme = { id, name, mapping, createdAt: typeof item['createdAt'] === 'number' && Number.isFinite(item['createdAt']) ? item['createdAt'] : 0 }
    const rowsPath = item['rowsPath']
    if (typeof rowsPath === 'string' && rowsPath.trim() !== '') s.rowsPath = rowsPath
    if (!seen.has(id)) {
      seen.add(id)
      out.push(s)
    }
  }
  return out
}

/** 同 id 覆盖（原位替换、长度不变），新 id 追加尾部；返回新数组不改入参 */
export function upsertScheme(schemes: ImportScheme[], s: ImportScheme): ImportScheme[] {
  const i = schemes.findIndex((x) => x.id === s.id)
  if (i < 0) return [...schemes, s]
  const out = [...schemes]
  out[i] = s
  return out
}

/** 删除指定 id；返回新数组不改入参 */
export function removeScheme(schemes: ImportScheme[], id: string): ImportScheme[] {
  return schemes.filter((x) => x.id !== id)
}

/**
 * 推荐复用排序：方案 mapping 各 FieldMap 路径首段（如 'otp.params.secret'→'otp'）
 * 与 sampleKeys（数据首行键）交集数 >0 才入选，交集数降序（稳定排序，同数保持原序），最多 MATCH_LIMIT 条。
 */
export function matchSchemes(schemes: ImportScheme[], sampleKeys: string[]): ImportScheme[] {
  const keys = new Set(sampleKeys)
  const scored = schemes
    .map((s) => {
      const firsts = new Set<string>()
      for (const k of FIELD_KEYS) {
        const fm = s.mapping[k]
        if (fm) firsts.add(fm.path.split('.')[0] ?? '')
      }
      let hits = 0
      for (const f of firsts) if (keys.has(f)) hits++
      return { s, hits }
    })
    .filter((x) => x.hits > 0)
  return scored.sort((a, b) => b.hits - a.hits).slice(0, MATCH_LIMIT).map((x) => x.s)
}
