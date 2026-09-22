/**
 * 云同步编排：rev 逻辑时钟四分支判定（spec §1.3/§1.4）。
 *
 * 基线不再是字节 hash（密文随机 IV/盐使字节摘要每次必变，导致旧实现「in-sync 生产不可达」、
 * 每轮全量重推），改由 v3 信封 sync 头的 rev（单调逻辑时钟）+ 本端 SourceSyncState
 * （lastKnownRemoteRev + baseSnapshot 共同祖先快照）承载。内容比对一律走规范化
 * contentHash（canonical.ts，稳定键序），与字节形态解耦。
 *
 * syncWithCloudRev 分支语义（按序判定；remoteChanged 含 v2 远端 header===null → 恒视为已变）：
 * - 云端不存在：v3 信封上传（rev = lastKnownRemoteRev+1，首推为 1）→ uploaded
 * - 双方未动（remoteRev==已知 且 本地==baseSnapshot）：in-sync 零写
 * - 远端已变但解密内容与本地一致：in-sync 仅刷基线（调用方以返回 remoteRev 落 state）——
 *   对端全量重推同内容时不再沉淀无意义副本或回推
 * - 远端已变、本地未动：downloaded（appliedVaultJson=远端明文；v2 远端同走此保守内容比对路径）
 * - 云端未动、本地已改：uploaded（rev = remoteRev+1）
 * - 双方都动：三方合并（mergeVaults；远端 baseContentHash 与本地 baseSnapshot 不匹配 →
 *   降级两方合并）→ preview 只返回预览；apply 先存本地旧内容加密副本（onConflictBackup，
 *   副本失败使本次同步失败——先存副本再覆盖的安全序），再上传合并结果（rev = remoteRev+1）
 *
 * 口令不匹配/远端结构坏 → 抛既有中文错误，不做任何写操作。pushEnvelope 保留 put 后 get
 * 回读校验（字节一致），防止假写成功。
 *
 * pushEnvelope 的 sync 参数缺省时仍写 v2 信封：旧调用方（本地备份形态）行为不变。
 *
 * 旧字节 hash 编排 syncWithCloud 暂保留（@deprecated）：multiTarget.ts 在 Task 8 重写后删除。
 */
import {
  createBackupEnvelope,
  createSyncEnvelope,
  DEFAULT_KDF_PROFILE,
  openBackupEnvelope,
  readSyncHeader,
  type CloudSyncMeta,
  type KdfProfile,
} from '../backup/envelope'
import type { CloudBackend } from './backend'
import { contentHash } from './canonical'
import { mergeVaults, type EntryConflict } from '../merge/vaultMerge'
import type { SourceSyncState } from './syncState'

export interface CloudSyncOutcome {
  action: 'uploaded' | 'downloaded' | 'conflict-resolved' | 'in-sync'
  conflictBackup?: string
  /** uploaded 为 envelope JSON（密文）；downloaded / conflict-resolved 为远端 vault JSON（明文）；in-sync 不含 */
  envelopeJson?: string
}

/** 冲突副本回调返回值：文件名（回填 outcome.conflictBackup）/ null（无副本）/ void（fire-and-forget），
 *  同步或经 Promise。此前在 syncOrchestrator / multiTarget / ui cloudRunner 三处逐字重复（T6 审查） */
export type ConflictBackupResult = string | null | void | Promise<string | null | void>

export interface SyncWithCloudOpts {
  backend: CloudBackend
  path: string
  /** 当前本地明文 vault */
  vaultJson: string
  /** envelope 口令（会话缓存由调用方持有） */
  password: string
  /** 上次已知云端内容 hash（cloudRev）；null 表示从未接云 */
  localHash: string | null
  /** 冲突分支回调：把本地内容持久化为加密冲突副本（参数为 envelope JSON 字节，可被 openBackupEnvelope 恢复），可返回文件名（回填到 outcome.conflictBackup）。 */
  onConflictBackup?: (bytes: Uint8Array) => ConflictBackupResult
  /** KDF 档位（设计 §2）：本次上传/冲突副本 envelope 的生成档位；缺省 balanced */
  profile?: KdfProfile
  /** 编译期防误传哨兵（类型为 never）：单目标 syncWithCloud 不接受 onCredChange——凭据回写（如
   *  gdrive 首推回存 fileId）由宿主 runner 层负责，编排层不感知凭据；调用方误传此属性会在类型
   *  检查期报错，防止误以为本层会处理凭据变更 */
  onCredChange?: never
}

