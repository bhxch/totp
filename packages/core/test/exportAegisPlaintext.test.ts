import { addEntry, createVault, exportAegisPlaintext, importAegisPlaintext, newEntryFromUri, resolveTagNames } from '@totp/core'
import { describe, expect, it, vi } from 'vitest'

describe('exportAegisPlaintext', () => {
  it('round-trip：导出 → 本项目 Aegis 明文导入器逐字段恒等', () => {
    const e1 = newEntryFromUri('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60')
    const e2 = newEntryFromUri('otpauth://hotp/Repo:bob?secret=JBSWY3DPEHPK3PXP&counter=3')
    const e3 = newEntryFromUri('otpauth://steam/Steam:carol?secret=JBSWY3DPEHPK3PXP')
    let v = createVault()
    for (const e of [e1, e2, e3]) v = addEntry(v, e)
    const { json } = exportAegisPlaintext(v)
    const r = importAegisPlaintext(json)
    expect(r.failures).toEqual([])
    expect(r.entries.map((x) => [x.type, x.issuer, x.label, x.secret, x.algorithm, x.digits, x.period])).toEqual([
      ['totp', 'GitHub', 'alice', 'JBSWY3DPEHPK3PXP', 'SHA256', 8, 60],
      ['hotp', 'Repo', 'bob', 'JBSWY3DPEHPK3PXP', 'SHA1', 6, 30],
      ['steam', 'Steam', 'carol', 'JBSWY3DPEHPK3PXP', 'SHA1', 5, 30],
    ])
    expect(r.entries[1]!.counter).toBe(3)
  })
  it('多标签条目：全部标签写 entry.groups 数组（官方多标签语义保留），round-trip 回全部标签', () => {
    const e = newEntryFromUri('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP')
    let v = createVault()
    const { vault: v1, tagIds } = resolveTagNames(v, ['工作', '重要']) // 两个 tag
    v = v1
    e.tagIds = [tagIds[0]!, tagIds[1]!]
    v = addEntry(v, e)
    const { json, report } = exportAegisPlaintext(v)
    // 官方可读形态：groups 数组长度 = 标签数
    const obj = JSON.parse(json) as { db: { entries: Array<Record<string, unknown>> } }
    expect(obj.db.entries[0]!['groups']).toHaveLength(2)
    expect(report.droppedTagCount).toBe(0) // groups 数组支持多标签后不再丢标签
    const r = importAegisPlaintext(json)
    expect(r.entries[0]!.tags).toEqual(['工作', '重要'])
  })
  it('同名组共享 uuid；db.groups 表 [{uuid,name}] 与 entry.groups 引用一致；不写 groupid（官方从无该字段）', () => {
    let v = createVault()
    const { vault: v1, tagIds } = resolveTagNames(v, ['工作'])
    v = v1
    const e1 = newEntryFromUri('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP')
    const e2 = newEntryFromUri('otpauth://totp/GitLab:bob?secret=JBSWY3DPEHPK3PXP')
    e1.tagIds = [tagIds[0]!]
    e2.tagIds = [tagIds[0]!]
    v = addEntry(v, e1)
    v = addEntry(v, e2)
    const obj = JSON.parse(exportAegisPlaintext(v).json) as {
      db: { entries: Array<Record<string, unknown>>; groups: Array<{ uuid: string; name: string }> }
    }
    expect(obj.db.groups).toEqual([{ uuid: expect.any(String), name: '工作' }])
    expect(obj.db.entries[0]!['groups']).toEqual(obj.db.entries[1]!['groups'])
    expect((obj.db.entries[0]!['groups'] as string[])[0]).toBe(obj.db.groups[0]!.uuid)
    expect('groupid' in obj.db.entries[0]!).toBe(false)
  })
  it('C1：空 issuer 条目导出恒写 issuer/note 字段（官方 fromJson 用 getString("issuer")，字段缺失整条导入失败）', () => {
    const e = newEntryFromUri('otpauth://totp/Gen:alice?secret=JBSWY3DPEHPK3PXP')
    e.issuer = '' // 空 issuer 条目（导入侧 name 前缀回退不影响导出口径）
    const v = addEntry(createVault(), e)
    const entry = (JSON.parse(exportAegisPlaintext(v).json) as { db: { entries: Array<Record<string, unknown>> } }).db.entries[0]!
    expect('issuer' in entry).toBe(true)
    expect(entry['issuer']).toBe('')
    expect('note' in entry).toBe(true)
    expect(entry['note']).toBe('')
  })
  it('顶层结构对齐 Aegis VaultFile：version/header.slots 为空数组/db.entries', () => {
    const v = addEntry(createVault(), newEntryFromUri('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP'))
    const obj = JSON.parse(exportAegisPlaintext(v).json) as Record<string, unknown>
    expect(obj['version']).toBe(1)
    expect((obj['header'] as Record<string, unknown>)['slots']).toEqual([])
    expect(Array.isArray((obj['db'] as Record<string, unknown>)['entries'])).toBe(true)
  })
})

