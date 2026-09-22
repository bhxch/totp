/** 条目级三方合并（spec §3）：base=共同祖先（null=降级两方合并），ours=本地，theirs=云端。
 *  条目身份=uuid；裁决表见 spec；非条目域：tags 按 id 并集（同 id 不同名取 ours，确定性、低风险），
 *  vault.updatedAt 取两侧较大值（防回滚由既有水位键把守，此处不涉 rev）。 */
import type { OtpEntry, Vault } from '../model'

export interface EntryConflict {
  entryId: string
  issuer: string
  label: string
  ours: OtpEntry | null
  theirs: OtpEntry | null
  base: OtpEntry | null
}

export interface MergeResult {
  vault: Vault
  conflicts: EntryConflict[]
  /** true=base 缺失走两方合并降级 */
  degraded: boolean
}

const updatedAtOf = (e: OtpEntry | null | undefined): number => e?.updatedAt ?? 0

function mergeTags(ours: Vault, theirs: Vault): Vault['tags'] {
  const out = new Map(ours.tags.map((t) => [t.id, t]))
  for (const t of theirs.tags) if (!out.has(t.id)) out.set(t.id, t)
  return [...out.values()]
}

export function mergeVaults(base: Vault | null, ours: Vault, theirs: Vault): MergeResult {
  const degraded = base === null
  const baseMap = new Map((base?.entries ?? []).map((e) => [e.uuid, e]))
  const oursMap = new Map(ours.entries.map((e) => [e.uuid, e]))
  const theirsMap = new Map(theirs.entries.map((e) => [e.uuid, e]))
  const conflicts: EntryConflict[] = []
  const out = new Map<string, OtpEntry>()

  const ids = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()])
  for (const id of ids) {
    const b = baseMap.get(id) ?? null
    const o = oursMap.get(id) ?? null
    const t = theirsMap.get(id) ?? null
    if (JSON.stringify(o) === JSON.stringify(t)) {
      if (o !== null) out.set(id, o) // 双方一致（含双方都删）
      continue
    }
    if (JSON.stringify(o) === JSON.stringify(b)) {
      if (t !== null) out.set(id, t) // 本方未动 → 取云方（含本方未动云方删=删除生效）
      continue
    }
    if (JSON.stringify(t) === JSON.stringify(b)) {
      if (o !== null) out.set(id, o) // 云方未动 → 取本方
      continue
    }
    // 剩余分歧 = 删/改对撞 或 双方改成不同内容
    if (o === null || t === null) {
      // 删/改对撞（base 有该条目、恰一方删）：恒保留修改方并记录冲突——spec §3「保留修改」防丢设计意图，
      // 豁免 updatedAt tie→云端规则（否则 legacy 无时间戳的修改会被删除吞掉）
      const survivor = (o ?? t)!
      out.set(id, survivor)
      conflicts.push({ entryId: id, issuer: survivor.issuer, label: survivor.label, ours: o, theirs: t, base: b })
      continue
    }
    // 双方改成不同内容 → updatedAt 新者为主体（tie 含双方都无 updatedAt → 取 t=云端胜），另一方入冲突
    const winner = updatedAtOf(t) > updatedAtOf(o) ? t : updatedAtOf(t) < updatedAtOf(o) ? o : t
    out.set(id, winner)
    conflicts.push({ entryId: id, issuer: o.issuer, label: o.label, ours: o, theirs: t, base: b })
  }
  const entries = [...out.values()].sort((a, b2) => a.order - b2.order)
  return {
    // ?? 0：畸形输入（updatedAt 运行时缺字段）防御，避免 Math.max 产生 NaN
    vault: {
      version: 2,
      entries,
      tags: mergeTags(ours, theirs),
      updatedAt: Math.max(ours.updatedAt ?? 0, theirs.updatedAt ?? 0),
    },
    conflicts,
    degraded,
  }
}
