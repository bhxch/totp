// revSeal 共用 seal 通道（审查 Critical 1 锚定）：CloudCard 手动通道（cloudPlatform）与云 runner
// 自动通道共享 'cloudSyncState' 键——两侧必须同一 seal 形态。启用加密时：①落盘串不含明文子串
// （baseSnapshot 不泄漏）；②手动通道写入、runner 通道（新 revSeal 实例）读回一致（互读不互踩）。
import { describe, expect, it } from 'vitest'
import { createMemoryStorage, loadSyncState, saveSyncState } from '@totp/core'
import { createVueStore, type VueStore } from '@totp/ui'
import { revSeal } from '../src/cloudRunnerFactory'

async function unlockedStore(adapter: ReturnType<typeof createMemoryStorage>): Promise<VueStore> {
  const s = createVueStore(adapter, { windowId: 'revseal-test' })
  await s.initStore()
  await s.enableEncryption('masterpw')
  return s
}

describe('revSeal（手动/runner 共用 seal 通道）', () => {
  it('启用加密：手动通道落盘串不含明文子串；runner 通道（新 revSeal 实例）互读一致', async () => {
    const adapter = createMemoryStorage()
    const store = await unlockedStore(adapter)
    const state = { lastKnownRemoteRev: 5, baseSnapshot: 'SECRET-BASE-SNAPSHOT' }
    // 手动通道写入（options App.vue cloudPlatform.loadSourceState/saveSourceState 的接线形态）
    await saveSyncState(adapter, 's1', state, revSeal(store))
    const raw = (await adapter.get('cloudSyncState'))!
    expect(raw).not.toContain('SECRET-BASE-SNAPSHOT')
    expect(raw).not.toContain('"baseSnapshot"')
    // runner 通道读取（cloudRunnerFactory runner deps 的接线形态，新 seal 实例）
    expect(await loadSyncState(adapter, 's1', revSeal(store))).toEqual(state)
  })

  it('未启用加密：明文回落可往返（与 core syncState 缺省语义一致）', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter, { windowId: 'revseal-plain' })
    await s.initStore()
    const state = { lastKnownRemoteRev: 2, baseSnapshot: 'PLAIN-BASE' }
    await saveSyncState(adapter, 's1', state, revSeal(s))
    expect((await adapter.get('cloudSyncState'))!).toContain('PLAIN-BASE') // 明文库明文落盘
    expect(await loadSyncState(adapter, 's1', revSeal(s))).toEqual(state)
  })
})
