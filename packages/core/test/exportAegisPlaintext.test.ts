import { addEntry, createVault, exportAegisPlaintext, importAegisPlaintext, newEntryFromUri, resolveTagNames } from '@totp/core'
import { describe, expect, it } from 'vitest'

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
  it('多标签条目：第一个标签映射 group，其余计入 report.droppedTagCount', () => {
    const e = newEntryFromUri('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP')
    let v = createVault()
    const { vault: v1, tagIds } = resolveTagNames(v, ['工作', '重要']) // 两个 tag
    v = v1
    e.tagIds = [tagIds[0]!, tagIds[1]!]
    v = addEntry(v, e)
    const { json, report } = exportAegisPlaintext(v)
    expect(report.droppedTagCount).toBe(1)
    const r = importAegisPlaintext(json)
    expect(r.entries[0]!.tags).toEqual(['工作'])
  })
  it('顶层结构对齐 Aegis VaultFile：version/header.slots 为空数组/db.entries', () => {
    const v = addEntry(createVault(), newEntryFromUri('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP'))
    const obj = JSON.parse(exportAegisPlaintext(v).json) as Record<string, unknown>
    expect(obj['version']).toBe(1)
    expect((obj['header'] as Record<string, unknown>)['slots']).toEqual([])
    expect(Array.isArray((obj['db'] as Record<string, unknown>)['entries'])).toBe(true)
  })
})
