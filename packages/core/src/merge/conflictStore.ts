// packages/core/src/merge/conflictStore.ts
/** 条目级合并冲突记录持久化（spec §3/§4，key 'mergeConflicts'，单键存 EntryConflict[]）：
 *  - 记录含整条目内容（ours/theirs/base），属秘密载体——seal 语义同 cloud/syncState：启用库加密时
 *    宿主在解锁态注入 DEK seal 加密落盘，seal 缺省=明文库场景明文落盘；
 *  - 损坏/换 DEK/形态不符 → 回落空列表（不抛错阻断同步，下轮合并重建）；
 *  - 超上限（MERGE_CONFLICTS_MAX）保存时裁最旧（spec 错误处理：>100 条丢弃最旧记录）。 */
import type { Seal } from '../cloud/syncState'
import type { StorageAdapter } from '../storage/adapter'
import type { EntryConflict } from './vaultMerge'

export const MERGE_CONFLICTS_KEY = 'mergeConflicts'

/** 冲突记录上限（spec 错误处理：超限丢弃最旧记录） */
export const MERGE_CONFLICTS_MAX = 100

/** 单条宽松校验：entryId/issuer/label 必须为字符串，条目三态为 null 或对象——形态不符的元素
 *  逐条丢弃（条粒度损坏隔离，避免单条坏数据报废整份记录） */
function isEntryConflict(x: unknown): x is EntryConflict {
  const c = x as Partial<EntryConflict> | null
  const entryLike = (e: unknown): boolean => e === null || e === undefined || typeof e === 'object'
  return (
    typeof c?.entryId === 'string' &&
    typeof c.issuer === 'string' &&
    typeof c.label === 'string' &&
    entryLike(c.ours) &&
    entryLike(c.theirs) &&
    entryLike(c.base)
  )
}

export async function loadMergeConflicts(adapter: StorageAdapter, seal?: Seal): Promise<EntryConflict[]> {
  let raw: string | null = null
  try {
    raw = await adapter.get(MERGE_CONFLICTS_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(seal ? await seal.unseal(raw) : raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntryConflict)
  } catch {
    return [] // 换 DEK/损坏：回落空列表，不抛错阻断同步
  }
}

export async function saveMergeConflicts(adapter: StorageAdapter, list: EntryConflict[], seal?: Seal): Promise<void> {
  const capped = list.length > MERGE_CONFLICTS_MAX ? list.slice(list.length - MERGE_CONFLICTS_MAX) : list
  const plain = JSON.stringify(capped)
  await adapter.set(MERGE_CONFLICTS_KEY, seal ? await seal.seal(plain) : plain)
}
