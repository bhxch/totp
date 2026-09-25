import { describe, expect, it } from 'vitest'
import { mapRowToEntry } from '../src/import/generic'
import {
  matchSchemes, normalizeSchemes, removeScheme, SCHEMES_KEY, upsertScheme,
  type ImportScheme,
} from '../src/import/schemes'

const mk = (over: Partial<ImportScheme> = {}): ImportScheme => ({
  id: 's1',
  name: '方案一',
  mapping: { secret: { path: 'otp.secret' } },
  createdAt: 1000,
  ...over,
})

describe('schemes', () => {
  it('normalizeSchemes 容错解析：非数组→空、坏条目丢弃、非法字段剔除、缺 createdAt 兜底 0', () => {
    expect(normalizeSchemes('nope')).toEqual([])
    expect(normalizeSchemes(null)).toEqual([])
    expect(normalizeSchemes(42)).toEqual([])
    expect(normalizeSchemes({})).toEqual([])
    const raw = [
      'junk', // 非对象
      null, // null
      { id: '', name: 'x', mapping: { secret: { path: 'a' } }, createdAt: 1 }, // 空 id
      { id: 'a', name: '', mapping: { secret: { path: 'a' } }, createdAt: 1 }, // 空 name
      { id: 'b', name: 'x', mapping: { secret: { path: '' } }, createdAt: 1 }, // secret.path 空
      { id: 'c', name: 'x', mapping: { secret: 'nope' }, createdAt: 1 }, // secret 非 FieldMap
      { id: 'd', name: 'x', createdAt: 1 }, // 缺 mapping
      // 合法： issuer 非法剔除、rowsPath 非法剔除、transform 非法剔除；已知值 none/uppercaseSecret 保留
      { id: 'ok', name: '好', rowsPath: 'data.items', createdAt: 5, mapping: { secret: { path: 's' }, issuer: 'x', label: { path: 'l', transform: 'bogus' } } },
      { id: 'ok2', name: '无时间', mapping: { secret: { path: 's2', transform: 'uppercaseSecret' } } }, // 缺 createdAt
      { id: 'ok3', name: '小写', mapping: { secret: { path: 's3', transform: 'none' } } },
    ]
    expect(normalizeSchemes(raw)).toEqual([
      { id: 'ok', name: '好', rowsPath: 'data.items', mapping: { secret: { path: 's' }, label: { path: 'l' } }, createdAt: 5 },
      { id: 'ok2', name: '无时间', mapping: { secret: { path: 's2', transform: 'uppercaseSecret' } }, createdAt: 0 },
      { id: 'ok3', name: '小写', mapping: { secret: { path: 's3', transform: 'none' } }, createdAt: 0 },
    ])
    expect(SCHEMES_KEY).toBe('importSchemes')
  })

  it('normalizeSchemes 去重：同 id 保留首个，空数组→空、合法条目原样保留', () => {
    const s = mk({ rowsPath: 'rows' })
    expect(normalizeSchemes([])).toEqual([])
    expect(normalizeSchemes([s, s])).toEqual([s])
    expect(normalizeSchemes([s, mk({ name: '同名不同 id', id: 's2' })])).toEqual([s, mk({ name: '同名不同 id', id: 's2' })])
    const first = mk({ id: 'dup', name: 'first' })
    const second = mk({ id: 'dup', name: 'second', createdAt: 9 })
    expect(normalizeSchemes([first, second])).toEqual([first])
  })

  it('upsertScheme 同 id 覆盖（原位替换、长度不变），新 id 追加尾部；空数组可插入', () => {
    const a = mk({ id: 'a', name: 'A' })
    const b = mk({ id: 'b', name: 'B' })
    const list = upsertScheme([a, b], mk({ id: 'a', name: 'A2', createdAt: 2 }))
    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({ id: 'a', name: 'A2', mapping: a.mapping, createdAt: 2 })
    expect(list[1]).toBe(b)
    const added = mk({ id: 'c' })
    expect(upsertScheme([a], added)).toEqual([a, added])
    expect(upsertScheme([], a)).toEqual([a])
  })

  it('removeScheme 删除指定 id，其余保留；空数组/不存在 id 原样', () => {
    const a = mk({ id: 'a' })
    const b = mk({ id: 'b' })
    expect(removeScheme([a, b], 'a')).toEqual([b])
    expect(removeScheme([], 'a')).toEqual([])
    expect(removeScheme([a], 'zz')).toEqual([a])
  })

  it('matchSchemes：mapping 路径首段与 sampleKeys 交集数>0 才入选，按交集数降序，最多取 3', () => {
    const s0 = mk({ id: 'zero', mapping: { secret: { path: 'unrelated.secret' } } })
    const s1 = mk({ id: 'one', mapping: { secret: { path: 'key' }, issuer: { path: 'missing.issuer' } } }) // 交集 1
    const s3 = mk({ id: 'three', mapping: { secret: { path: 'a.s' }, issuer: { path: 'b.i' }, label: { path: 'c.l' } } }) // 交集 3
    const s2 = mk({ id: 'two', mapping: { secret: { path: 'a.s' }, issuer: { path: 'b.i' } } }) // 交集 2
    const s4 = mk({ id: 'four', mapping: { secret: { path: 'a.1' }, issuer: { path: 'b.2' }, label: { path: 'c.3' }, note: { path: 'd.4' } } }) // 交集 4，应被截断
    const keys = ['a', 'b', 'c', 'd', 'key']
    expect(matchSchemes([s0, s4, s1, s3, s2], keys)).toEqual([s4, s3, s2])
    expect(matchSchemes([s1, s0], keys)).toEqual([s1])
  })

  it('空输入：matchSchemes 空方案表或空 keys→空', () => {
    expect(matchSchemes([], ['a'])).toEqual([])
    expect(matchSchemes([mk()], [])).toEqual([])
  })

  it('I22：rowsPath 字段在 upsert 与 normalize 往返中保留', () => {
    const a = mk({ id: 'a', rowsPath: 'data.items' })
    const b = mk({ id: 'b' })
    // upsert 同 id 覆盖保留 rowsPath
    const updated = upsertScheme([a, b], { ...a, rowsPath: 'data.entries' })
    expect(updated[0]).toMatchObject({ id: 'a', rowsPath: 'data.entries' })
    // 归一化合法 rowsPath 保留
    expect(normalizeSchemes([a, b])).toEqual([
      { id: 'a', name: '方案一', rowsPath: 'data.items', mapping: a.mapping, createdAt: 1000 },
      { id: 'b', name: '方案一', mapping: a.mapping, createdAt: 1000 },
    ])
  })

  it('transform 契约端到端：方案保存→normalizeSchemes 读取→mapRowToEntry 按已存 transform 生效', () => {
    const [none] = normalizeSchemes([{ id: 'n', name: 'N', mapping: { secret: { path: 's', transform: 'none' } }, createdAt: 1 }])
    expect(mapRowToEntry({ s: ' jbsw y3dp ' }, none!.mapping)).toMatchObject({ secret: 'jbswy3dp' })
    const [upper] = normalizeSchemes([{ id: 'u', name: 'U', mapping: { secret: { path: 's' } }, createdAt: 1 }])
    expect(mapRowToEntry({ s: ' jbsw y3dp ' }, upper!.mapping)).toMatchObject({ secret: 'JBSWY3DP' })
  })

  it('mapping.defaults 合法对象保留（非法/缺失不产出 defaults 键）；matchSchemes 按映射字段首段参与打分', () => {
    const [kept] = normalizeSchemes([
      { id: 'd1', name: '带 defaults', mapping: { secret: { path: 's' }, defaults: { issuer: '默认发行方', digits: 8 } }, createdAt: 1 },
    ])
    expect(kept!.mapping.defaults).toEqual({ issuer: '默认发行方', digits: 8 })
    // matchSchemes：issuer/label 映射字段的首段参与与 sampleKeys 的交集计数
    const withFields = mk({ id: 'f', mapping: { secret: { path: 'otp.secret' }, issuer: { path: 'otp.issuer' }, note: { path: 'memo.text' } } })
    expect(matchSchemes([withFields], ['otp', 'memo'])).toEqual([withFields])
    expect(matchSchemes([withFields], ['unrelated'])).toEqual([])
  })
})
