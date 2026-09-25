import { describe, expect, it } from 'vitest'
import { canonicalJson, contentHash } from '../src/cloud/canonical'

describe('canonicalJson', () => {
  it('键序无关：相同对象不同插入序产出同一字符串', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })
  it('数组保持顺序（条目 order 语义）', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
  it('undefined 字段与缺失等价', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })
  it('标量与 null：原样 JSON 序列化（null ≠ 缺失 ≠ "null" 字符串）', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(undefined)).toBe('null') // JSON.stringify(undefined)=undefined → 'null' 兜底
    expect(canonicalJson(42)).toBe('42')
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(true)).toBe('true')
    // null 作为值保留（不与 undefined 剔除语义混淆）
    expect(canonicalJson({ a: null })).toBe('{"a":null}')
  })
})

describe('contentHash', () => {
  it('键序抖动不改变 hash（消除随机 IV/键序影响）', async () => {
    const a = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 1 })
    const b = JSON.stringify({ updatedAt: 1, tags: [], entries: [], version: 2 })
    expect(await contentHash(a)).toBe(await contentHash(b))
  })
  it('内容不同 hash 不同', async () => {
    expect(await contentHash('{"a":1}')).not.toBe(await contentHash('{"a":2}'))
  })
})
