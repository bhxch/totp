import type { FieldMap, ImportResult, ParsedEntry, RowMapping } from './types'

export type GenericRowsKind = 'jsonArray' | 'jsonObjectArray' | 'jsonl'

/** 深度优先找对象中第一个 Array 类型的值（自动探测嵌套行数组） */
function findFirstArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const found = findFirstArray(v)
      if (found) return found
    }
  }
  return null
}

/**
 * 提取通用格式的行数据：
 * - JSON array → rows=数组，kind='jsonArray'
 * - 单对象且（嵌套）某字段值为数组 → rows=该数组（取第一个 Array 值），kind='jsonObjectArray'
 * - JSONL → 按行 parse，坏行跳过不计 rows，kind='jsonl'
 */
export function extractGenericRows(text: string): { rows: unknown[]; kind: GenericRowsKind } {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return { rows: parsed, kind: 'jsonArray' }
      if (parsed && typeof parsed === 'object') {
        const rows = findFirstArray(parsed) ?? []
        return { rows, kind: 'jsonObjectArray' }
      }
    } catch {
      // 整体非合法 JSON，按 JSONL 处理
    }
  }
  const rows: unknown[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      rows.push(JSON.parse(t))
    } catch {
      // 坏行跳过
    }
  }
  return { rows, kind: 'jsonl' }
}

/** 点路径取值，如 'otp.params.secret'；任一段缺失返回 undefined */
function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** secret 规整：trim + 去所有空白 + 大写 */
function normalizeSecret(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase()
}

/** type 规整：含 steam（大小写不敏感）→ 'steam'，含 hotp → 'hotp'，其余 'totp' */
function normalizeType(raw: string): ParsedEntry['type'] {
  const s = raw.toLowerCase()
  if (s.includes('steam')) return 'steam'
  if (s.includes('hotp')) return 'hotp'
  return 'totp'
}

/** 数值规整：Number 化非法或非正 → fallback */
function toPositiveNumber(raw: unknown, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** algorithm 规整：大写映射三值枚举，非法 → 'SHA1' */
function normalizeAlgorithm(raw: unknown): ParsedEntry['algorithm'] {
  const s = String(raw ?? '').toUpperCase()
  return s === 'SHA256' || s === 'SHA512' ? s : 'SHA1'
}

function mapString(fm: FieldMap | undefined, row: unknown, fallback: string): string {
  if (!fm) return fallback
  const raw = getByPath(row, fm.path)
  return typeof raw === 'string' ? raw : fallback
}

/**
 * 单行映射为 ParsedEntry：
 * - 点路径取值，取不到 → 用 defaults
 * - secret 缺失 → { error: '缺少 secret 字段' }
 * - secret 默认过 uppercaseSecret（trim+去空白+大写）
 * - algorithm 非法→'SHA1'；digits/period 非法→6/30；type=steam 时 digits 强制 5
 */
export function mapRowToEntry(row: unknown, mapping: RowMapping): ParsedEntry | { error: string } {
  const defaults = mapping.defaults ?? {}

  const rawSecret = mapping.secret ? getByPath(row, mapping.secret.path) : undefined
  if (typeof rawSecret !== 'string' || rawSecret.trim() === '') return { error: '缺少 secret 字段' }
  const secret = normalizeSecret(rawSecret)

  const rawType = mapping.type ? getByPath(row, mapping.type.path) : undefined
  const type = normalizeType(typeof rawType === 'string' && rawType.trim() !== '' ? rawType : (defaults.type ?? 'totp'))

  const digits =
    type === 'steam'
      ? 5
      : toPositiveNumber(mapping.digits ? getByPath(row, mapping.digits.path) : undefined, defaults.digits ?? 6)
  const period = toPositiveNumber(
    mapping.period ? getByPath(row, mapping.period.path) : undefined,
    defaults.period ?? 30,
  )

  const rawAlgorithm = mapping.algorithm ? getByPath(row, mapping.algorithm.path) : undefined
  const algorithm =
    rawAlgorithm === undefined || rawAlgorithm === null || rawAlgorithm === ''
      ? (defaults.algorithm ?? 'SHA1')
      : normalizeAlgorithm(rawAlgorithm)

  const entry: ParsedEntry = {
    type,
    issuer: mapString(mapping.issuer, row, defaults.issuer ?? ''),
    label: mapString(mapping.label, row, defaults.label ?? ''),
    secret,
    algorithm,
    digits,
    period,
  }

  const rawCounter = mapping.counter ? getByPath(row, mapping.counter.path) : undefined
  const counterNum =
    rawCounter === undefined || rawCounter === null || rawCounter === '' ? NaN : Number(rawCounter)
  if (Number.isFinite(counterNum) && counterNum >= 0) {
    entry.counter = counterNum // hotp 初始 counter=0 合法
  } else if (typeof defaults.counter === 'number') {
    entry.counter = defaults.counter
  }

  const note = mapString(mapping.note, row, '')
  if (note !== '') entry.note = note
  else if (defaults.note !== undefined) entry.note = defaults.note

  return entry
}

/**
 * 通用 JSON/JSONL 批量导入：
 * rows 用 extractGenericRows 或 rowsOverride；逐行 mapRowToEntry，失败行进 failures
 */
export function importGeneric(text: string, mapping: RowMapping, rowsOverride?: unknown[]): ImportResult {
  const rows = rowsOverride !== undefined ? rowsOverride : extractGenericRows(text).rows
  const entries: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  rows.forEach((row, index) => {
    const res = mapRowToEntry(row, mapping)
    if ('error' in res) failures.push({ index, message: res.error })
    else entries.push(res)
  })
  return { entries, failures }
}
