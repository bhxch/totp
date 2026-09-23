// store 合并冲突记录面（Task 9/10 commit B）：DEK seal 助手、mergeConflicts 生命周期（解锁装载/锁定清空）、
// addMergeConflictsOp 去重/上限、resolveMergeConflictOp 四分支裁决（pick 侧 null=确认该侧删除，两侧对称）
import { describe, expect, it } from 'vitest'
import { createMemoryStorage, loadSyncState, saveSyncState, VAULT_KEY, decryptVaultWithDek, type EntryConflict, type OtpEntry } from '@totp/core'
import { createVueStore } from '../src/store'

const entry = (uuid: string, marker: string): OtpEntry => ({
  uuid, label: marker, issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30,
  type: 'totp', order: 0, tagIds: [], createdAt: 1, updatedAt: 2,
})

const conflict = (entryId: string, over: Partial<EntryConflict> = {}): EntryConflict => ({
  entryId,
  issuer: 'GitHub',
  label: `label-${entryId}`,
  ours: entry(entryId, `ours-${entryId}`),
  theirs: entry(entryId, `theirs-${entryId}`),
  base: entry(entryId, `base-${entryId}`),
  ...over,
})

async function unlockedStore() {
  const adapter = createMemoryStorage()
  const s = createVueStore(adapter)
  await s.initStore()
  await s.enableEncryption('masterpw')
  return { adapter, s }
}

describe('store seal 助手', () => {
  it('解锁+加密态：sealWithDek/unsealWithDek 对称往返；盘面无明文', async () => {
    const { adapter, s } = await unlockedStore()
    const sealed = await s.sealWithDek('TOPSECRET-PLAIN')
    expect(sealed).not.toBeNull()
    expect(sealed!).not.toContain('TOPSECRET-PLAIN')
    expect(JSON.parse(sealed!)).toHaveProperty('enc', true) // EncryptedVault 形态
    expect(await s.unsealWithDek(sealed!)).toBe('TOPSECRET-PLAIN')
    void adapter
  })

  it('未启用加密：sealWithDek/unsealWithDek 返回 null（宿主按明文回落）；锁定（加密启用）抛 vault locked', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    expect(await s.sealWithDek('plain')).toBeNull()
    expect(await s.unsealWithDek('{"v":1,"enc":true}')).toBeNull()
    // 加密启用但窗口锁定：两态显式区分——锁定不得明文回落（在途锁定竞态裁定）
    const { s: s2 } = await unlockedStore()
    s2.lock()
    await expect(s2.sealWithDek('plain')).rejects.toThrow('vault locked')
    await expect(s2.unsealWithDek('garbage')).rejects.toThrow('vault locked')
  })

  it('同步在途锁定（审查 Important 1 锚定）：宿主形态 seal 抛错 → state 落盘整体失败，盘面保持旧密文无明文，解锁后互读一致', async () => {
    const { adapter, s } = await unlockedStore()
    // 与宿主 revSeal/mergeConflictSeal 同形态：null 回落原文、异常原样上抛
    const hostSeal = {
      seal: async (p: string) => (await s.sealWithDek(p)) ?? p,
      unseal: async (x: string) => (await s.unsealWithDek(x)) ?? x,
    }
    await saveSyncState(adapter, 's1', { lastKnownRemoteRev: 3, baseSnapshot: 'TOPSECRET-SNAPSHOT' }, hostSeal)
    expect((await adapter.get('cloudSyncState'))!).not.toContain('TOPSECRET-SNAPSHOT') // 加密态落盘为密文
    s.lock() // 同步在途 lock()：DEK 已清
    await expect(
      saveSyncState(adapter, 's1', { lastKnownRemoteRev: 4, baseSnapshot: 'TOPSECRET-SNAPSHOT' }, hostSeal),
    ).rejects.toThrow('vault locked') // 落盘整体失败（runner per-source 跳过 → 下轮重做）
    const raw = (await adapter.get('cloudSyncState'))!
    expect(raw).not.toContain('TOPSECRET-SNAPSHOT') // 盘面保持旧密文，无明文泄漏
    expect(raw).not.toContain('"baseSnapshot"')
    await s.unlock('masterpw')
    // 解锁后读回旧基线：宿主 seal 通道（手动/runner 共用）互读一致
    expect(await loadSyncState(adapter, 's1', hostSeal)).toEqual({ lastKnownRemoteRev: 3, baseSnapshot: 'TOPSECRET-SNAPSHOT' })
  })
})

