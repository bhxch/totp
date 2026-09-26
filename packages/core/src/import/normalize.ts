import { TYPE_PROFILES } from '../otp/typeProfiles'
import type { ImportResult, ParsedEntry } from './types'

// 跨 4 个 importer 重复的规整 / 收集工具，统一收敛到本模块（M10）。
// 调用方（aegis/jsonApps/miscApps/generic）应 import 这些 helpers，保持行为一致。

// R3：digits 收口实现上移 otp/typeProfiles（查 descriptor.forcedDigits，消除 vault→import 反向依赖）；
// 此处 re-export 维持既有导入面（conflict.ts 及 '@totp/core' 出口不变，且不与 typeProfiles 出口重名冲突）
export { toOtpDigits } from '../otp/typeProfiles'

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

/** type 规整：含 yandex → 'yandex'，含 steam（大小写不敏感）→ 'steam'，含 hotp → 'hotp'，其余 'totp'。
 *  R3：匹配词与优先序查 TYPE_PROFILES（表定义序=归一优先级，nameHints 为小写包含匹配词；totp 无
 *  nameHints 作兜底），与原 if 链行为一致（'SteamYandex' 归 yandex） */
export function normalizeType(raw: unknown): ParsedEntry['type'] {
  const s = String(raw ?? '').toLowerCase()
  for (const [type, profile] of Object.entries(TYPE_PROFILES)) {
    if (profile.nameHints.some((h) => s.includes(h))) return type as ParsedEntry['type']
  }
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

/** digits 收口到 OtpDigits（I36 类型收紧的运行时边界）：steam 强制 5、yandex 强制 8，其余仅接受 6/7/8、非法回落 6。
 *  R3：实现上移 otp/typeProfiles（查 descriptor.forcedDigits），本模块 re-export 维持导入面 */

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

/** Steam 条目统一口径：SteamInfo.DIGITS=5、DEFAULT_PERIOD=30；algorithm 固定 SHA1。
 *  digits/algorithm 取自 typeProfiles（descriptor.defaultDigits/defaultAlgorithm），与注册表同源 */
export function steamEntry(secret: string, issuer: string, label: string): ParsedEntry {
  return {
    type: 'steam',
    issuer,
    label,
    secret: normalizeSecret(secret), // idempotent，已规整 secret 再次归一不影响
    algorithm: TYPE_PROFILES.steam.defaultAlgorithm,
    digits: TYPE_PROFILES.steam.defaultDigits,
    period: 30,
  }
}
