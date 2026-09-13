import { describe, expect, it } from 'vitest'
import { applyImport, findConflicts } from '../src/import/conflict'
import type { ParsedEntry } from '../src/import/types'
import { addEntry, createVault, newEntryFromUri } from '../src/vault'

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
})
