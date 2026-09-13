import type { OtpEntry, Vault } from '../model'
import { addEntry, updateEntry } from '../vault'
import type { ParsedEntry } from './types'

export type ConflictPolicy = 'skip' | 'replace' | 'merge'

// 冲突键：issuer+label（trim+大小写不敏感），用分隔符避免拼接歧义
const conflictKey = (issuer: string, label: string): string => `${issuer.trim().toLowerCase()}\n${label.trim().toLowerCase()}`

// 由解析结果构造完整条目：uuid/order/nowMs 由调用方传入（Task 5 经 store.commit 提供）
export function newEntryFromParsed(p: ParsedEntry, uuid: string, order: number, nowMs: number): OtpEntry {
  return {
    uuid,
    type: p.type,
    issuer: p.issuer,
    label: p.label,
    secret: p.secret,
    algorithm: p.algorithm,
    digits: p.digits,
    period: p.period,
    ...(p.counter !== undefined ? { counter: p.counter } : {}),
    ...(p.note !== undefined ? { note: p.note } : {}),
    groupIds: [],
    order,
    createdAt: nowMs,
  }
}

// 返回 incoming 中与 existing 冲突（issuer+label 相同）的下标集合；existing 兼容传 Vault 或 OtpEntry[]
export function findConflicts(existing: OtpEntry[] | Vault, incoming: ParsedEntry[]): Set<number> {
  const list = Array.isArray(existing) ? existing : existing.entries
  const keys = new Set(list.map((e) => conflictKey(e.issuer, e.label)))
  const idx = new Set<number>()
  incoming.forEach((p, i) => {
    if (keys.has(conflictKey(p.issuer, p.label))) idx.add(i)
  })
  return idx
}

// 纯函数：非冲突条目全部新增；冲突条目按策略 skip=不动 / replace=覆盖（保留 uuid/order/groupIds）/ merge=照常新增并存
export function applyImport(v: Vault, entries: ParsedEntry[], policy: ConflictPolicy, conflictIdx: Set<number>): Vault {
  const now = Date.now()
  let out = v
  entries.forEach((p, i) => {
    if (conflictIdx.has(i)) {
      if (policy === 'skip') return
      if (policy === 'replace') {
        const target = out.entries.find((e) => conflictKey(e.issuer, e.label) === conflictKey(p.issuer, p.label))
        if (!target) return
        out = updateEntry(out, target.uuid, {
          type: p.type,
          issuer: p.issuer,
          label: p.label,
          secret: p.secret,
          algorithm: p.algorithm,
          digits: p.digits,
          period: p.period,
          counter: p.counter,
          note: p.note,
          createdAt: now,
        })
        return
      }
    }
    out = addEntry(out, newEntryFromParsed(p, crypto.randomUUID(), 0, now))
  })
  return out
}
