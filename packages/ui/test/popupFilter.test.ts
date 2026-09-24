import { describe, expect, it } from 'vitest'
import { addTag, createVault, addEntry } from '@totp/core'
import { resolvePopupVisible, HINT_SITE_TAGGED, HINT_TAG_RELAXED, HINT_SITE_PLAIN, HINT_SITE_ALL } from '../src/popupFilter'
import zhMessages from '../src/i18n/locales/zh/common.json'
import enMessages from '../src/i18n/locales/en/common.json'
import type { OtpEntry } from '@totp/core'

const e = (uuid: string, tagIds: string[], rules: unknown[] = []): OtpEntry => ({
  uuid, type: 'totp', issuer: uuid, label: 'l', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds, order: 0, createdAt: 0,
  matchRules: rules as OtpEntry['matchRules'],
})
const work = e('a', ['t1'], [{ strategy: 'baseDomain', pattern: 'work.com' }])
const home = e('b', [], [{ strategy: 'baseDomain', pattern: 'home.com' }])
const plain = e('c', [])

const base = { entries: [work, home, plain], query: '', selectedTagIds: new Set(['t1']), tagMode: 'any' as const, tabUrl: null }

describe('resolvePopupVisible 四级回退（spec §3）', () => {
  it('T1：urlSet 命中直接显示，无提示', () => {
    const r = resolvePopupVisible({ ...base, urlFilterActive: true, tabUrl: 'https://work.com/x' })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe('')
    expect(r.urlMatchCount).toBe(1)
  })
  it('T2：站点零匹配回退 tagged，提示 HINT_SITE_TAGGED', () => {
    const r = resolvePopupVisible({ ...base, urlFilterActive: true, tabUrl: 'https://other.com' })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe(HINT_SITE_TAGGED)
  })
  it('T2 变体：未选中 tag 时提示为 HINT_SITE_PLAIN', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(), urlFilterActive: true, tabUrl: 'https://other.com' })
    expect(r.hint).toBe(HINT_SITE_PLAIN)
  })
  it('T3：tag 零命中放宽为 urlOnly，提示 HINT_TAG_RELAXED', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(['t2']), urlFilterActive: true, tabUrl: 'https://work.com' })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe(HINT_TAG_RELAXED)
  })
  it('T4：放宽后站点仍零匹配回退 base，提示 HINT_SITE_ALL', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(['t2']), urlFilterActive: true, tabUrl: 'https://none.com' })
    expect(r.visible).toHaveLength(3)
    expect(r.hint).toBe(HINT_SITE_ALL)
  })
  it('无 URL：搜索+tag 命中显示 tagged', () => {
    const r = resolvePopupVisible({ ...base, urlFilterActive: false })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe('')
  })
  it('无 URL：有搜索词且 tag 零命中 → 放宽显示 base 并提示', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(['t2']), query: 'a', urlFilterActive: false })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe(HINT_TAG_RELAXED)
  })
  it('无 URL 无搜索：纯 tag 浏览零命中不放宽（空列表无提示）', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(['t2']), urlFilterActive: false })
    expect(r.visible).toEqual([])
    expect(r.hint).toBe('')
  })
})

describe('回退提示 i18n 化（HINT_* 返回 key，渲染端 t() 插值）', () => {
  it('四个常量即 popupFilter.* 命名空间 key，zh/en 两份 locale 均有对应文案', () => {
    const keys = [HINT_SITE_TAGGED, HINT_TAG_RELAXED, HINT_SITE_PLAIN, HINT_SITE_ALL]
    expect(new Set(keys).size).toBe(4)
    for (const k of keys) {
      const name = k.slice('popupFilter.'.length)
      expect(k.startsWith('popupFilter.hint')).toBe(true)
      expect((zhMessages.popupFilter as Record<string, string>)[name]).toBeTruthy()
      expect((enMessages.popupFilter as Record<string, string>)[name]).toBeTruthy()
    }
  })
  it('回退路径返回 key 而非硬编码文案（zh 文案收敛在 locale，纯函数不依赖 i18n 实例）', () => {
    const r = resolvePopupVisible({ ...base, urlFilterActive: true, tabUrl: 'https://other.com' })
    expect(r.hint).toBe('popupFilter.hintSiteTagged')
    expect(r.hint).not.toContain('当前站点')
  })
})

describe('与真实 vault 协同', () => {
  it('addTag 建出的 tag 可直接参与筛选', () => {
    let v = createVault()
    const r = addTag(v, '工作')
    v = addEntry(r.vault, { ...e('a', [r.tagId]) })
    const out = resolvePopupVisible({
      entries: v.entries, query: '', selectedTagIds: new Set([r.tagId]), tagMode: 'any',
      urlFilterActive: false, tabUrl: null,
    })
    expect(out.visible.map((x) => x.uuid)).toEqual(['a'])
  })
})

describe('F13：popup 混合规则求值（同步/旧 vault 通道的引擎边界兜底）', () => {
  const risky = e('r', [], [{ strategy: 'regex', pattern: '(a+)+$' }, { strategy: 'baseDomain', pattern: 'work.com' }])
  const safe = e('s', [], [{ strategy: 'regex', pattern: '^https://work\\.com' }])
  it('不安全 regex 规则被跳过，同条目其余规则照常命中', () => {
    const r = resolvePopupVisible({ ...base, entries: [risky], selectedTagIds: new Set(), urlFilterActive: true, tabUrl: 'https://work.com/x' })
    expect(r.visible.map((x) => x.uuid)).toEqual(['r'])
    expect(r.urlMatchCount).toBe(1)
  })
  it('安全 regex 规则在渲染路径照常命中', () => {
    const r = resolvePopupVisible({ ...base, entries: [safe], selectedTagIds: new Set(), urlFilterActive: true, tabUrl: 'https://work.com/x' })
    expect(r.visible.map((x) => x.uuid)).toEqual(['s'])
  })
  it('全部规则不命中时按既有回退链处理', () => {
    const r = resolvePopupVisible({ ...base, entries: [risky], selectedTagIds: new Set(), urlFilterActive: true, tabUrl: 'https://other.com' })
    expect(r.visible.map((x) => x.uuid)).toEqual(['r'])
    expect(r.hint).toBe(HINT_SITE_PLAIN)
    expect(r.urlMatchCount).toBe(0)
  })
})
