import { describe, expect, it } from 'vitest'
import { canonicalJson, contentHashVault } from '../src/cloud/canonical'

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

// R15②：contentHash（含 rev 旧口径）已 @deprecated 仅测试，通用语义用例迁同步链路统一口径
// contentHashVault（本组用例 vault 均无顶层 rev，两口径值恒等，断言语义不变）
describe('contentHashVault', () => {
  it('键序抖动不改变 hash（消除随机 IV/键序影响）', async () => {
    const a = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 1 })
    const b = JSON.stringify({ updatedAt: 1, tags: [], entries: [], version: 2 })
    expect(await contentHashVault(a)).toBe(await contentHashVault(b))
  })
  it('内容不同 hash 不同', async () => {
    expect(await contentHashVault('{"a":1}')).not.toBe(await contentHashVault('{"a":2}'))
  })
})