/** SHA-256 摘要转小写 hex（crypto.subtle）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 加密本地 vault → put → 回读 sha256 比对（不一致抛中文错误）。
 * 供多目标收敛（multiTarget）与 syncWithCloudRev 上传分支复用。
 * 返回 hash 为本次上传信封字节的 sha256 摘要（与 cloudRev/远端字节口径一致），envelopeJson 为上传的密文 envelope JSON。
 *
 * sync 提供时写 v3 云同步信封（rev 逻辑时钟，spec §1.1）；缺省保持 v2（本地备份形态）——旧调用不传时行为不变。
 */
export async function pushEnvelope(opts: {
  backend: CloudBackend
  path: string
  vaultJson: string
  password: string
  profile?: KdfProfile
  /** 云同步元数据头（rev/deviceId/baseRev/baseContentHash）；提供时产 v3 信封 */
  sync?: CloudSyncMeta
}): Promise<{ hash: string; envelopeJson: string }> {
  const { backend, path, vaultJson, password, profile, sync } = opts
  const envelopeJson = JSON.stringify(
    sync
      ? await createSyncEnvelope(vaultJson, password, profile ?? DEFAULT_KDF_PROFILE, sync)
      : await createBackupEnvelope(vaultJson, password, profile),
  )
  const bytes = new TextEncoder().encode(envelopeJson)
  const hash = await sha256Hex(bytes)
  await backend.put(path, bytes)
  const readBack = await backend.get(path)
  if (readBack === null || (await sha256Hex(readBack)) !== hash) {
    throw new Error('云端校验失败：上传内容与回读不一致')
  }
  return { hash, envelopeJson }
}

/** @deprecated 由 syncWithCloudRev 取代，Task 8 重写 multiTarget 后删除。 */
export async function syncWithCloud(opts: SyncWithCloudOpts): Promise<CloudSyncOutcome & { hash: string }> {
  const { backend, path, vaultJson, password, localHash: cloudRev, onConflictBackup, profile } = opts

  const remote = (await backend.exists(path)) ? await backend.get(path) : null
  if (remote === null) {
    return { action: 'uploaded', ...(await pushEnvelope({ backend, path, vaultJson, password, profile })) }
  }

  const remoteHash = await sha256Hex(remote)
  const vaultHash = await sha256Hex(new TextEncoder().encode(vaultJson))
  if (remoteHash === vaultHash) {
    // in-sync：不返回 envelopeJson——其语义为密文/明文混用，调用方需要时应自行 backend.get
    return { action: 'in-sync', hash: remoteHash }
  }
  // 远端未变（与 cloudRev 一致）、本地已改：本地较新，推送
  if (cloudRev !== null && remoteHash === cloudRev) {
    return { action: 'uploaded', ...(await pushEnvelope({ backend, path, vaultJson, password, profile })) }
  }

  // 远端已变且与本地不同：可解密则保留本地冲突副本并采用远端；不可解密抛中文错误
  let remoteVaultJson: string
  try {
    remoteVaultJson = await openBackupEnvelope(JSON.parse(new TextDecoder().decode(remote)), password)
  } catch {
    throw new Error('云端备份口令不匹配，无法合并——请确认口令或手动下载处理')
  }

  // 下载后内容比对（跨端同步审查 C1）：解密成功且与本地一致 → in-sync 仅刷新基线（hash=远端字节
  // 摘要），不存冲突副本、不收敛回推——envelope 密文随机盐/IV 使字节摘要必不等于任何旧基线，
  // 若此处不比对内容，对端每次全量重推都会把「内容相同的无意义副本」沉淀为 conflict-resolved。
  // 与头部 in-sync 分支（mock 形态短路）语义一致：调用方以返回 hash 刷新基线即完成去重。
  if (remoteVaultJson === vaultJson) {
    return { action: 'in-sync', hash: remoteHash }
  }

  // 冲突副本与备份同形态：createBackupEnvelope 加密后的 envelope JSON 字节（密文落盘，恢复链路与备份卡一致）
  let conflictBackup: string | undefined
  if (onConflictBackup) {
    const copyJson = JSON.stringify(await createBackupEnvelope(vaultJson, password, profile))
    const name = await onConflictBackup(new TextEncoder().encode(copyJson))
    if (typeof name === 'string' && name.length > 0) conflictBackup = name
  }
  return {
    action: cloudRev === null ? 'downloaded' : 'conflict-resolved',
    conflictBackup,
    hash: remoteHash,
    envelopeJson: remoteVaultJson,
  }
}

