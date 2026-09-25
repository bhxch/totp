// packages/core/test/conflictStore.test.ts
// 条目级合并冲突记录持久化（Task 9/10 commit A）：明文/seal 往返、损坏回落、超限裁最旧
import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import { MERGE_CONFLICTS_MAX, loadMergeConflicts, saveMergeConflicts } from '../src/merge/conflictStore'
import type { StorageAdapter } from '../src/storage/adapter'
import type { EntryConflict } from '../src/merge/vaultMerge'

const conflict = (entryId: string): EntryConflict => ({
  entryId,
  issuer: 'GitHub',
  label: entryId,
  ours: null,
  theirs: { uuid: entryId, label: entryId, issuer: 'GitHub', secret: 'JBSW', algorithm: 'SHA1', digits: 6, period: 30, type: 'totp', order: 0, tagIds: [], createdAt: 1, updatedAt: 2 },
  base: null,
})

describe('conflictStore', () => {
  it('无 seal：明文往返；键缺失 → 空数组', async () => {
    const a = createMemoryStorage()
    expect(await loadMergeConflicts(a)).toEqual([])
    await saveMergeConflicts(a, [conflict('e1')])
    expect(await loadMergeConflicts(a)).toHaveLength(1)
    expect((await a.get('mergeConflicts'))!).toContain('"entryId":"e1"') // 明文形态
  })

  it('有 seal：落盘为密文（不含明文子串），读回一致', async () => {
    const a = createMemoryStorage()
    const seal = {
      seal: async (p: string) => 'ENC[' + btoa(unescape(encodeURIComponent(p))) + ']',
      unseal: async (s: string) => decodeURIComponent(escape(atob(s.slice(4, -1)))),
    }
    await saveMergeConflicts(a, [conflict('secret-entry')], seal)
    expect(await a.get('mergeConflicts')).not.toContain('secret-entry')
    const list = await loadMergeConflicts(a, seal)
    expect(list).toHaveLength(1)
    expect(list[0]!.entryId).toBe('secret-entry')
  })

  it('unseal 失败（换 DEK）→ 回落空数组不抛错', async () => {
    const a = createMemoryStorage()
    await a.set('mergeConflicts', 'ENC[bad]')
    expect(await loadMergeConflicts(a, { seal: async () => '', unseal: async () => { throw new Error('no') } })).toEqual([])
  })

  it('坏 JSON / 非数组 → 空数组；形态不符元素逐条过滤', async () => {
    const a = createMemoryStorage()
    await a.set('mergeConflicts', '{not json')
    expect(await loadMergeConflicts(a)).toEqual([])
    await a.set('mergeConflicts', '{"a":1}')
    expect(await loadMergeConflicts(a)).toEqual([])
    await a.set('mergeConflicts', JSON.stringify([{ entryId: 'ok', issuer: 'i', label: 'l', ours: null, theirs: null, base: null }, { bad: true }, null]))
    const list = await loadMergeConflicts(a)
    expect(list).toHaveLength(1)
    expect(list[0]!.entryId).toBe('ok')
  })

  it('adapter.get 本身抛错（存储层故障）→ 空数组不抛，不阻断同步', async () => {
    const broken: StorageAdapter = {
      get: async () => {
        throw new Error('storage broken')
      },
      set: async () => {},
      delete: async () => {},
    }
    expect(await loadMergeConflicts(broken)).toEqual([])
  })

  it('超上限（>100）保存裁最旧：保留最新 100 条', async () => {
    const a = createMemoryStorage()
    const all: EntryConflict[] = []
    for (let i = 0; i < MERGE_CONFLICTS_MAX + 5; i++) all.push(conflict(`e${i}`))
    await saveMergeConflicts(a, all)
    const list = await loadMergeConflicts(a)
    expect(list).toHaveLength(MERGE_CONFLICTS_MAX)
    expect(list[0]!.entryId).toBe('e5') // 最旧 5 条（e0-e4）被裁
    expect(list[list.length - 1]!.entryId).toBe(`e${MERGE_CONFLICTS_MAX + 4}`)
  })
})
