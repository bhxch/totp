import { describe, expect, it } from 'vitest'
import { addEntry, createVault } from '../src/vault'
import type { Vault } from '../src/model'
import { applyImportPlan, dedupeWithinFile, planImport, type ParsedEntry } from '../src/import/dedup'

const p = (over: Partial<ParsedEntry> = {}): ParsedEntry => ({
  type: 'totp', issuer: 'GitHub', label: 'a@x.com', secret: 'KRSXG5DSM5UQ', algorithm: 'SHA1', digits: 6, period: 30, ...over,
})
const seeded = () =>
  addEntry(createVault(), {
    uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'a@x.com', secret: 'KRSXG5DSM5UQ',
    algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order: 0, createdAt: 1,
  })

describe('dedupeWithinFile：文件内完全重复行合并', () => {
  it('保留首条并计合并数', () => {
    const r = dedupeWithinFile([p(), p({ label: 'b@x.com' }), p()])
    expect(r.kept).toHaveLength(2)
    expect(r.removed).toBe(1)
  })
  it('键 trim+大小写不敏感：空白/大小写差异算重复', () => {
    const r = dedupeWithinFile([p(), p({ issuer: ' github ', secret: 'krsxg5dsm5uq' })])
    expect(r.kept).toHaveLength(1)
    expect(r.removed).toBe(1)
  })
  it('note 差异不算差异（note 是用户本地字段，不参与相同性判定）', () => {
    const r = dedupeWithinFile([p(), p({ note: '本地笔记' })])
    expect(r.kept).toHaveLength(1)
    expect(r.removed).toBe(1)
  })
  it('空数组：无保留无合并', () => {
    expect(dedupeWithinFile([])).toEqual({ kept: [], removed: 0 })
  })
})

describe('planImport 判定树', () => {
  it('全字段一致 → identical；secret+algorithm 同但 label/period 异 → suspect（带 targetUuid）；issuer+label 撞而 secret 异 → conflict', () => {
    const v = seeded()
    const inc = [p(), p({ label: 'renamed@x.com' }), p({ secret: 'DIFFERENTSECRET' })]
    const plan = planImport(v, inc)
    expect(plan.kinds).toEqual(['identical', 'suspect', 'conflict'])
    expect(plan.targetUuids[1]).toBe('u1')
    expect(plan.counts).toEqual({ identical: 1, suspect: 1, conflict: 1, new: 0 })
  })
  it('同 secret 不同 issuer（罕见合法多标签）→ suspect 而非 identical', () => {
    const plan = planImport(seeded(), [p({ issuer: 'GitLab' })])
    expect(plan.kinds[0]).toBe('suspect')
  })
  it('无碰撞 → new', () => {
    expect(planImport(seeded(), [p({ issuer: 'Other', label: 'z', secret: 'ANOTHERSECRET' })]).kinds[0]).toBe('new')
  })
  it('空 incoming：kinds 为空、四组计数全 0', () => {
    const plan = planImport(seeded(), [])
    expect(plan.kinds).toEqual([])
    expect(plan.targetUuids).toEqual([])
    expect(plan.counts).toEqual({ identical: 0, suspect: 0, conflict: 0, new: 0 })
  })
  it('identical 判定不受 note 差异影响（existing 带 note 仍判 identical）', () => {
    const v = addEntry(createVault(), {
      uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'a@x.com', secret: 'KRSXG5DSM5UQ',
      algorithm: 'SHA1', digits: 6, period: 30, note: '本地笔记', groupIds: [], order: 0, createdAt: 1,
    })
    expect(planImport(v, [p()]).kinds[0]).toBe('identical')
  })
  it('counter 参与 identical 键：HOTP counter 不同 → 降级 suspect', () => {
    const v = addEntry(createVault(), {
      uuid: 'u1', type: 'hotp', issuer: 'Api', label: 'token', secret: 'KRSXG5DSM5UQ',
      algorithm: 'SHA1', digits: 6, period: 30, counter: 1, groupIds: [], order: 0, createdAt: 1,
    })
    const plan = planImport(v, [p({ type: 'hotp', period: 0, counter: 2 })])
    expect(plan.kinds[0]).toBe('suspect')
    expect(plan.targetUuids[0]).toBe('u1')
  })
  it('键 trim+大小写不敏感：小写 issuer + 带空白 label 撞现有 → identical', () => {
    expect(planImport(seeded(), [p({ issuer: 'github', label: ' A@X.COM ' })]).kinds[0]).toBe('identical')
  })
})