// ---- rev 逻辑时钟判定（spec §1.3/§1.4；取代上方 syncWithCloud 的字节 hash 判定）----

export type RevSyncAction = 'uploaded' | 'downloaded' | 'merged' | 'in-sync'

export interface RevSyncOutcome {
  action: RevSyncAction
  /** 本轮读到的云端逻辑时钟（v2/无头远端与云端无对象均为 0）；in-sync 刷基线时由调用方回写 state */
  remoteRev: number
  /** uploaded / merged 写入的新 rev；preview 恒缺省 */
  newRev?: number
  /** downloaded / merged 为采纳到本地的 vault 明文 JSON；uploaded / in-sync 不含 */
  appliedVaultJson?: string
  /** merged 分支的条目级冲突记录（mergeVaults 产出） */
  conflicts?: EntryConflict[]
  /** true=远端 baseContentHash 与本地 baseSnapshot 校验失败，走两方合并降级 */
  mergeDegraded?: boolean
}

export interface SyncWithCloudRevOpts {
  backend: CloudBackend
  path: string
  /** 当前本地明文 vault */
  vaultJson: string
  /** envelope 口令（会话缓存由调用方持有） */
  password: string
  /** KDF 档位：本次上传/冲突副本 envelope 的生成档位；缺省 balanced */
  profile?: KdfProfile
  /** 本端持久 rev 状态（上次已知远端 rev + 共同祖先快照） */
  state: SourceSyncState
  /** 本机设备标识（写入 v3 sync 头） */
  deviceId: string
  /** preview：只判定不落任何写（不 backend.put、不存冲突副本）；缺省 apply */
  mode?: 'apply' | 'preview'
  /** merged 分支回调：把合并前的本地旧内容持久化为加密冲突副本（v2 envelope 字节）。
   *  reject/throw 使本次同步失败（先存副本再覆盖的安全序——不吞掉后照常上传合并结果）。 */
  onConflictBackup?: (bytes: Uint8Array) => ConflictBackupResult
}

/** rev 逻辑时钟同步：拉远端 → 四分支判定（in-sync / downloaded / uploaded / merged）。
 *  口令不匹配或远端结构坏抛中文错误且零写；preview 模式零写零副本。 */
