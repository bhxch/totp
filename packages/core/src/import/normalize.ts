import type { OtpDigits } from '../model'
import type { ImportResult, ParsedEntry } from './types'

// 跨 4 个 importer 重复的规整 / 收集工具，统一收敛到本模块（M10）。
// 调用方（aegis/jsonApps/miscApps/generic）应 import 这些 helpers，保持行为一致。

/** secret 规整：trim + 去所有空白 + 大写；与 aegis/jsonApps/miscApps/generic 原行为一致 */
export function normalizeSecret(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, '')
    .toUpperCase()
}

/** algorithm 规整：大写映射三值枚举，非法 → 'SHA1' */
export function normalizeAlgorithm(raw: unknown): ParsedEntry['algorithm'] {
  const s = String(raw ?? '').toUpperCase()
  return s === 'SHA256' || s === 'SHA512' ? s : 'SHA1'
}

/** type 规整：含 steam（大小写不敏感）→ 'steam'，含 hotp → 'hotp'，其余 'totp' */
export function normalizeType(raw: unknown): ParsedEntry['type'] {
  const s = String(raw ?? '').toLowerCase()
  if (s.includes('steam')) return 'steam'
  if (s.includes('hotp')) return 'hotp'
  return 'totp'
}

/** 数值规整：Number 化非法或非正 → fallback */
export function toPositiveNumber(raw: unknown, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 数值规整：Number 化非法或负数 → fallback（含 0，HOTP counter 缺省场景） */
export function toNonNegativeNumber(raw: unknown, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** digits 收口到 OtpDigits（I36 类型收紧的运行时边界）：steam 强制 5，其余仅接受 6/7/8、非法回落 6 */
export function toOtpDigits(raw: number, type: ParsedEntry['type']): OtpDigits {
  if (type === 'steam') return 5
  return raw === 6 || raw === 7 || raw === 8 ? raw : 6
}

/** 任意 unknown → 对象（null/数组均返回 null），统一 importer 内 row→obj 转换 */
export function asObject(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

/** 逐行调用 parse 回调 → { entries, failures }；错误行不阻断 */
export function collectEntries(
  rows: unknown[],
  parse: (row: unknown, index: number) => ParsedEntry | { error: string },
): ImportResult {
  const entries: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  rows.forEach((row, index) => {
    const res = parse(row, index)
    if ('error' in res) failures.push({ index, message: res.error })
    else entries.push(res)
  })
  return { entries, failures }
}

/** Steam 条目统一口径：SteamInfo.DIGITS=5、DEFAULT_PERIOD=30；algorithm 固定 SHA1 */
export function steamEntry(secret: string, issuer: string, label: string): ParsedEntry {
  return {
    type: 'steam',
    issuer,
    label,
    secret: normalizeSecret(secret), // idempotent，已规整 secret 再次归一不影响
    algorithm: 'SHA1',
    digits: 5,
    period: 30,
  }
}
