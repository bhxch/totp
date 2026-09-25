import { describe, expect, it } from 'vitest'
import { applyImport, findConflicts, newEntryFromParsed } from '../src/import/conflict'
import type { ParsedEntry } from '../src/import/types'
import { addEntry, addTag, createVault, newEntryFromUri, updateEntry } from '../src/vault'

const p = (issuer: string, label: string): ParsedEntry => ({
  type: 'totp', issuer, label, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30,
})

describe('findConflicts', () => {
  it('issuer+label 相同（大小写不敏感）判冲突', () => {
    const existing = [newEntryFromUri('otpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP', 0)]
    const idx = findConflicts(existing, [p('github', 'ME@X.COM'), p('GitLab', 'me@x.com')])
    expect([...idx]).toEqual([0])
  })
})

describe('applyImport', () => {
  const mkVault = () => {
    let v = createVault()
    v = addEntry(v, newEntryFromUri('otpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP', 0))
    return v
  }
  const incoming = [p('GitHub', 'me@x.com'), p('New', 'a@b.c')]
  it('skip：冲突条目不动，非冲突新增', () => {
    const v = applyImport(mkVault(), incoming, 'skip', findConflicts(mkVault(), incoming))
    expect(v.entries).toHaveLength(2)
    expect(v.entries.find((e) => e.issuer === 'New')).toBeDefined()
  })
  it('replace：冲突条目被覆盖（保留 uuid），非冲突新增', () => {
    const v0 = mkVault()
    const v = applyImport(v0, incoming, 'replace', findConflicts(v0, incoming))
    expect(v.entries).toHaveLength(2)
    const gh = v.entries.find((e) => e.issuer === 'GitHub')!
    expect(gh.uuid).toBe(v0.entries[0]!.uuid)
  })
  it('merge：冲突条目并存新增', () => {
    const v = applyImport(mkVault(), incoming, 'merge', findConflicts(mkVault(), incoming))
    expect(v.entries).toHaveLength(3)
  })
  it('新增条目 order 递增、createdAt>0', () => {
    const v = applyImport(createVault(), incoming, 'skip', new Set())
    expect(v.entries.map((e) => e.order)).toEqual([0, 1])
    expect(v.entries.every((e) => e.createdAt > 0)).toBe(true)
  })

  it('replace：解析结果未提供 note/counter 时，保留现有条目上的 note/counter（HOTP 计数与用户笔记不被静默清空）', () => {
    // 起点：HOTP 条目已有 counter=42 与 note='重要账号'
    let v = createVault()
    const hotpUri = 'otpauth://hotp/Api:token?secret=JBSWY3DPEHPK3PXP&counter=42'
    v = addEntry(v, { ...newEntryFromUri(hotpUri, 0), note: '重要账号' })
    const existing = v.entries[0]!
    // 解析结果只有基础字段，无 counter/note
    const incomingNoMeta: ParsedEntry[] = [
      { type: 'hotp', issuer: 'Api', label: 'token', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
    ]
    const after = applyImport(v, incomingNoMeta, 'replace', new Set([0]))
    const updated = after.entries.find((e) => e.uuid === existing.uuid)!
    expect(updated.counter).toBe(42) // 保留本地 HOTP 计数
    expect(updated.note).toBe('重要账号') // 保留用户笔记
    // 反向断言：解析结果显式带 note/counter 时仍会被采用
    const incomingWithMeta: ParsedEntry[] = [
      {
        type: 'hotp', issuer: 'Api', label: 'token', secret: 'JBSWY3DPEHPK3PXP',
        algorithm: 'SHA1', digits: 6, period: 30, counter: 99, note: '从备份恢复',
      },
    ]
    const after2 = applyImport(v, incomingWithMeta, 'replace', new Set([0]))
    const updated2 = after2.entries.find((e) => e.uuid === existing.uuid)!
    expect(updated2.counter).toBe(99)
    expect(updated2.note).toBe('从备份恢复')
  })
})

describe('导入 tags 落地（spec §4）', () => {
  const mkParsed = (issuer: string, label: string, tags?: string[]): ParsedEntry => ({
    type: 'totp', issuer, label, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30,
    ...(tags ? { tags } : {}),
  })

  it('新增条目携带 tags 并自动建入 vault.tags（同名复用）', () => {
    let v = createVault()
    const r = addTag(v, '工作')
    v = r.vault
    v = applyImport(v, [mkParsed('A', 'a', [' 工作 ', '个人'])], 'skip', new Set())
    expect(v.tags.map((t) => t.name).sort()).toEqual(['个人', '工作'])
    expect(v.entries[0]!.tagIds).toHaveLength(2)
  })

  it('批内重名 tag（trim 等价）去重：tagIds 唯一且复用现有 id', () => {
    let v = createVault()
    const r = addTag(v, '工作')
    v = r.vault
    v = applyImport(v, [mkParsed('A', 'a', ['工作', ' 工作 '])], 'skip', new Set())
    expect(v.entries[0]!.tagIds).toEqual([r.tagId])
    expect(v.tags).toHaveLength(1)
  })

  it('conflict replace：tags 取现有∪导入并集', () => {
    let v = createVault()
    const r = addTag(v, '旧标签')
    v = r.vault
    v = addEntry(v, newEntryFromParsed(mkParsed('A', 'a'), 'u1', 1))
    v = updateEntry(v, 'u1', { tagIds: [r.tagId] })
    const idx = findConflicts(v, [mkParsed('A', 'a', ['导入标签'])])
    v = applyImport(v, [mkParsed('A', 'a', ['导入标签'])], 'replace', idx)
    expect(v.entries[0]!.tagIds).toHaveLength(2)
    expect(v.tags).toHaveLength(2)
  })

  it('conflict skip：不动（tagIds 原样）', () => {
    let v = createVault()
    v = addEntry(v, { ...newEntryFromParsed(mkParsed('A', 'a'), 'u1', 1), tagIds: ['t9'] })
    const idx = findConflicts(v, [mkParsed('A', 'a', ['x'])])
    v = applyImport(v, [mkParsed('A', 'a', ['x'])], 'skip', idx)
    expect(v.entries[0]!.tagIds).toEqual(['t9'])
    expect(v.tags).toHaveLength(0)
  })

  it('空白 tag 名逐个跳过（spec §4：空白不入 tags 表）', () => {
    let v = createVault()
    v = applyImport(v, [mkParsed('A', 'a', ['  ', '', '工作'])], 'skip', new Set())
    expect(v.tags.map((t) => t.name)).toEqual(['工作'])
    expect(v.entries[0]!.tagIds).toHaveLength(1)
  })

  it('replace：conflictIdx 指向的下标已无匹配现有条目（悬空 idx）→ 跳过不新增', () => {
    let v = createVault()
    v = addEntry(v, newEntryFromUri('otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP', 0))
    // 手工传入与现有条目 issuer+label 均不匹配的悬空冲突位
    v = applyImport(v, [p('Ghost', 'nowhere')], 'replace', new Set([0]))
    expect(v.entries).toHaveLength(1)
    expect(v.entries[0]!.issuer).toBe('GitHub')
  })

  it('新增路径携带 counter/note/pin（yandex）：newEntryFromParsed 全字段落地', () => {
    const parsed: ParsedEntry = {
      type: 'yandex', issuer: 'Yandex', label: 'user', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256', digits: 8, period: 30, counter: 3, note: '备注', pin: '1234',
    }
    const v = applyImport(createVault(), [parsed], 'skip', new Set())
    expect(v.entries[0]).toMatchObject({ type: 'yandex', counter: 3, note: '备注', pin: '1234', digits: 8 })
  })

  it('replace：yandex 条目 pin 显式覆盖（新值替换旧值；无 pin 清除残留）', () => {
    const mkYandex = (pin?: string): ParsedEntry => ({
      type: 'yandex', issuer: 'Yandex', label: 'user', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 8, period: 30, ...(pin !== undefined ? { pin } : {}),
    })
    let v = createVault()
    v = addEntry(v, newEntryFromParsed(mkYandex('0000'), 'u1', 1))
    v = applyImport(v, [mkYandex('9999')], 'replace', new Set([0]))
    expect(v.entries[0]!.pin).toBe('9999')
    // 导入结果无 pin → 清除（parsedPatch 显式写 undefined），避免旧 pin 残留导致算码错误
    v = applyImport(v, [mkYandex()], 'replace', new Set([0]))
    expect(v.entries[0]!.pin).toBeUndefined()
  })
})
