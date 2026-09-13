import { describe, expect, it } from 'vitest'
import { createVault, addEntry, removeEntry, updateEntry, addGroup, renameGroup, removeGroup, reorderEntries, newEntryFromUri } from '../src/vault'
import type { OtpEntry } from '../src/model'

const mkEntry = (uuid: string, order = 0): OtpEntry => ({
  uuid, type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order, createdAt: 0,
})

describe('vault 操作', () => {
  it('add/remove/update 返回新对象且不改入参', () => {
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

  it('renameGroup 返回新对象且只改目标分组名，原 vault 不变', () => {
    const v0 = createVault()
    const v1 = addGroup(v0, '旧名')
    const gid = v1.groups[0]!.id
    const v2 = renameGroup(v1, gid, '新名')
    expect(v2.groups[0]!.name).toBe('新名')
    expect(v2).not.toBe(v1)
    expect(v1.groups[0]!.name).toBe('旧名')
    expect(v0.groups).toHaveLength(0)
  })

  it('分组：加入、移除时条目引用被清理', () => {
    let v = addGroup(createVault(), '工作')
    const gid = v.groups[0]!.id
    v = addEntry(v, { ...mkEntry('a'), groupIds: [gid] })
    v = removeGroup(v, gid)
    expect(v.groups).toHaveLength(0)
    expect(v.entries[0]!.groupIds).toEqual([])
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

  it('newEntryFromUri 解析 otpauth 并补默认值', () => {
    const e = newEntryFromUri('otpauth://totp/GitHub:me%40ex.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub', 1700000000000)
    expect(e.issuer).toBe('GitHub')
    expect(e.period).toBe(30)
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/)
  })
})
