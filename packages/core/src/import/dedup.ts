// 导入去重判定树（plan16 T5 / 设计 §4）：
// 一条 incoming 最多落一个分支，优先级 identical > suspect > conflict > new
// （secret 维度优先于 issuer+label 维度）。
import type { OtpEntry, Vault } from '../model'
import { addEntry, updateEntry } from '../vault'
import { applyImport, findConflicts, newEntryFromParsed, parsedPatch, type ConflictPolicy } from './conflict'
import type { ParsedEntry } from './types'

export type { ParsedEntry } from './types'

// ===== 键规范化 =====
// 裁定：判定键只含导入来源明确的字段（type|issuer|label|secret|algorithm|digits|period|counter），
// 不含 note/createdAt/order/groupIds——note 是用户本地字段，导入源不该用它判定相同；
// createdAt/order/groupIds 是 vault 管理字段，与内容相同性无关。键统一 trim+大小写不敏感。
const norm = (x: unknown): string => String(x).trim().toLowerCase()

type KeyFields = Pick<ParsedEntry, 'type' | 'issuer' | 'label' | 'secret' | 'algorithm' | 'digits' | 'period' | 'counter'>

const fullKey = (e: KeyFields): string =>
  [e.type, e.issuer, e.label, e.secret, e.algorithm, e.digits, e.period, e.counter ?? ''].map(norm).join('|')

const secretKey = (secret: string, algorithm: string): string => `${norm(secret)}|${norm(algorithm)}`

export interface DedupeWithinFileResult {
  kept: ParsedEntry[]
  removed: number
}

// 文件内全字段完全重复行合并，保留首条，避免预览计数虚高
export function dedupeWithinFile(entries: ParsedEntry[]): DedupeWithinFileResult {
  const seen = new Set<string>()
  const kept: ParsedEntry[] = []
  let removed = 0
  for (const e of entries) {
    const k = fullKey(e)
    if (seen.has(k)) {
      removed++
      continue
    }
    seen.add(k)
    kept.push(e)
  }
  return { kept, removed }
}

export type ImportKind = 'identical' | 'suspect' | 'conflict' | 'new'

export interface ImportPlan {
  kinds: ImportKind[]
  /** suspect 条目对应 existing 首个匹配条目的 uuid，其余下标为 undefined */
  targetUuids: Array<string | undefined>
  /** UI 四组预览计数派生：新增 new / 完全相同 identical / 疑似同账户 suspect / 冲突 conflict */
  counts: { identical: number; suspect: number; conflict: number; new: number }
}

// 导入预览阶段一次算好逐条标注：existing 兼容传 Vault 或 OtpEntry[]
export function planImport(existing: Vault | OtpEntry[], incoming: ParsedEntry[]): ImportPlan {
  const list = Array.isArray(existing) ? existing : existing.entries
  const fullKeys = new Set(list.map(fullKey))
  const secretKeys = new Map<string, string>()
  for (const e of list) {
    const k = secretKey(e.secret, e.algorithm)
    if (!secretKeys.has(k)) secretKeys.set(k, e.uuid) // 首个匹配
  }
  const conflictIdx = findConflicts(list, incoming)
  const kinds: ImportKind[] = []
  const targetUuids: Array<string | undefined> = []
  const counts = { identical: 0, suspect: 0, conflict: 0, new: 0 }
  incoming.forEach((p, i) => {
    let kind: ImportKind = 'new'
    let target: string | undefined
    if (fullKeys.has(fullKey(p))) {
      kind = 'identical'
    } else {
      target = secretKeys.get(secretKey(p.secret, p.algorithm))
      if (target) {
        kind = 'suspect'
      } else if (conflictIdx.has(i)) {
        kind = 'conflict'
      }
    }
    kinds.push(kind)
    targetUuids.push(target)
    counts[kind]++
  })
  return { kinds, targetUuids, counts }
}

export type SuspectChoice = 'skip' | 'add' | 'replace'

export interface ImportStats {
  added: number
  replaced: number
  suspectSkipped: number
  identical: number
  conflictSkipped: number
  conflictReplaced: number
  conflictMerged: number
}

export interface ApplyImportPlanResult {
  vault: Vault
  stats: ImportStats
}

// 按预览计划落库：identical 恒跳过；suspect 按 choices（缺省 skip；add=新增；replace=按 targetUuid 覆盖，
// 白名单复用 conflict.ts 的 parsedPatch，保留 uuid/order/groupIds 及未提供的 note/counter）；
// conflict 沿用 ConflictPolicy——单条复用 applyImport，保证 replace/merge 语义与既有导入路径完全一致；
// new 正常新增。
export function applyImportPlan(
  v: Vault,
  incoming: ParsedEntry[],
  plan: ImportPlan,
  suspectChoices: ReadonlyMap<number, SuspectChoice> = new Map(),
  policy: ConflictPolicy = 'skip',
): ApplyImportPlanResult {
  const now = Date.now()
  let out = v
  const stats: ImportStats = {
    added: 0, replaced: 0, suspectSkipped: 0, identical: 0, conflictSkipped: 0, conflictReplaced: 0, conflictMerged: 0,
  }
  incoming.forEach((p, i) => {
    switch (plan.kinds[i]) {
      case 'identical':
        stats.identical++
        return
      case 'suspect': {
        const choice = suspectChoices.get(i) ?? 'skip'
        if (choice === 'skip') {
          stats.suspectSkipped++
          return
        }
        if (choice === 'add') {
          out = addEntry(out, newEntryFromParsed(p, crypto.randomUUID(), now))
          stats.added++
          return
        }
        // replace：按 planImport 给出的 targetUuid 定位
        const target = plan.targetUuids[i]
        if (!target) {
          stats.suspectSkipped++ // 残缺 plan 防御：无目标退化为 skip
          return
        }
        out = updateEntry(out, target, parsedPatch(p, now))
        stats.replaced++
        return
      }
      case 'conflict': {
        if (policy === 'skip') {
          stats.conflictSkipped++
          return
        }
        out = applyImport(out, [p], policy, new Set([0]))
        if (policy === 'replace') stats.conflictReplaced++
        else stats.conflictMerged++
        return
      }
      default:
        out = addEntry(out, newEntryFromParsed(p, crypto.randomUUID(), now))
        stats.added++
    }
  })
  return { vault: out, stats }
}
