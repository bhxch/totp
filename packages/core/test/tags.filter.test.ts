import { describe, expect, it } from 'vitest'
import { filterByTags } from '../src/tags/filter'
import type { OtpEntry } from '../src/model'

const e = (uuid: string, tagIds: string[]): OtpEntry => ({
  uuid, type: 'totp', issuer: 'i', label: 'l', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds, order: 0, createdAt: 0,
})
const list = [e('a', ['t1']), e('b', ['t1', 't2']), e('c', ['t3']), e('d', [])]

describe('filterByTags', () => {
  it('未选中任何 tag 时原样返回', () => {
    expect(filterByTags(list, new Set(), 'any')).toBe(list)
    expect(filterByTags(list, new Set(), 'all')).toBe(list)
  })
  it('any=并集：命中任一选中', () => {
    expect(filterByTags(list, new Set(['t1', 't3']), 'any').map((x) => x.uuid)).toEqual(['a', 'b', 'c'])
  })
  it('all=交集：包含全部选中', () => {
    expect(filterByTags(list, new Set(['t1', 't2']), 'all').map((x) => x.uuid)).toEqual(['b'])
    expect(filterByTags(list, new Set(['t1', 't3']), 'all')).toEqual([])
  })
  it('悬空 tagId 视为不命中（any 与 all 均如此）', () => {
    expect(filterByTags(list, new Set(['nope']), 'any')).toEqual([])
    expect(filterByTags(list, new Set(['t1', 'nope']), 'all')).toEqual([])
  })
})
