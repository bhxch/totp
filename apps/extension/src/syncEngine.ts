/**
 * 浏览器同步引擎（由 background SW 执行；页面端只经 sendMessage 调度）。
 *
 * 存储布局：
 * - 数据源：chrome.storage.local 的 vault/security/settings 三个 JSON 字符串键（与页面 store 同源）
 * - 同步区：chrome.storage.sync——分片 `sync:v1:<part>/<total>`（对象）+ `sync:meta`（对象）
 *   + `sync:settings` / `sync:security`（直读 local 的 JSON 字符串整体一份）。
 *   选 sync 区的依据：core 分片 7000B < sync.QUOTA_BYTES_PER_ITEM(8192)；配额检测对应
 *   sync.QUOTA_BYTES(102400)（local 区有 unlimitedStorage，无配额语义）；借 Chrome 账号跨设备同步
 * - 设备本地记账（local 区，防跨设备互踩）：`sync:appliedRev`（本端已应用的远端 rev）、
 *   `sync:status`（{state,at} 供 UI 状态条，状态是每设备各自的）
 *
 * 编排语义（计划9 Task2 简报）：简单 LWW——rev 单调递增，远端 rev > 本端 appliedRev 才拉取应用；
 * security 键同态同步（密文态经 sync:security 单键，新设备拉取后可直接解锁）。
 */
import {
  SECURITY_KEY, SETTINGS_KEY, VAULT_KEY,
  chunkKey, chunksToMeta, isEncryptedVault, mergeChunks, splitIntoChunks, staleChunkKeys,
  type SyncChunk, type SyncMeta,
} from '@totp/core'

const META_KEY = 'sync:meta'
const SETTINGS_SYNC_KEY = 'sync:settings'
const SECURITY_SYNC_KEY = 'sync:security'
const CHUNK_PREFIX = 'sync:v1:'
const APPLIED_REV_KEY = 'sync:appliedRev'
/** 设备本地记账（local 区）：UI 状态条读取的同步状态键（options 页 readStatus 复用） */
export const SYNC_STATUS_KEY = 'sync:status'
const STATUS_KEY = SYNC_STATUS_KEY

export type SyncStatusState = 'ok' | 'quota' | 'error' | 'off'

export interface SyncStatus {
  state: SyncStatusState
  at: number
}

async function setSyncStatus(state: SyncStatusState): Promise<void> {
  const status: SyncStatus = { state, at: Date.now() }
  await chrome.storage.local.set({ [STATUS_KEY]: status })
}

/** settings 直读 local 判定同步开关：缺省/损坏/false → 不同步（默认关闭，显式开启） */
async function readSyncEnabled(): Promise<boolean> {
  const o = await chrome.storage.local.get([SETTINGS_KEY])
  const raw = o[SETTINGS_KEY]
  if (typeof raw !== 'string') return false
  try {
    return (JSON.parse(raw) as Partial<{ syncEnabled: unknown }>).syncEnabled === true
  } catch {
    return false
  }
}

function isSyncChunk(x: unknown): x is SyncChunk {
  if (typeof x !== 'object' || x === null) return false
  const c = x as Partial<SyncChunk>
  return Number.isInteger(c.rev) && typeof c.updatedAt === 'number'
    && Number.isInteger(c.part) && Number.isInteger(c.total) && typeof c.data === 'string'
}

function readMeta(raw: unknown): SyncMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Partial<SyncMeta>
  if (typeof m.rev !== 'number' || typeof m.updatedAt !== 'number' || typeof m.total !== 'number') return null
  if (!Number.isInteger(m.rev) || !Number.isInteger(m.total)) return null
  return { rev: m.rev, updatedAt: m.updatedAt, total: m.total }
}

function readChunks(area: Record<string, unknown>): SyncChunk[] {
  const chunks: SyncChunk[] = []
  for (const [key, value] of Object.entries(area)) {
    if (key.startsWith(CHUNK_PREFIX) && isSyncChunk(value)) chunks.push(value)
  }
  return chunks
}

/** 远端 settings 整体采用，但 syncEnabled 位保留本端值（缺失/损坏时保留语义等价于 false） */
async function mergeRemoteSettingsKeepingLocalSyncEnabled(remoteRaw: string): Promise<string> {
  try {
    const localRaw = (await chrome.storage.local.get([SETTINGS_KEY]))[SETTINGS_KEY]
    const remote = JSON.parse(remoteRaw) as Record<string, unknown>
    const localEnabled = typeof localRaw === 'string' && (JSON.parse(localRaw) as Record<string, unknown>).syncEnabled === true
    return JSON.stringify({ ...remote, syncEnabled: localEnabled })
  } catch {
    return remoteRaw // 本端 settings 损坏等异常：退化为整体采用远端
  }
}

