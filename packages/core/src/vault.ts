import type { OtpEntry, Tag, Vault } from './model'
import { toOtpDigits } from './otp/typeProfiles'
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
    entries: [
      ...v.entries,
      {
        ...entry,
        // R3：入库边界统一收口 digits（查 descriptor.forcedDigits：steam=5、yandex=8、其余 6/7/8）——
        // 非恒等收口（toOtpDigits(5,'totp')=6，理由同 newEntryFromUri：digits=5 仅在 URI 宽松解析期
        // 被 typeProfiles 保留，不入库），UI/导入路径的前置收口移除后由本边界兜底，防非法 digits
        // 落盘被 loadVault 整体拒绝
        digits: toOtpDigits(entry.digits, entry.type),
        order: maxOrder + 1,
        updatedAt: entry.updatedAt ?? entry.createdAt,
      },
    ],
  })
}

export function removeEntry(v: Vault, uuid: string): Vault {
  return withVault(v, { entries: v.entries.filter((e) => e.uuid !== uuid) })
}

/** ④B 批量删除：单次不可变过滤（store 单 commit 原子落盘），未知 uuid 忽略 */
export function removeEntries(v: Vault, uuids: string[]): Vault {
  const dead = new Set(uuids)
  return withVault(v, { entries: v.entries.filter((e) => !dead.has(e.uuid)) })
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
    // R3 评审修复：parseOtpUri 的 ALLOWED_DIGITS 含 5（steam URI 语义），totp/hotp URI digits=5
    // 能过解析但 toOtpDigits(5, totp/hotp)=6 非恒等——此处不是幂等收口，必须保留（否则落库 5，
    // UI 预填直提被共享 EntryForm 的 [6,7,8] 校验拒绝；原行为静默修正为 6）
    digits: toOtpDigits(p.digits, p.type),
    period: p.period,
    ...(p.counter !== undefined ? { counter: p.counter } : {}),
    ...(p.pin !== undefined ? { pin: p.pin } : {}),
    tagIds: [],
    order: 0,
    createdAt: nowMs,
  }
}
