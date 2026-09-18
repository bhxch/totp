import type { OtpEntry } from '../model'

export type TagFilterMode = 'any' | 'all'

/** 标签过滤：any=命中任一选中（并集），all=包含全部选中（交集）；悬空 id 视为不命中（spec §2） */
export function filterByTags(entries: OtpEntry[], selectedTagIds: ReadonlySet<string>, mode: TagFilterMode): OtpEntry[] {
  if (selectedTagIds.size === 0) return entries
  return entries.filter((e) =>
    mode === 'any'
      ? e.tagIds.some((id) => selectedTagIds.has(id))
      : [...selectedTagIds].every((id) => e.tagIds.includes(id)),
  )
}
