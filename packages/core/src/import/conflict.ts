import type { OtpEntry, Vault } from '../model'
import { addEntry, addTag, updateEntry } from '../vault'
import { toOtpDigits } from './normalize'
import type { ParsedEntry } from './types'

export type ConflictPolicy = 'skip' | 'replace' | 'merge'

// 冲突键：issuer+label（trim+大小写不敏感），用分隔符避免拼接歧义
const conflictKey = (issuer: string, label: string): string => `${issuer.trim().toLowerCase()}\n${label.trim().toLowerCase()}`

// 由解析结果构造完整条目：uuid/order/nowMs 由调用方传入（Task 5 经 store.commit 提供）
// order 在 addEntry 路径下被 vault 自动按 maxOrder+1 重算，可传占位 0；保留参数仅为兼容 replace 等显式 order 场景
export function newEntryFromParsed(p: ParsedEntry, uuid: string, nowMs: number, order: number = 0, tagIds: string[] = []): OtpEntry {
  return {
    uuid,
    type: p.type,
    issuer: p.issuer,
    label: p.label,
    secret: p.secret,
    algorithm: p.algorithm,
    digits: toOtpDigits(p.digits, p.type),
    period: p.period,
    ...(p.counter !== undefined ? { counter: p.counter } : {}),
    ...(p.note !== undefined ? { note: p.note } : {}),
    tagIds,
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

// 覆盖白名单（conflict replace 与 dedup suspect replace 共用，保证两处不漂移）：
// 仅更新导入来源明确的字段（type/issuer/label/secret/algorithm/digits/period/createdAt）；
// counter/note 若解析结果中未提供则省略（避免静默覆盖本地 HOTP 计数或用户笔记）
export function parsedPatch(p: ParsedEntry, nowMs: number): Partial<Omit<OtpEntry, 'uuid'>> {
  return {
    type: p.type,
    issuer: p.issuer,
    label: p.label,
    secret: p.secret,
    algorithm: p.algorithm,
    digits: toOtpDigits(p.digits, p.type),
    period: p.period,
    ...(p.counter !== undefined ? { counter: p.counter } : {}),
    ...(p.note !== undefined ? { note: p.note } : {}),
    createdAt: nowMs,
  }
}

/** 导入 tag 名 → id：逐个 addTag（同名幂等复用），空白名跳过（spec §4 落库） */
export function resolveTagNames(v: Vault, names: readonly string[]): { vault: Vault; tagIds: string[] } {
  let out = v
  const ids: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue
    const r = addTag(out, name)
    out = r.vault
    if (!ids.includes(r.tagId)) ids.push(r.tagId) // 同一批内 trim 等价名复用同一 tag，id 去重
  }
  return { vault: out, tagIds: ids }
}

// 纯函数：非冲突条目全部新增；冲突条目按策略 skip=不动 / replace=覆盖内容字段且 tags 取现有∪导入并集
// （保留 uuid/order/createdAt/未在 patch 中出现的字段如 note/counter）/ merge=照常新增并存
export function applyImport(v: Vault, entries: ParsedEntry[], policy: ConflictPolicy, conflictIdx: Set<number>): Vault {
  const now = Date.now()
  let out = v
  entries.forEach((p, i) => {
    if (conflictIdx.has(i)) {
      if (policy === 'skip') return
      if (policy === 'replace') {
        const target = out.entries.find((e) => conflictKey(e.issuer, e.label) === conflictKey(p.issuer, p.label))
        if (!target) return
        const resolved = resolveTagNames(out, p.tags ?? [])
        out = resolved.vault
        out = updateEntry(out, target.uuid, {
          ...parsedPatch(p, now),
          tagIds: [...new Set([...target.tagIds, ...resolved.tagIds])],
        })
        return
      }
    }
    const resolved = resolveTagNames(out, p.tags ?? [])
    out = resolved.vault
    // order 由 addEntry 内部按当前 maxOrder+1 计算；冲突策略下追加新条目用占位 0 即可
    out = addEntry(out, newEntryFromParsed(p, crypto.randomUUID(), now, 0, resolved.tagIds))
  })
  return out
}
