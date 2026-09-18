/**
 * 云同步编排：本地明文 vault 与云端加密 envelope 的同步（真 last-write-wins + 冲突副本保留）。
 *
 * localHash 参数是调用方持有的 cloudRev（上次已知云端内容 hash）；本地内容 hash 每次现算，不依赖它。
 *
 * 分支语义（按序判定）：
 * - 云端不存在：createBackupEnvelope 加密本地 → put → 回读校验 → uploaded
 * - remoteHash === sha256(vaultJson)：远端字节摘要与本地明文摘要一致 → in-sync（不写云端）。
 *   勘误（2026-09-18 审查）：生产形态远端恒为 envelope 密文，此判据不可达；该分支仅在测试/mock
 *   形态（远端存明文）下短路，生产「内容未变→跳过」去重由宿主自动通道的明文内容 hash 门承担
 *   （cloudRunner/desktop autoBackup，属后续任务）
 * - remoteHash === cloudRev：远端未变、本地已改（本地较新）→ 推送本地 envelope → 回读校验 → uploaded
 * - 其余（远端已变且与本地不同）：openBackupEnvelope 解远端——
 *   - 成功：先经 onConflictBackup 把本地内容保存为加密冲突副本（envelope 字节），再采用远端覆盖本地——
 *     cloudRev 缺失（首次接云）为 downloaded，有基线为 conflict-resolved
 *   - 失败（口令错/结构坏）：抛中文错误，不做任何写操作
 *
 * uploaded 两分支均做 put 后 get 回读 sha256 比对，防止假写成功。
 *
 * envelopeJson 仅在 uploaded / downloaded / conflict-resolved 分支出现：
 * - uploaded 为本次上传的 envelope JSON（密文）；
 * - downloaded / conflict-resolved 为解密后的远端 vault JSON（明文）。
 * in-sync 分支返回中**不包含** envelopeJson——该字段语义因密文/明文而异，
 * 避免调用方误把 envelope JSON 当作 vault JSON 使用。如需重新拉取 envelope，调用方自行 backend.get。
 *
 * M20：编排层不持有「待确认覆盖」的 UI 状态（pending）——那属于调用方（CloudCard）的视图状态。
 *  fail path 抛错后是否清空 pending 由调用方决定：故意不复位，让用户能继续看到上一次「待确认」
 *  的远端覆盖（避免同步失败意外清掉 pending）。本层保持纯函数语义，不引入 UI 状态耦合。
 */
import { createBackupEnvelope, openBackupEnvelope, type KdfProfile } from '../backup/envelope'
import type { CloudBackend } from './backend'

export interface CloudSyncOutcome {
  action: 'uploaded' | 'downloaded' | 'conflict-resolved' | 'in-sync'
  conflictBackup?: string
  /** uploaded 为 envelope JSON（密文）；downloaded / conflict-resolved 为远端 vault JSON（明文）；in-sync 不含 */
  envelopeJson?: string
}

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
  onConflictBackup?: (bytes: Uint8Array) => string | null | void | Promise<string | null | void>
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
 * 供 syncWithCloud 的 uploaded 分支与多目标收敛（multiTarget）复用。
 * 返回 hash 为本次上传信封字节的 sha256 摘要（与 cloudRev/远端字节口径一致），envelopeJson 为上传的密文 envelope JSON。
 */
export async function pushEnvelope(opts: {
  backend: CloudBackend
  path: string
  vaultJson: string
  password: string
  profile?: KdfProfile
}): Promise<{ hash: string; envelopeJson: string }> {
  const { backend, path, vaultJson, password, profile } = opts
  const envelopeJson = JSON.stringify(await createBackupEnvelope(vaultJson, password, profile))
  const bytes = new TextEncoder().encode(envelopeJson)
  const hash = await sha256Hex(bytes)
  await backend.put(path, bytes)
  const readBack = await backend.get(path)
  if (readBack === null || (await sha256Hex(readBack)) !== hash) {
    throw new Error('云端校验失败：上传内容与回读不一致')
  }
  return { hash, envelopeJson }
}

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