export async function syncWithCloudRev(opts: SyncWithCloudRevOpts): Promise<RevSyncOutcome> {
  const { backend, path, vaultJson, password, profile, state, deviceId, onConflictBackup } = opts
  const mode = opts.mode ?? 'apply'
  const knownRev = state.lastKnownRemoteRev ?? 0

  const remote = (await backend.exists(path)) ? await backend.get(path) : null
  if (remote === null) {
    // 云端无对象：rev 从本端已知时钟续起（对象被外部删除后重推不回退时钟），首推为 1
    if (mode === 'preview') return { action: 'uploaded', remoteRev: 0 }
    const newRev = knownRev + 1
    await pushEnvelope({ backend, path, vaultJson, password, profile,
      sync: { rev: newRev, deviceId, baseRev: knownRev, baseContentHash: await contentHash(state.baseSnapshot ?? vaultJson) } })
    return { action: 'uploaded', remoteRev: 0, newRev }
  }

  // 解远端（口令错/结构坏 → 既有中文错误，不做任何写操作）
  let parsed: unknown
  let remoteJson: string
  try {
    parsed = JSON.parse(new TextDecoder().decode(remote))
    remoteJson = await openBackupEnvelope(parsed, password)
  } catch {
    throw new Error('云端备份口令不匹配，无法合并——请确认口令或手动下载处理')
  }
  const header = readSyncHeader(parsed) // v2/垃圾 → null = 无版本祖先（§1.4 保守路径）
  const remoteRev = header?.rev ?? 0
  const remoteContentHash = await contentHash(remoteJson)
  const localUnchanged =
    state.baseSnapshot !== null && (await contentHash(vaultJson)) === (await contentHash(state.baseSnapshot))
  // v2 远端（header===null）恒视为远端已变：rev 未知，只能走内容比对保守路径
  const remoteChanged = remoteRev !== knownRev || header === null

  if (!remoteChanged && localUnchanged) return { action: 'in-sync', remoteRev }
  if (remoteChanged && localUnchanged && remoteContentHash === (await contentHash(vaultJson))) {
    // 内容相等仅刷基线（「downloaded」意义上的去重）：对端重推同内容，密文随机 IV 使 rev 必变，
    // 按内容口径判定相等 → in-sync，调用方以返回 remoteRev 落 state，零写零副本
    return { action: 'in-sync', remoteRev }
  }
  if (remoteChanged && localUnchanged) {
    return { action: 'downloaded', remoteRev, appliedVaultJson: remoteJson }
  }
  if (!remoteChanged) {
    // 云端未动、本地已改 → 纯上传，base 声明为「旧远端 + 本地新内容」
    if (mode === 'preview') return { action: 'uploaded', remoteRev }
    const newRev = remoteRev + 1
    await pushEnvelope({ backend, path, vaultJson, password, profile,
      sync: { rev: newRev, deviceId, baseRev: remoteRev, baseContentHash: await contentHash(vaultJson) } })
    return { action: 'uploaded', remoteRev, newRev }
  }

  // 双方都动 → 三方合并；base 前提（共同祖先内容）校验失败则降级两方合并（base=null）
  const baseOk =
    header !== null && state.baseSnapshot !== null && header.baseContentHash === (await contentHash(state.baseSnapshot))
  const merged = mergeVaults(baseOk ? JSON.parse(state.baseSnapshot!) : null, JSON.parse(vaultJson), JSON.parse(remoteJson))
  const mergedJson = JSON.stringify(merged.vault)
  if (mode === 'preview') {
    // 预览只读：不 put、不存副本、无 newRev
    return { action: 'merged', remoteRev, appliedVaultJson: mergedJson, conflicts: merged.conflicts, mergeDegraded: merged.degraded }
  }
  // 先存副本再覆盖（安全序）：副本为合并前的本地旧内容（v2 envelope 字节，恢复链路与备份一致）；
  // 回调 reject/throw 原样上抛 → 本次同步失败，绝不吞掉后照常上传合并结果
  if (onConflictBackup) {
    const copyJson = JSON.stringify(await createBackupEnvelope(vaultJson, password, profile))
    await onConflictBackup(new TextEncoder().encode(copyJson))
  }
  const newRev = remoteRev + 1
  await pushEnvelope({ backend, path, vaultJson: mergedJson, password, profile,
    sync: { rev: newRev, deviceId, baseRev: remoteRev, baseContentHash: remoteContentHash } })
  return { action: 'merged', remoteRev, newRev, appliedVaultJson: mergedJson, conflicts: merged.conflicts, mergeDegraded: merged.degraded }
}