describe('applyImportPlan', () => {
  it('identical 恒跳过；suspect 决策默认 skip、add 新增、replace 按 targetUuid 覆盖保留 uuid/order/groupIds', () => {
    const v = seeded()
    const inc = [p(), p({ label: 'renamed@x.com', period: 60 })]
    const plan = planImport(v, inc)
    let out = applyImportPlan(v, inc, plan, new Map([[1, 'replace'] as const]), 'skip')
    expect(out.vault.entries).toHaveLength(1)
    expect(out.vault.entries[0]!.uuid).toBe('u1')
    expect(out.vault.entries[0]!.period).toBe(60)
    out = applyImportPlan(v, inc, plan, new Map([[1, 'add'] as const]), 'skip')
    expect(out.vault.entries).toHaveLength(2)
    // 注：计划蓝本此处 suspectSkipped 写 1，与"一条 incoming 只落一个分支"（设计 §4）矛盾——
    // 唯一 suspect 条目已选 add（added:1），suspectSkipped 正确值为 0
    expect(out.stats).toEqual({ added: 1, replaced: 0, suspectSkipped: 0, identical: 1, conflictSkipped: 0, conflictReplaced: 0, conflictMerged: 0 })
  })
  it('conflict 条目沿用 ConflictPolicy（skip/replace/merge 语义与 applyImport 一致）', () => {
    const v = seeded()
    const inc = [p({ secret: 'DIFFERENTSECRET' })]
    const plan = planImport(v, inc)
    const out = applyImportPlan(v, inc, plan, new Map(), 'merge')
    expect(out.vault.entries).toHaveLength(2) // merge=并存
  })
  it('suspect 缺省（choices 未提供该索引）→ skip', () => {
    const v = seeded()
    const inc = [p({ label: 'renamed@x.com' })]
    const plan = planImport(v, inc)
    const out = applyImportPlan(v, inc, plan, new Map(), 'skip')
    expect(out.vault.entries).toHaveLength(1)
    expect(out.stats.suspectSkipped).toBe(1)
  })
  it('suspect add：新增条目获得全新 uuid（不复用现有 uuid）', () => {
    const v = seeded()
    const inc = [p({ label: 'renamed@x.com' })]
    const plan = planImport(v, inc)
    const out = applyImportPlan(v, inc, plan, new Map([[0, 'add'] as const]), 'skip')
    expect(out.vault.entries).toHaveLength(2)
    const addedEntry = out.vault.entries[1]!
    expect(addedEntry.uuid).not.toBe('u1')
    expect(addedEntry.label).toBe('renamed@x.com')
    expect(out.stats.added).toBe(1)
  })
  it('suspect replace：解析明确字段被覆盖，uuid/order/groupIds 与本地 note 保留', () => {
    // 直接构造 Vault 字面量以保留 order=7（addEntry 会强制重算 order）
    const v: Vault = {
      version: 1,
      updatedAt: 1,
      groups: [],
      entries: [{
        uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'a@x.com', secret: 'KRSXG5DSM5UQ',
        algorithm: 'SHA1', digits: 6, period: 30, note: '本地笔记', groupIds: ['g1'], order: 7, createdAt: 1,
      }],
    }
    // secret+algorithm 保持与现有相同（suspect 前提），仅 label/period/digits 有差异
    const inc = [p({ label: 'renamed@x.com', period: 60, digits: 8 })]
    const plan = planImport(v, inc)
    expect(plan.kinds[0]).toBe('suspect')
    const out = applyImportPlan(v, inc, plan, new Map([[0, 'replace'] as const]), 'skip')
    const updated = out.vault.entries[0]!
    expect(updated.uuid).toBe('u1')
    expect(updated.order).toBe(7)
    expect(updated.groupIds).toEqual(['g1'])
    expect(updated.note).toBe('本地笔记')
    expect(updated.label).toBe('renamed@x.com')
    expect(updated.period).toBe(60)
    expect(updated.digits).toBe(8)
    expect(out.stats.replaced).toBe(1)
  })
  it('identical 即使被给出 suspect choice 也恒跳过', () => {
    const v = seeded()
    const inc = [p()]
    const plan = planImport(v, inc)
    const out = applyImportPlan(v, inc, plan, new Map([[0, 'add'] as const]), 'skip')
    expect(out.vault.entries).toHaveLength(1)
    expect(out.stats.identical).toBe(1)
    expect(out.stats.added).toBe(0)
  })
  it('conflict skip → conflictSkipped；conflict replace → 保留 uuid 覆盖 secret', () => {
    const v = seeded()
    const inc = [p({ secret: 'DIFFERENTSECRET' })]
    const plan = planImport(v, inc)
    const skipped = applyImportPlan(v, inc, plan, new Map(), 'skip')
    expect(skipped.vault.entries).toHaveLength(1)
    expect(skipped.stats.conflictSkipped).toBe(1)
    const replaced = applyImportPlan(v, inc, plan, new Map(), 'replace')
    expect(replaced.vault.entries).toHaveLength(1)
    expect(replaced.vault.entries[0]!.uuid).toBe('u1')
    expect(replaced.vault.entries[0]!.secret).toBe('DIFFERENTSECRET')
    expect(replaced.stats.conflictReplaced).toBe(1)
  })
  it('suspect replace 缺 targetUuid（残缺 plan）→ 退化为 skip', () => {
    const v = seeded()
    const inc = [p({ label: 'renamed@x.com' })]
    const plan = planImport(v, inc)
    const broken = { ...plan, targetUuids: [...plan.targetUuids] }
    broken.targetUuids[0] = undefined
    const out = applyImportPlan(v, inc, broken, new Map([[0, 'replace'] as const]), 'skip')
    expect(out.vault.entries).toHaveLength(1)
    expect(out.stats.suspectSkipped).toBe(1)
  })
  it('空 incoming：vault 不变、stats 全 0', () => {
    const v = seeded()
    const plan = planImport(v, [])
    const out = applyImportPlan(v, [], plan, new Map(), 'skip')
    expect(out.vault.entries).toEqual(v.entries)
    expect(out.stats).toEqual({ added: 0, replaced: 0, suspectSkipped: 0, identical: 0, conflictSkipped: 0, conflictReplaced: 0, conflictMerged: 0 })
  })
})