describe('store mergeConflicts 生命周期', () => {
  it('addMergeConflictsOp 追加落盘（加密 seal，盘面无条目明文）；lock 清空、unlock 重装载', async () => {
    const { adapter, s } = await unlockedStore()
    await s.addEntryOp(entry('e1', 'A'))
    await s.addMergeConflictsOp([conflict('e1')])
    expect(s.conflictCount.value).toBe(1)
    const raw = (await adapter.get('mergeConflicts'))!
    expect(raw).not.toContain('theirs-e1') // 条目内容经 DEK 密封，不落明文
    s.lock()
    expect(s.conflictCount.value).toBe(0) // 锁定清空（秘密不持内存）
    await s.unlock('masterpw')
    expect(s.conflictCount.value).toBe(1) // 解锁从盘重装载
    expect(s.mergeConflicts.value[0]!.entryId).toBe('e1')
    void VAULT_KEY
  })

  it('addMergeConflictsOp 同 entryId 以新记录替换（不重复堆积）', async () => {
    const { s } = await unlockedStore()
    await s.addMergeConflictsOp([conflict('e1', { label: 'old' })])
    await s.addMergeConflictsOp([conflict('e1', { label: 'new' }), conflict('e2')])
    expect(s.conflictCount.value).toBe(2)
    expect(s.mergeConflicts.value.find((c) => c.entryId === 'e1')!.label).toBe('new')
  })

  it('addMergeConflictsOp 超 100 条裁最旧（内存视图与盘一致）', async () => {
    const { s } = await unlockedStore()
    await s.addMergeConflictsOp(Array.from({ length: 105 }, (_, i) => conflict(`e${i}`)))
    expect(s.conflictCount.value).toBe(100)
    expect(s.mergeConflicts.value[0]!.entryId).toBe('e5')
  })
})

describe('store resolveMergeConflictOp', () => {
  it("pick='theirs'：以 theirs 替换条目，记录移除、计数归零，写经 commit 推进 rev", async () => {
    const { adapter, s } = await unlockedStore()
    await s.addEntryOp(entry('e1', 'local-old'))
    const revBefore = Number(s.vault.rev ?? 0)
    await s.addMergeConflictsOp([conflict('e1')])
    await s.resolveMergeConflictOp('e1', 'theirs')
    expect(s.vault.entries.map((e) => e.label)).toEqual(['theirs-e1'])
    expect(s.conflictCount.value).toBe(0)
    expect(Number(s.vault.rev ?? 0)).toBeGreaterThan(revBefore) // 写经 commit 自动推进
    const enc = JSON.parse((await adapter.get(VAULT_KEY))!)
    const disk = JSON.parse(await decryptVaultWithDek(s.getCurrentDek()!, enc)) as { entries: OtpEntry[] }
    expect(disk.entries.map((e) => e.label)).toEqual(['theirs-e1']) // 落盘一致
  })

  it("pick='theirs' 且 theirs=null：删除条目（确认云方删除）", async () => {
    const { s } = await unlockedStore()
    await s.addEntryOp(entry('e1', 'survivor'))
    await s.addMergeConflictsOp([conflict('e1', { theirs: null })])
    await s.resolveMergeConflictOp('e1', 'theirs') // theirs=null（对端删）→ 删除生效
    expect(s.vault.entries).toHaveLength(0)
  })

  it("pick='ours' 且 ours=null：删除条目（确认本方删除，与 theirs=null 侧对称；base 不复活）", async () => {
    const { s } = await unlockedStore()
    await s.addEntryOp(entry('e1', 'survivor'))
    await s.addMergeConflictsOp([conflict('e1', { ours: null })]) // ours=null（本端删、对端改，合并保留了对端）
    await s.resolveMergeConflictOp('e1', 'ours') // 确认本方删除（旧 ?? base 回退会复活 base 旧版本，回归钉）
    expect(s.vault.entries).toHaveLength(0)
  })

  it("pick='ours' 且 ours=null、base=null：删除条目；不存在的 entryId 抛错", async () => {
    const { s } = await unlockedStore()
    await s.addEntryOp(entry('e1', 'survivor'))
    await s.addMergeConflictsOp([conflict('e1', { ours: null, base: null })])
    await s.resolveMergeConflictOp('e1', 'ours') // pick 侧 null → 删除（base 有无不影响结果）
    expect(s.vault.entries).toHaveLength(0)
    await expect(s.resolveMergeConflictOp('missing', 'ours')).rejects.toThrow('合并冲突记录不存在')
  })

  it("pick='ours'：以 ours 替换条目（恢复本方内容）", async () => {
    const { s } = await unlockedStore()
    await s.addEntryOp(entry('e1', 'merged-winner'))
    await s.addMergeConflictsOp([conflict('e1')])
    await s.resolveMergeConflictOp('e1', 'ours')
    expect(s.vault.entries.map((e) => e.label)).toEqual(['ours-e1'])
  })
})
