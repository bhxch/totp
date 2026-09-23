import { describe, expect, it } from 'vitest'
import { mergeVaults } from '../src/merge/vaultMerge'
import type { OtpEntry, Vault } from '../src/model'

function entry(p: Partial<OtpEntry> & { uuid: string }): OtpEntry {
  return { type: 'totp', issuer: 'I', label: p.uuid, secret: 'S', algorithm: 'SHA1', digits: 6, period: 30,
    tagIds: [], order: 0, createdAt: 1, updatedAt: 1, ...p }
}
/** legacy 条目：去掉 updatedAt（=旧数据无时间戳，裁决按 0 处理） */
const legacy = (e: OtpEntry): OtpEntry => {
  const { updatedAt: _updatedAt, ...rest } = e
  return rest
}
/** 键插入序完全反转的同内容条目（审查 Minor：模拟跨设备/跨版本序列化键序差异） */
function reversedEntry(e: OtpEntry): OtpEntry {
  const out: Record<string, unknown> = {}
  for (const k of (Object.keys(e) as (keyof OtpEntry)[]).reverse()) out[k] = e[k]
  return out as unknown as OtpEntry
}
function vault(entries: OtpEntry[], updatedAt = 1): Vault {
  return { version: 2, entries, tags: [], updatedAt }
}

