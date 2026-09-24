// mini 列表排序单测（node 环境纯函数）：pinned 优先 → order 升序，对齐 CodesPage.vue 口径
import { describe, expect, it } from 'vitest'
import type { OtpEntry } from '@totp/core'
import { sortMiniEntries } from './miniSort'

function entry(partial: Partial<OtpEntry> & { uuid: string }): OtpEntry {
  return {
    type: 'totp', issuer: 'I', label: 'L', secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    ...partial,
  } as OtpEntry
}

describe('sortMiniEntries（pinned 优先 → order）', () => {
  it('pinned 条目排前，组内按 order 升序；不改动原数组', () => {
    const a = entry({ uuid: 'a', order: 2 })
    const b = entry({ uuid: 'b', order: 1, pinned: true })
    const c = entry({ uuid: 'c', order: 0 })
    const src = [a, b, c]
    expect(sortMiniEntries(src).map((e) => e.uuid)).toEqual(['b', 'c', 'a'])
    expect(src.map((e) => e.uuid)).toEqual(['a', 'b', 'c']) // 复制排序，原数组不变
  })

  it('pinned 用 truthy 检查：无 pinned 字段的旧 vault 条目视为未置顶', () => {
    const legacy = entry({ uuid: 'legacy', order: 0 }) // 不带 pinned 字段
    const pinned = entry({ uuid: 'pinned', order: 5, pinned: true })
    expect('pinned' in legacy).toBe(false)
    expect(sortMiniEntries([legacy, pinned]).map((e) => e.uuid)).toEqual(['pinned', 'legacy'])
  })

  it('全未置顶：纯 order 升序（旧行为回归）', () => {
    const list = [entry({ uuid: 'x', order: 3 }), entry({ uuid: 'y', order: 1 }), entry({ uuid: 'z', order: 2 })]
    expect(sortMiniEntries(list).map((e) => e.uuid)).toEqual(['y', 'z', 'x'])
  })
})