describe('exportAegisPlaintext 导出补全（盘点 B11 #42）', () => {
  it('yandex 条目：pin 写 info.pin（官方 YandexInfo.toJson 口径），round-trip 保真', () => {
    const e = newEntryFromUri('otpauth://yaotp/Yandex:user?secret=KJTEUGOD5SNXVWBCWJ4G36W4IA&pin=4321')
    const v = addEntry(createVault(), e)
    const entry = (JSON.parse(exportAegisPlaintext(v).json) as { db: { entries: Array<{ info: Record<string, unknown> }> } }).db.entries[0]!
    expect(entry.info['pin']).toBe('4321')
    const r = importAegisPlaintext(exportAegisPlaintext(v).json)
    expect(r.entries[0]).toMatchObject({ type: 'yandex', digits: 8, pin: '4321' })
  })

  it('hotp 无 counter（undefined）恒写 counter=0（官方 HotpInfo 无空计数语义）', () => {
    const e = newEntryFromUri('otpauth://hotp/Repo:bob?secret=JBSWY3DPEHPK3PXP')
    expect(e.counter).toBeUndefined()
    const v = addEntry(createVault(), e)
    const entry = (JSON.parse(exportAegisPlaintext(v).json) as { db: { entries: Array<{ info: Record<string, unknown> }> } }).db.entries[0]!
    expect(entry.info['counter']).toBe(0)
  })

  it('空 vault：db.entries/groups 为空数组、report.usedGroups 空', () => {
    const { json, report } = exportAegisPlaintext(createVault())
    const db = (JSON.parse(json) as { db: { entries: unknown[]; groups: unknown[] } }).db
    expect(db.entries).toEqual([])
    expect(db.groups).toEqual([])
    expect(report.usedGroups).toEqual([])
    expect(report.droppedTagCount).toBe(0)
  })

  it('tagId 悬空（tagNameOf null）过滤：不产出幽灵组，其余标签正常', () => {
    const e = newEntryFromUri('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP')
    let v = createVault()
    const { vault: v1, tagIds } = resolveTagNames(v, ['工作'])
    v = v1
    e.tagIds = [tagIds[0]!, 'ghost-tag-id'] // 悬空 id（vault.tags 中无此 tag）
    v = addEntry(v, e)
    const obj = JSON.parse(exportAegisPlaintext(v).json) as { db: { entries: Array<{ groups?: string[] }>; groups: Array<{ name: string }> } }
    expect(obj.db.groups.map((g) => g.name)).toEqual(['工作'])
    expect(obj.db.entries[0]!.groups).toHaveLength(1)
    const r = importAegisPlaintext(exportAegisPlaintext(v).json)
    expect(r.entries[0]!.tags).toEqual(['工作'])
  })

  it('无 crypto.randomUUID 的宿主回落时间戳 id（含 groups uuid 生成，导出不崩）', () => {
    // 先在真实 crypto 下建好 vault（vault 模块同用 crypto.randomUUID）
    let v = createVault()
    const { vault: v1, tagIds } = resolveTagNames(v, ['工作'])
    v = v1
    const e = newEntryFromUri('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP')
    e.tagIds = [tagIds[0]!]
    v = addEntry(v, e)
    const original = globalThis.crypto
    // 模拟旧宿主：crypto 存在但无 randomUUID（aegisVault 的回落分支在导出调用期求值）
    vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) })
    try {
      const obj = JSON.parse(exportAegisPlaintext(v).json) as {
        db: { entries: Array<{ uuid: string }>; groups: Array<{ uuid: string }> }
      }
      expect(typeof obj.db.entries[0]!.uuid).toBe('string')
      expect(obj.db.entries[0]!.uuid.length).toBeGreaterThan(0)
      expect(typeof obj.db.groups[0]!.uuid).toBe('string')
      expect(obj.db.groups[0]!.uuid.length).toBeGreaterThan(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