describe('mergeVaults', () => {
  it('仅一方改/增 → 采纳该方', () => {
    const base = vault([entry({ uuid: 'a', label: 'old' })])
    const ours = vault([entry({ uuid: 'a', label: 'old' }), entry({ uuid: 'b', label: 'new-ours' })])
    const theirs = vault([entry({ uuid: 'a', label: 'renamed' })])
    const r = mergeVaults(base, ours, theirs)
    expect(r.conflicts).toEqual([])
    expect(r.vault.entries.map((e) => e.uuid).sort()).toEqual(['a', 'b'])
    expect(r.vault.entries.find((e) => e.uuid === 'a')!.label).toBe('renamed')
  })
  it('双方同改同值 → 任取无冲突', () => {
    const base = vault([entry({ uuid: 'a', label: 'old' })])
    const r = mergeVaults(base, vault([entry({ uuid: 'a', label: 'same' })]), vault([entry({ uuid: 'a', label: 'same' })]))
    expect(r.conflicts).toEqual([])
    expect(r.vault.entries[0]!.label).toBe('same')
  })
  it('条目相等比较键序无关（审查 Minor）：同内容不同键插入序不误判冲突/双方修改', () => {
    const base = vault([entry({ uuid: 'a', label: 'old', updatedAt: 1 })])
    // 双方一致但键序不同：不得产生冲突记录
    const same = entry({ uuid: 'a', label: 'same', updatedAt: 5 })
    const r = mergeVaults(base, vault([same]), vault([reversedEntry(same)]))
    expect(r.conflicts).toEqual([])
    expect(r.vault.entries[0]!.label).toBe('same')
    // 本方未动但键序与 base 不同、云方改：取云方，不得误判「双方修改」
    const untouched = reversedEntry(entry({ uuid: 'a', label: 'old', updatedAt: 1 }))
    const r2 = mergeVaults(base, vault([untouched]), vault([entry({ uuid: 'a', label: 'renamed', updatedAt: 9 })]))
    expect(r2.conflicts).toEqual([])
    expect(r2.vault.entries[0]!.label).toBe('renamed')
  })
  it('一方删另一方未动 → 删除生效', () => {
    const base = vault([entry({ uuid: 'a' }), entry({ uuid: 'b' })])
    const r = mergeVaults(base, vault([entry({ uuid: 'a' })]), vault([entry({ uuid: 'a' }), entry({ uuid: 'b' })]))
    expect(r.vault.entries.map((e) => e.uuid)).toEqual(['a'])
  })
  it('一方删另一方改 → 保留修改 + 冲突记录', () => {
    const base = vault([entry({ uuid: 'a', label: 'old' })])
    const ours = vault([]) // 本方删除
    const theirs = vault([entry({ uuid: 'a', label: 'edited' })])
    const r = mergeVaults(base, ours, theirs)
    expect(r.vault.entries.map((e) => e.uuid)).toEqual(['a'])
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0]!.ours).toBeNull()
    expect(r.conflicts[0]!.theirs!.label).toBe('edited')
  })
  it('双方改成不同内容 → updatedAt 新者为主体，另一方入冲突', () => {
    const base = vault([entry({ uuid: 'a', label: 'old', updatedAt: 1 })])
    const ours = vault([entry({ uuid: 'a', label: 'ours-new', updatedAt: 100 })])
    const theirs = vault([entry({ uuid: 'a', label: 'theirs-new', updatedAt: 200 })])
    const r = mergeVaults(base, ours, theirs)
    expect(r.vault.entries[0]!.label).toBe('theirs-new')
    expect(r.conflicts[0]!.ours!.label).toBe('ours-new')
  })
  it('双方改成不同内容 → ours 新者胜（方向反转）', () => {
    const base = vault([entry({ uuid: 'a', label: 'old', updatedAt: 1 })])
    const r = mergeVaults(
      base,
      vault([entry({ uuid: 'a', label: 'ours-newer', updatedAt: 200 })]),
      vault([entry({ uuid: 'a', label: 'theirs-older', updatedAt: 100 })]),
    )
    expect(r.vault.entries[0]!.label).toBe('ours-newer')
    expect(r.conflicts[0]!.theirs!.label).toBe('theirs-older')
  })
  it('删改对撞豁免 tie：ours 删 + theirs 改（theirs 无 updatedAt）→ 保留 theirs', () => {
    const base = vault([entry({ uuid: 'a', label: 'old', updatedAt: 1 })])
    const r = mergeVaults(base, vault([]), vault([legacy(entry({ uuid: 'a', label: 'edited' }))]))
    expect(r.vault.entries.map((e) => e.uuid)).toEqual(['a'])
    expect(r.vault.entries[0]!.label).toBe('edited')
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0]!.ours).toBeNull()
    expect(r.conflicts[0]!.theirs!.label).toBe('edited')
  })
  it('删改对撞豁免 tie：theirs 删 + ours 改（ours 无 updatedAt）→ 保留 ours', () => {
    const base = vault([entry({ uuid: 'a', label: 'old', updatedAt: 1 })])
    const r = mergeVaults(base, vault([legacy(entry({ uuid: 'a', label: 'edited' }))]), vault([]))
    expect(r.vault.entries.map((e) => e.uuid)).toEqual(['a'])
    expect(r.vault.entries[0]!.label).toBe('edited')
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0]!.ours!.label).toBe('edited')
    expect(r.conflicts[0]!.theirs).toBeNull()
  })
  it('双方增同 id 不同内容 → 冲突，tie 时云端为主体', () => {
    const ours = vault([entry({ uuid: 'x', label: 'o', updatedAt: 10 })])
    const theirs = vault([entry({ uuid: 'x', label: 't', updatedAt: 10 })])
    const r = mergeVaults(null, ours, theirs)
    expect(r.vault.entries[0]!.label).toBe('t')
    expect(r.conflicts).toHaveLength(1)
  })
  it('base=null 降级两方合并：并集 + 同 id 冲突取新者，degraded=true', () => {
    const ours = vault([entry({ uuid: 'a', label: 'o', updatedAt: 5 }), entry({ uuid: 'only-ours' })])
    const theirs = vault([entry({ uuid: 'a', label: 't', updatedAt: 9 }), entry({ uuid: 'only-theirs' })])
    const r = mergeVaults(null, ours, theirs)
    expect(r.degraded).toBe(true)
    expect(r.vault.entries.map((e) => e.uuid).sort()).toEqual(['a', 'only-ours', 'only-theirs'])
    expect(r.vault.entries.find((e) => e.uuid === 'a')!.label).toBe('t')
  })
  it('vault.updatedAt 取两侧较大值', () => {
    const r = mergeVaults(vault([], 1), vault([entry({ uuid: 'n' })], 50), vault([], 30))
    expect(r.vault.updatedAt).toBe(50)
  })
})
