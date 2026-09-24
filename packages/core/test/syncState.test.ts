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
})
