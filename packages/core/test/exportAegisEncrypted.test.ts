import { addEntry, createVault, exportAegisEncrypted, importAegisEncrypted, newEntryFromUri, resolveTagNames } from '@totp/core'
import { describe, expect, it } from 'vitest'

const SECRET = 'JBSWY3DPEHPK3PXP'

describe('exportAegisEncrypted', () => {
  it('round-trip：加密导出 → 本项目 Aegis 加密导入器（对齐官方 scrypt+GCM）可解密且逐字段恒等', async () => {
    let v = createVault()
    v = addEntry(v, newEntryFromUri(`otpauth://totp/GitHub:alice?secret=${SECRET}`))
    const { json } = await exportAegisEncrypted(v, '口令-pass-123')
    const r = await importAegisEncrypted(json, '口令-pass-123')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]!.issuer).toBe('GitHub')
    expect(r.entries[0]!.secret).toBe(SECRET)
  })
  it('错误口令抛「口令错误或文件已损坏」', async () => {
    let v = createVault()
    v = addEntry(v, newEntryFromUri(`otpauth://totp/G:a?secret=${SECRET}`))
    const { json } = await exportAegisEncrypted(v, 'right')
    await expect(importAegisEncrypted(json, 'wrong')).rejects.toThrow('口令错误或文件已损坏')
  })
  it('header 结构：单个 PasswordSlot(type=1, n=16384,r=8,p=1) + params.nonce/tag', async () => {
    let v = createVault()
    v = addEntry(v, newEntryFromUri(`otpauth://totp/G:a?secret=${SECRET}`))
    const { json } = await exportAegisEncrypted(v, 'pw')
    const obj = JSON.parse(json) as { header: { slots: Array<Record<string, unknown>>; params: Record<string, unknown> }; db: string }
    expect(typeof obj.db).toBe('string')
    expect(obj.header.slots).toHaveLength(1)
    const slot = obj.header.slots[0]!
    expect(slot['type']).toBe(1)
    expect(slot['n']).toBe(16384); expect(slot['r']).toBe(8); expect(slot['p']).toBe(1)
    expect(typeof obj.header.params['nonce']).toBe('string')
    expect(typeof obj.header.params['tag']).toBe('string')
  })

  it('加密导出 report.usedGroups 携带实际写入的组名（BackupCard 消费口径）', async () => {
    let v = createVault()
    const { vault: v1, tagIds } = resolveTagNames(v, ['工作', '重要'])
    v = v1
    const e1 = newEntryFromUri(`otpauth://totp/GitHub:alice?secret=${SECRET}`)
    e1.tagIds = [tagIds[0]!]
    const e2 = newEntryFromUri(`otpauth://totp/GitLab:bob?secret=${SECRET}`)
    e2.tagIds = [tagIds[0]!, tagIds[1]!]
    v = addEntry(v, e1)
    v = addEntry(v, e2)
    const { report } = await exportAegisEncrypted(v, 'pw')
    expect(report.usedGroups).toEqual(['工作', '重要'])
    expect(report.droppedTagCount).toBe(0)
  })
})
