// packages/core/src/cloud/syncState.ts
/** 云同步本端持久状态（spec §1.2）。baseSnapshot 是 vault 明文副本：seal 提供时整状态
 *  JSON 加密落盘（DEK 静态保护，宿主在解锁态注入）；seal 缺省=明文库场景明文落盘。 */
import type { StorageAdapter } from '../storage/adapter'

export interface SourceSyncState {
  /** 上次见到的云端 rev；null=该源从未同步过 */
  lastKnownRemoteRev: number | null
  /** 上次与本端内容收敛一致的完整 vault JSON（共同祖先快照）；null=无祖先（两方合并降级） */
  baseSnapshot: string | null
  /** replica 目标的 rev 记录（spec §2 收敛复制跳过判定） */
  primaryRev?: Record<string, number>
}

export interface Seal {
  seal(plain: string): Promise<string>
  unseal(sealed: string): Promise<string>
}

export const SYNC_STATE_KEY = 'cloudSyncState'
export const DEVICE_ID_KEY = 'cloudDeviceId'

function emptyState(): SourceSyncState {
  return { lastKnownRemoteRev: null, baseSnapshot: null }
}

export async function loadSyncState(adapter: StorageAdapter, sourceId: string, seal?: Seal): Promise<SourceSyncState> {
  let raw: string | null = null
  try {
    raw = await adapter.get(SYNC_STATE_KEY)
  } catch {
    return emptyState()
  }
  if (!raw) return emptyState()
  let bag: Record<string, unknown>
  try {
    bag = JSON.parse(seal ? await seal.unseal(raw) : raw) as Record<string, unknown>
  } catch {
    return emptyState() // 换 DEK/损坏：回落缺省，下轮全量重建（不抛错阻断同步）
  }
  const s = bag[sourceId] as Partial<SourceSyncState> | undefined
  if (!s || typeof s !== 'object') return emptyState()
  return {
    lastKnownRemoteRev: typeof s.lastKnownRemoteRev === 'number' ? s.lastKnownRemoteRev : null,
    baseSnapshot: typeof s.baseSnapshot === 'string' ? s.baseSnapshot : null,
    ...(s.primaryRev !== undefined && typeof s.primaryRev === 'object' ? { primaryRev: s.primaryRev as Record<string, number> } : {}),
  }
}

export async function saveSyncState(adapter: StorageAdapter, sourceId: string, state: SourceSyncState, seal?: Seal): Promise<void> {
  let bag: Record<string, unknown> = {}
  try {
    const raw = await adapter.get(SYNC_STATE_KEY)
    bag = raw ? JSON.parse(seal ? await seal.unseal(raw) : raw) as Record<string, unknown> : {}
  } catch {
    bag = {}
  }
  bag[sourceId] = state
  const plain = JSON.stringify(bag)
  await adapter.set(SYNC_STATE_KEY, seal ? await seal.seal(plain) : plain)
}

export async function loadDeviceId(adapter: StorageAdapter): Promise<string> {
  const existing = await adapter.get(DEVICE_ID_KEY).catch(() => null)
  if (existing) return existing
  const id = crypto.randomUUID()
  await adapter.set(DEVICE_ID_KEY, id)
  return id
}
