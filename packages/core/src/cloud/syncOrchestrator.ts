/**
 * 云同步编排：本地明文 vault 与云端加密 envelope 的单向同步（last-write-wins + 冲突副本保留）。
 *
 * 分支语义：
 * - 云端不存在：createBackupEnvelope 加密本地 → put → uploaded（hash 为所传字节摘要，调用方存为 cloudRev）
 * - 云端存在且内容 hash 与 localHash 一致：in-sync（回读校验，不写云端）
 * - 不一致且远端可用当前口令解密（远端较新或本地曾推）：先经 onConflictBackup 保留本地冲突副本，
 *   再以远端覆盖本地——localHash 缺失（首次接云）为 downloaded，有基线但内容不同为 conflict-resolved
 * - 不一致且解密失败（口令错/结构坏）：抛中文错误，不做任何写操作
 *
 * envelopeJson 含义按分支：uploaded 为本次上传的 envelope JSON；in-sync 为云端原始 envelope JSON 文本；
 * downloaded / conflict-resolved 为解密后的远端 vault JSON（调用方据此覆盖本地存储）。
 */
import { createBackupEnvelope, openBackupEnvelope } from '../backup/envelope'
import type { CloudBackend } from './backend'

export interface CloudSyncOutcome {
  action: 'uploaded' | 'downloaded' | 'conflict-resolved' | 'in-sync'
  conflictBackup?: string
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
  /** 冲突分支回调：把本地内容持久化为冲突副本，可返回文件名（回填到 outcome.conflictBackup）。 */
  onConflictBackup?: (bytes: Uint8Array) => string | null | void | Promise<string | null | void>
  onCredChange?: never
}

/** SHA-256 摘要转小写 hex（crypto.subtle）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function syncWithCloud(
  opts: SyncWithCloudOpts,
): Promise<CloudSyncOutcome & { hash: string; envelopeJson: string }> {
  const { backend, path, vaultJson, password, localHash, onConflictBackup } = opts

  const remote = (await backend.exists(path)) ? await backend.get(path) : null
  if (remote === null) {
    const envelopeJson = JSON.stringify(await createBackupEnvelope(vaultJson, password))
    const bytes = new TextEncoder().encode(envelopeJson)
    await backend.put(path, bytes)
    return { action: 'uploaded', hash: await sha256Hex(bytes), envelopeJson }
  }

  const hash = await sha256Hex(remote)
  if (localHash !== null && hash === localHash) {
    return { action: 'in-sync', hash, envelopeJson: new TextDecoder().decode(remote) }
  }

  let remoteVaultJson: string
  try {
    remoteVaultJson = await openBackupEnvelope(JSON.parse(new TextDecoder().decode(remote)), password)
  } catch {
    throw new Error('云端备份口令不匹配，无法合并——请确认口令或手动下载处理')
  }

  // 远端可解密但与已知基线不同：先保留本地冲突副本，再以远端覆盖本地（LWW，远端胜）
  let conflictBackup: string | undefined
  if (onConflictBackup) {
    const name = await onConflictBackup(new TextEncoder().encode(vaultJson))
    if (typeof name === 'string' && name.length > 0) conflictBackup = name
  }
  return {
    action: localHash === null ? 'downloaded' : 'conflict-resolved',
    conflictBackup,
    hash,
    envelopeJson: remoteVaultJson,
  }
}