async function pushOnce(): Promise<void> {
  try {
    const local = await chrome.storage.local.get([VAULT_KEY, SECURITY_KEY, SETTINGS_KEY])
    const vaultRaw = local[VAULT_KEY]
    if (typeof vaultRaw !== 'string') return // 尚无 vault（首次写入前）：无 payload 可推
    const syncAll = await chrome.storage.sync.get(null)
    const prevMeta = readMeta(syncAll[META_KEY])
    const rev = (prevMeta?.rev ?? 0) + 1
    const updatedAt = Date.now()
    const fresh = splitIntoChunks(vaultRaw, rev, updatedAt)
    const existing = readChunks(syncAll)
    const batch: Record<string, unknown> = { [META_KEY]: chunksToMeta(fresh) }
    for (const c of fresh) batch[chunkKey(c.part, c.total)] = c
    // settings 直读 local 整体一份；security 存在才同步（明文态由 pull 端同态移除）
    if (typeof local[SETTINGS_KEY] === 'string') batch[SETTINGS_SYNC_KEY] = local[SETTINGS_KEY]
    if (typeof local[SECURITY_KEY] === 'string') batch[SECURITY_SYNC_KEY] = local[SECURITY_KEY]
    await chrome.storage.sync.set(batch)
    const stale = staleChunkKeys(existing, fresh)
    if (stale.length > 0) await chrome.storage.sync.remove(stale)
    // appliedRev 先行落盘：自身 push 触发的 onChanged(sync) 拉取会因 rev 已应用而无操作（防回环）
    await chrome.storage.local.set({ [APPLIED_REV_KEY]: rev })
    const inUse = await chrome.storage.sync.getBytesInUse(null)
    await setSyncStatus(inUse > chrome.storage.sync.QUOTA_BYTES * 0.9 ? 'quota' : 'ok')
  } catch {
    // 全程异常（含 sync 配额写失败）→ error 状态；状态写入自身失败不再扩散
    await setSyncStatus('error').catch(() => {})
  }
}

async function pullOnce(): Promise<void> {
  try {
    // 关闭同步的设备不拉取：显式退出（避免他端推送意外覆写未开启同步的本端数据）
    if (!(await readSyncEnabled())) return
    const [syncAll, book] = await Promise.all([
      chrome.storage.sync.get(null),
      chrome.storage.local.get([APPLIED_REV_KEY]),
    ])
    const meta = readMeta(syncAll[META_KEY])
    if (!meta) return // 远端从未推送
    const applied = typeof book[APPLIED_REV_KEY] === 'number' ? book[APPLIED_REV_KEY] : 0
    if (meta.rev <= applied) return // 无更新
    // 只取与 meta 同版本的分片（旧 rev 残留分片在下次 push 才被 stale 清理，须排除）
    const chunks = readChunks(syncAll).filter(
      (c) => c.rev === meta.rev && c.updatedAt === meta.updatedAt && c.total === meta.total,
    )
    const payload = mergeChunks(chunks)
    if (payload === null) {
      await setSyncStatus('error')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      await setSyncStatus('error')
      return
    }
    const batch: Record<string, unknown> = {}
    const removes: string[] = []
    if (isEncryptedVault(parsed)) {
      const sec = syncAll[SECURITY_SYNC_KEY]
      // 密文缺 sync:security 属不一致态：拒绝应用（防「security 在但 vault 密文无对应口令包裹」错位）
      if (typeof sec !== 'string') {
        await setSyncStatus('error')
        return
      }
      batch[VAULT_KEY] = payload
      batch[SECURITY_KEY] = sec
    } else {
      // 远端明文：LWW 跟随移除本地 security（与 store 落盘时「盘上 security 已删则跟随明文」同态）
      batch[VAULT_KEY] = payload
      removes.push(SECURITY_KEY)
    }
    if (typeof syncAll[SETTINGS_SYNC_KEY] === 'string') {
      // 保留本端 syncEnabled 位：同步开关是每设备显式意志，远端 settings 整体采用但开关位不跟随
      // （否则 B 关闭同步后 A 的推送会把 B 重新拉开）
      batch[SETTINGS_KEY] = await mergeRemoteSettingsKeepingLocalSyncEnabled(syncAll[SETTINGS_SYNC_KEY])
    }
    batch[APPLIED_REV_KEY] = meta.rev
    await chrome.storage.local.set(batch)
    if (removes.length > 0) await chrome.storage.local.remove(removes)
    await setSyncStatus('ok')
  } catch {
    await setSyncStatus('error').catch(() => {})
  }
}

/** 同步区键可能批量变化（一次 set → 一条 onChanged），且 push/pull 均为多步写：
 *  用「在途 + 待再跑一轮」串行化，防并发交错（如同 rev 双写产生 updatedAt 混杂分片） */
function mkSerialized(run: () => Promise<void>): () => Promise<void> {
  let inFlight = false
  let pending = false
  return () => {
    if (inFlight) {
      pending = true
      return Promise.resolve()
    }
    inFlight = true
    const loop = async (): Promise<void> => {
      do {
        pending = false
        await run()
      } while (pending)
      inFlight = false
    }
    return loop().catch(() => {
      inFlight = false
    })
  }
}

/** 推送：页面端 commit/commitSettings 后经 sendMessage({type:'sync-push'}) 调度到达此处。
 *  syncEnabled 在此复核（页面端已短路，双保险）：false 直接返回 */
export const pushSync = mkSerialized(async () => {
  if (!(await readSyncEnabled())) return
  await pushOnce()
})

/** 拉取：storage.onChanged(sync 区) 任一键变化即尝试；仅远端 rev 更新时应用 */
export const pullSyncIfNewer = mkSerialized(pullOnce)

/** 关闭同步时写入 off 状态（options 页 setSyncEnabled(false) 调用；页面端直写 local 区，
 *  免 background 消息往返）：UI 状态条据此显示「未启用」 */
export function markSyncOff(): Promise<void> {
  return setSyncStatus('off')
}
