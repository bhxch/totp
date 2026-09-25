// packages/core/test/syncState.test.ts
// 注：内存适配器实际导出名为 createMemoryStorage（storage/memory.ts），语义与任务书 createMemoryAdapter 一致
import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import { loadDeviceId, loadSyncState, saveSyncState } from '../src/cloud/syncState'

describe('syncState', () => {
  it('无 seal：明文往返；缺省状态 lastKnownRemoteRev=null', async () => {
    const a = createMemoryStorage()
    expect(await loadSyncState(a, 's1')).toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })
    await saveSyncState(a, 's1', { lastKnownRemoteRev: 5, baseSnapshot: '{"v":2}' })
    expect(await loadSyncState(a, 's1')).toEqual({ lastKnownRemoteRev: 5, baseSnapshot: '{"v":2}' })
  })
  it('有 seal：落盘为密文（不含明文子串），读回一致', async () => {
    const a = createMemoryStorage()
    const seal = {
      seal: async (p: string) => 'ENC[' + btoa(p) + ']',
      unseal: async (s: string) => atob(s.slice(4, -1)),
    }
    await saveSyncState(a, 's1', { lastKnownRemoteRev: 5, baseSnapshot: '{"secretField":"TOPSECRET"}' }, seal)
    const raw = await a.get('cloudSyncState')
    expect(raw).not.toContain('TOPSECRET')
    expect(await loadSyncState(a, 's1', seal)).toEqual({ lastKnownRemoteRev: 5, baseSnapshot: '{"secretField":"TOPSECRET"}' })
  })
  it('unseal 失败（换 DEK）→ 回落缺省状态不抛错', async () => {
    const a = createMemoryStorage()
    await a.set('cloudSyncState', 'ENC[bad]')
    expect(await loadSyncState(a, 's1', { seal: async () => '', unseal: async () => { throw new Error('no') } }))
      .toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })
  })
  it('loadDeviceId：首次生成并持久，二次读取同值', async () => {
    const a = createMemoryStorage()
    const id1 = await loadDeviceId(a)
    expect(id1).toMatch(/^[0-9a-f-]{36}$/)
    expect(await loadDeviceId(a)).toBe(id1)
  })
  it('adapter.get 抛错（IO 故障）→ 回落缺省状态不抛错', async () => {
    const a = createMemoryStorage()
    a.get = async () => {
      throw new Error('storage IO error')
    }
    expect(await loadSyncState(a, 's1')).toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })
  })
  it('字段类型矫正：lastKnownRemoteRev 非数字 / baseSnapshot 非字符串 / 条目非对象 → 各自回落 null', async () => {
    const a = createMemoryStorage()
    await a.set('cloudSyncState', JSON.stringify({
      s1: { lastKnownRemoteRev: '5', baseSnapshot: 42 }, // 字段类型全错
      s2: 'garbage', // 条目非对象
    }))
    expect(await loadSyncState(a, 's1')).toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })
    expect(await loadSyncState(a, 's2')).toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })
  })
  it('bag 多源共存：save 源B 不丢源A（明文与 seal 两种形态）', async () => {
    const a = createMemoryStorage()
    await saveSyncState(a, 'sA', { lastKnownRemoteRev: 3, baseSnapshot: '{"a":1}' })
    await saveSyncState(a, 'sB', { lastKnownRemoteRev: null, baseSnapshot: null })
    expect(await loadSyncState(a, 'sA')).toEqual({ lastKnownRemoteRev: 3, baseSnapshot: '{"a":1}' })
    expect(await loadSyncState(a, 'sB')).toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })

    const seal = {
      seal: async (p: string) => 'ENC[' + btoa(p) + ']',
      unseal: async (s: string) => atob(s.slice(4, -1)),
    }
    const b = createMemoryStorage()
    await saveSyncState(b, 'sA', { lastKnownRemoteRev: 3, baseSnapshot: '{"a":1}' }, seal)
    await saveSyncState(b, 'sB', { lastKnownRemoteRev: 8, baseSnapshot: '{"b":2}' }, seal)
    expect(await loadSyncState(b, 'sA', seal)).toEqual({ lastKnownRemoteRev: 3, baseSnapshot: '{"a":1}' })
    expect(await loadSyncState(b, 'sB', seal)).toEqual({ lastKnownRemoteRev: 8, baseSnapshot: '{"b":2}' })
  })
  it('save 时读旧 bag 抛错（盘上损坏/unseal 失败）→ 重写仅含本次源（不抛错、不丢写入）', async () => {
    const a = createMemoryStorage()
    await a.set('cloudSyncState', '{corrupted')
    await saveSyncState(a, 's1', { lastKnownRemoteRev: 6, baseSnapshot: '{"v":2}' })
    // 旧 bag 不可读 → 从空重建：本次源写入成功（旧源数据已不可读，无从保留）
    expect(await loadSyncState(a, 's1')).toEqual({ lastKnownRemoteRev: 6, baseSnapshot: '{"v":2}' })
  })
  it('loadDeviceId：set 失败原样上抛（持久化故障不得静默伪成功）', async () => {
    const a = createMemoryStorage()
    a.set = async () => {
      throw new Error('quota exceeded')
    }
    await expect(loadDeviceId(a)).rejects.toThrow('quota exceeded')
  })
})
