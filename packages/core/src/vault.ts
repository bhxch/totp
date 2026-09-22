import type { OtpEntry, Tag, Vault } from './model'
import { toOtpDigits } from './import/normalize'
import { parseOtpUri } from './otp/uri'

export function createVault(): Vault {
  return { version: 2, entries: [], tags: [], updatedAt: 0 }
}

function withVault(v: Vault, patch: Partial<Vault>): Vault {
  return { ...v, ...patch, updatedAt: Date.now() }
}

export function addEntry(v: Vault, entry: OtpEntry): Vault {
  const maxOrder = v.entries.reduce((m, e) => Math.max(m, e.order), -1)
  return withVault(v, {
    entries: [...v.entries, { ...entry, order: maxOrder + 1, updatedAt: entry.updatedAt ?? entry.createdAt }],
  })
}

export function removeEntry(v: Vault, uuid: string): Vault {
  return withVault(v, { entries: v.entries.filter((e) => e.uuid !== uuid) })
}

export function updateEntry(v: Vault, uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>): Vault {
  return withVault(v, {
    entries: v.entries.map((e) => (e.uuid === uuid ? { ...e, ...patch, updatedAt: Date.now() } : e)),
  })
}

// 同名唯一键：trim + 大小写不敏感（spec §1）
const tagKey = (name: string): string => name.trim().toLowerCase()

/** 建 tag：同名（trim+casefold）幂等复用返回现有 id；创建时名称 trim 落库 */
export function addTag(v: Vault, name: string): { vault: Vault; tagId: string } {
  const existing = v.tags.find((t) => tagKey(t.name) === tagKey(name))
  if (existing) return { vault: v, tagId: existing.id }
  const tag: Tag = { id: crypto.randomUUID(), name: name.trim() }
  return { vault: withVault(v, { tags: [...v.tags, tag] }), tagId: tag.id }
}

/** ensure 语义与 addTag 重合（幂等复用即 ensure），导出别名供导入/表单路径使用 */
export const ensureTag = addTag

/** 重命名只改名不做重名合并（保持引用稳定；重名收敛仅在创建路径） */
export function renameTag(v: Vault, id: string, name: string): Vault {
  return withVault(v, { tags: v.tags.map((t) => (t.id === id ? { ...t, name: name.trim() } : t)) })
}

export function removeTag(v: Vault, id: string): Vault {
  return withVault(v, {
    tags: v.tags.filter((t) => t.id !== id),
    entries: v.entries.map((e) => (e.tagIds.includes(id) ? { ...e, tagIds: e.tagIds.filter((t) => t !== id) } : e)),
  })
}

export function reorderEntries(v: Vault, orderedUuids: string[]): Vault {
  const orderMap = new Map(orderedUuids.map((uuid, i) => [uuid, i]))
  return withVault(v, {
    entries: v.entries.map((e) => (orderMap.has(e.uuid) ? { ...e, order: orderMap.get(e.uuid)! } : e)),
  })
}

export function newEntryFromUri(uri: string, nowMs: number = Date.now()): OtpEntry {
  const p = parseOtpUri(uri)
  return {
    uuid: crypto.randomUUID(),
    type: p.type,
    issuer: p.issuer,
    label: p.label,
    secret: p.secret,
    algorithm: p.algorithm,
    digits: toOtpDigits(p.digits, p.type),
    period: p.period,
    ...(p.counter !== undefined ? { counter: p.counter } : {}),
    ...(p.pin !== undefined ? { pin: p.pin } : {}),
    tagIds: [],
    order: 0,
    createdAt: nowMs,
  }
}
