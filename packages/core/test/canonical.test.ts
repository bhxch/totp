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
