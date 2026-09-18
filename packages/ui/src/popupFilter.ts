import { entryMatchesUrl, filterByTags, type OtpEntry, type TagFilterMode } from '@totp/core'

// popup 四级回退（spec §3 Popup）：搜索 → tag → URL 分级放宽；快速取码场景不让空结果挡路，
// 纯 tag 浏览零命中如实反馈。提示常量与 spec 回退表逐字一致。

export const HINT_SITE_TAGGED = '当前站点无匹配，显示标签内结果'
export const HINT_TAG_RELAXED = '当前标签下无匹配，已放宽标签过滤'
export const HINT_SITE_PLAIN = '当前站点无匹配，显示全部'
export const HINT_SITE_ALL = '当前站点与标签均无匹配，显示全部'

export interface PopupFilterInput {
  entries: OtpEntry[]
  query: string
  selectedTagIds: ReadonlySet<string>
  tagMode: TagFilterMode
  /** URL 过滤生效（urlFilterEnabled 开启且读到 http(s) 标签页 URL） */
  urlFilterActive: boolean
  tabUrl: string | null
}

export interface PopupFilterResult {
  visible: OtpEntry[]
  /** 回退提示；正常命中为空串 */
  hint: string
  /** tag 后集合的 URL 命中数（popup「匹配 N 条」展示用） */
  urlMatchCount: number
}

function searchMatch(entries: OtpEntry[], q: string): OtpEntry[] {
  if (!q) return entries
  const needle = q.toLowerCase()
  return entries.filter((e) => `${e.issuer} ${e.label} ${e.note ?? ''}`.toLowerCase().includes(needle))
}

export function resolvePopupVisible(input: PopupFilterInput): PopupFilterResult {
  const base = searchMatch(input.entries, input.query.trim())
  const tagged = filterByTags(base, input.selectedTagIds, input.tagMode)
  if (!input.urlFilterActive) {
    if (tagged.length === 0 && input.query.trim() !== '' && input.selectedTagIds.size > 0) {
      return { visible: base, hint: HINT_TAG_RELAXED, urlMatchCount: 0 }
    }
    return { visible: tagged, hint: '', urlMatchCount: 0 }
  }
  const url = input.tabUrl ?? ''
  const urlSet = tagged.filter((e) => entryMatchesUrl(e, url))
  if (urlSet.length > 0) return { visible: urlSet, hint: '', urlMatchCount: urlSet.length }
  if (tagged.length > 0) {
    return { visible: tagged, hint: input.selectedTagIds.size > 0 ? HINT_SITE_TAGGED : HINT_SITE_PLAIN, urlMatchCount: 0 }
  }
  const urlOnly = base.filter((e) => entryMatchesUrl(e, url))
  if (urlOnly.length > 0) return { visible: urlOnly, hint: HINT_TAG_RELAXED, urlMatchCount: urlOnly.length }
  return { visible: base, hint: HINT_SITE_ALL, urlMatchCount: 0 }
}
