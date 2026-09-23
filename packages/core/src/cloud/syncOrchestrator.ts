/**
 * 云同步编排：rev 逻辑时钟四分支判定（spec §1.3/§1.4）。
 *
 * 基线不再是字节 hash（密文随机 IV/盐使字节摘要每次必变，导致旧实现「in-sync 生产不可达」、
 * 每轮全量重推），改由 v3 信封 sync 头的 rev（单调逻辑时钟）+ 本端 SourceSyncState
 * （lastKnownRemoteRev + baseSnapshot 共同祖先快照）承载。内容比对一律走规范化
 * contentHashVault（canonical.ts，稳定键序且剔除顶层 rev——F8 水位随加密落盘推进，
 * 非 vault 内容），与字节形态解耦。
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
 * 旧字节 hash 编排 syncWithCloud 已删（T7/T8 裁定：multiTarget 重写为 primary 裁决 + replica 收敛
 * 复制后无人消费）；deprecated 的 CloudSyncOutcome 类型已随 T9 pull 通道改造删除（T9 装配须知 6）。
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
import { contentHashVault } from './canonical'
import { mergeVaults, type EntryConflict } from '../merge/vaultMerge'
import type { SourceSyncState } from './syncState'

/** 冲突副本回调返回值：文件名（回填 outcome.conflictBackup）/ null（无副本）/ void（fire-and-forget），
 *  同步或经 Promise。此前在 syncOrchestrator / multiTarget / ui cloudRunner 三处逐字重复（T6 审查） */
export type ConflictBackupResult = string | null | void | Promise<string | null | void>

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

// ---- rev 逻辑时钟判定（spec §1.3/§1.4；取代上方 syncWithCloud 的字节 hash 判定）----

export type RevSyncAction = 'uploaded' | 'downloaded' | 'merged' | 'in-sync'

export interface RevSyncOutcome {
  action: RevSyncAction
  /** 本轮读到的云端逻辑时钟；null=远端无 rev（云端无对象或 v2 无头信封），与「rev=0」不混用。
   *  in-sync 时由调用方回写 state.lastKnownRemoteRev（null 时保持原值不动） */
  remoteRev: number | null
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
  /** 读远端路径（缺省=path）：keep 滚动保留源「读最新份、写新时间戳份」分离——不设则 keep 源
   *  恒判云端无对象整库重推，绕过合并（三方/两方都不可达），双设备并发编辑收敛退化为
   *  last-writer-wins 且败者内容被滚动删除清除（审查 Important-2）。rev 判定/下载/合并全部以
   *  readPath 读到的对象为「远端」；写入（uploaded/merged 推平）恒走 path */
  readPath?: string
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
  const readPath = opts.readPath ?? path
  const mode = opts.mode ?? 'apply'
  const knownRev = state.lastKnownRemoteRev ?? 0

  const remote = (await backend.exists(readPath)) ? await backend.get(readPath) : null
  if (remote === null) {
    // 云端无对象：rev 从本端已知时钟续起（对象被外部删除后重推不回退时钟），首推为 1
    if (mode === 'preview') return { action: 'uploaded', remoteRev: null }
    const newRev = knownRev + 1
    await pushEnvelope({ backend, path, vaultJson, password, profile,
      sync: { rev: newRev, deviceId, baseRev: knownRev, baseContentHash: await contentHashVault(state.baseSnapshot ?? vaultJson) } })
    return { action: 'uploaded', remoteRev: null, newRev }
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
  const remoteRev = header?.rev ?? null // null=远端无 rev（v2 无头），与「rev=0」不混用
  // 内容 hash 一律 contentHashVault（剔除顶层 rev——F8 水位随加密落盘推进，非 vault 内容；
  // 含 rev 会使采纳落盘后恒判「本地已动」：冗余云写/误报合并副本，见 canonical.ts）
  const remoteContentHash = await contentHashVault(remoteJson)
  const localContentHash = await contentHashVault(vaultJson)
  const baseContentHash = state.baseSnapshot !== null ? await contentHashVault(state.baseSnapshot) : null
  const localUnchanged = baseContentHash !== null && localContentHash === baseContentHash
  // v2 远端（header===null）恒视为远端已变：rev 未知，只能走内容比对保守路径。
  // 同 rev 碰撞核验（审查 Critical-1）：无 CAS 时两设备可先后写同一 rev（先后都成功），
  // rev 相等不代表内容一致——baseSnapshot 存在而远端内容不符时仍视为已变，走下载/合并，
  // 不让双方永久 in-sync 掩盖分歧、下次本地改动静默覆盖对方
  const remoteChanged =
    remoteRev !== knownRev || header === null ||
    (baseContentHash !== null && remoteContentHash !== baseContentHash)

  if (!remoteChanged && localUnchanged) return { action: 'in-sync', remoteRev }
  if (remoteChanged && localUnchanged && remoteContentHash === localContentHash) {
    // 内容相等仅刷基线（「downloaded」意义上的去重）：对端重推同内容，密文随机 IV 使 rev 必变，
    // 按内容口径判定相等 → in-sync，调用方以返回 remoteRev 落 state，零写零副本
    return { action: 'in-sync', remoteRev }
  }
  if (remoteChanged && localUnchanged) {
    return { action: 'downloaded', remoteRev, appliedVaultJson: remoteJson }
  }
  if (!remoteChanged) {
    // 云端未动、本地已改 → 纯上传。base 声明为「旧远端 rev + 其内容 hash」（审查 Critical-2，
    // §1.1：baseContentHash 指 baseRev 版本即远端旧内容的规范化 hash，非本地新内容——否则对端
    // baseOk 恒失败，非降级合并不可达。不变量：!remoteChanged 蕴含远端内容==baseSnapshot；
    // 无快照时回退远端内容 hash）
    if (mode === 'preview') return { action: 'uploaded', remoteRev }
    const newRev = remoteRev + 1
    await pushEnvelope({ backend, path, vaultJson, password, profile,
      sync: { rev: newRev, deviceId, baseRev: remoteRev, baseContentHash: baseContentHash ?? remoteContentHash } })
    return { action: 'uploaded', remoteRev, newRev }
  }

  // 双方都动 → 三方合并；base 前提（共同祖先内容）校验失败则降级两方合并（base=null）
  const baseOk =
    header !== null && state.baseSnapshot !== null && header.baseContentHash === (await contentHashVault(state.baseSnapshot))
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
  // 新 rev 从读到的远端时钟续起；v2 无头（remoteRev=null）或远端回滚（rev < 本端已知）时
  // 从本端已知时钟续起，保证单调（审查 Critical-1 同类形态：v2 无头无法读钟，不静默归零）
  const newRev = Math.max(remoteRev ?? 0, knownRev) + 1
  await pushEnvelope({ backend, path, vaultJson: mergedJson, password, profile,
    sync: { rev: newRev, deviceId, baseRev: remoteRev ?? 0, baseContentHash: remoteContentHash } })
  return { action: 'merged', remoteRev, newRev, appliedVaultJson: mergedJson, conflicts: merged.conflicts, mergeDegraded: merged.degraded }
}
