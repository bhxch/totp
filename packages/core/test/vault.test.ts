import { describe, expect, it } from 'vitest'
import { createVault, addEntry, removeEntry, updateEntry, addTag, renameTag, removeTag, ensureTag, reorderEntries, newEntryFromUri } from '../src/vault'
import type { OtpEntry } from '../src/model'

const mkEntry = (uuid: string, order = 0): OtpEntry => ({
  uuid, type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order, createdAt: 0,
})

describe('vault 操作', () => {
  it('新建 vault 为 version 2 且带 tags 数组', () => {
    const v = createVault()
    expect(v.version).toBe(2)
    expect(v.tags).toEqual([])
    expect(v.entries).toEqual([])
  })

  it('add/remove/update entry 返回新对象且不改入参', () => {
    const v0 = createVault()
    const v1 = addEntry(v0, mkEntry('a'))
    expect(v1.entries).toHaveLength(1)
    expect(v0.entries).toHaveLength(0)
    const v2 = updateEntry(v1, 'a', { issuer: 'GitLab' })
    expect(v2.entries[0]!.issuer).toBe('GitLab')
    expect(v1.entries[0]!.issuer).toBe('GitHub')
    const v3 = removeEntry(v2, 'a')
    expect(v3.entries).toHaveLength(0)
  })

  it('renameTag 返回新对象且只改目标 tag 名，原 vault 不变', () => {
    const v0 = createVault()
    const r1 = addTag(v0, '旧名')
    const tid = r1.tagId
    const v2 = renameTag(r1.vault, tid, '新名')
    expect(v2.tags[0]!.name).toBe('新名')
    expect(v2).not.toBe(r1.vault)
    expect(r1.vault.tags[0]!.name).toBe('旧名')
    expect(v0.tags).toHaveLength(0)
  })

  it('addTag 同名（trim + 大小写不敏感）幂等复用，不建第二个', () => {
    let v = createVault()
    const r1 = addTag(v, '工作')
    v = r1.vault
    const r2 = addTag(v, ' 工作 ')
    expect(r2.vault).toBe(v)
    expect(r2.tagId).toBe(r1.tagId)
    const r3 = addTag(v, '工作'.toUpperCase())
    expect(r3.tagId).toBe(r1.tagId)
    expect(v.tags).toHaveLength(1)
    // ensureTag 为 addTag 别名（同一实现，导入/表单路径语义名）
    expect(ensureTag).toBe(addTag)
  })

  it('removeTag：tag 移除且条目 tagIds 引用被清理', () => {
    let v = createVault()
    const r = addTag(v, '工作')
    v = r.vault
    v = addEntry(v, { ...mkEntry('a'), tagIds: [r.tagId] })
    v = removeTag(v, r.tagId)
    expect(v.tags).toHaveLength(0)
    expect(v.entries[0]!.tagIds).toEqual([])
  })

  it('reorder 按 uuid 序列重排 order', () => {
    let v = createVault()
    v = addEntry(v, mkEntry('a', 0))
    v = addEntry(v, mkEntry('b', 1))
    v = addEntry(v, mkEntry('c', 2))
    v = reorderEntries(v, ['c', 'a', 'b'])
    expect(v.entries.find((e) => e.uuid === 'c')!.order).toBe(0)
    expect(v.entries.find((e) => e.uuid === 'a')!.order).toBe(1)
    expect(v.entries.find((e) => e.uuid === 'b')!.order).toBe(2)
  })

  it('newEntryFromUri 解析 otpauth 并补默认值（tagIds 为空数组）', () => {
    const e = newEntryFromUri('otpauth://totp/GitHub:me%40ex.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub', 1700000000000)
    expect(e.issuer).toBe('GitHub')
    expect(e.period).toBe(30)
    expect(e.tagIds).toEqual([])
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/)
  })
})
