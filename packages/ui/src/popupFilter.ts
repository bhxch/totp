import { entryMatchesUrl, filterByTags, type OtpEntry, type TagFilterMode } from '@totp/core'

// popup 四级回退（spec §3 Popup）：搜索 → tag → URL 分级放宽；快速取码场景不让空结果挡路，
// 纯 tag 浏览零命中如实反馈。本函数为纯函数不依赖 i18n 实例：hint 返回 i18n key
// （popupFilter.* 命名空间，zh 文案沿用 spec 回退表原文，en 见 locales），渲染端（popup App.vue）t() 插值。

export const HINT_SITE_TAGGED = 'popupFilter.hintSiteTagged'
export const HINT_TAG_RELAXED = 'popupFilter.hintTagRelaxed'
export const HINT_SITE_PLAIN = 'popupFilter.hintSitePlain'
export const HINT_SITE_ALL = 'popupFilter.hintSiteAll'

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
  /** 回退提示 i18n key（popupFilter.*）；正常命中为空串 */
  hint: string
  /** tag 后集合的 URL 命中数（popup「匹配 N 条」展示用） */
  urlMatchCount: number
}

export interface SearchEntriesOptions {
  /** 追加 secret 串匹配（I49：用户主动开启；secret 与待搜串都去空白后比较，大小写不敏感） */
  includeSecret?: boolean
}

/** 搜索谓词单一来源（R16④：popup 与 CodesPage 两份谓词合一）。issuer/label/note 拼串
 *  大小写不敏感包含；q 为空原样返回。includeSecret 时再对 secret 匹配（两者都去空白：
 *  secret 已规范为大写无空白，输入串做同样归一化） */
export function searchEntries(entries: OtpEntry[], q: string, opts: SearchEntriesOptions = {}): OtpEntry[] {
  if (!q) return entries
  const needle = q.toLowerCase()
  const secretNeedle = opts.includeSecret ? needle.replace(/\s+/g, '') : ''
  return entries.filter((e) => {
    if (`${e.issuer} ${e.label} ${e.note ?? ''}`.toLowerCase().includes(needle)) return true
    return opts.includeSecret === true && e.secret.replace(/\s+/g, '').toLowerCase().includes(secretNeedle)
  })
}

export function resolvePopupVisible(input: PopupFilterInput): PopupFilterResult {
  const base = searchEntries(input.entries, input.query.trim())
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
