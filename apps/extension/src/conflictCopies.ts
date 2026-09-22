/**
 * 冲突副本 storage.local 列表（spec §4 冲突强提示，extension 端）：废除「同步冲突时后台自动触发
 * 浏览器下载」（旧 cloudRunnerFactory.downloadConflictBackup 的 a.click() 已随本模块删除），副本改为
 * 写入 chrome.storage.local 键 'conflictCopies'（加密 envelope 原样 base64 存储，非明文），限保留最近
 * CONFLICT_COPIES_MAX=5 份、超出滚动删除最旧；.totpbackup 文件下载（导出）仅由 UI 显式调用
 * exportConflictCopy 触发。
 * 全函数首参注入 StorageAdapter（与 cloudCredStore 同口径；生产调用侧传 store.storageAdapter，
 * 测试传内存适配器）。
 */
import { base64ToBytes, bytesToBase64, type StorageAdapter } from '@totp/core'
import { conflictBackupName } from './cloudCredStore'

export const CONFLICT_COPIES_KEY = 'conflictCopies'

/** 冲突副本保留上限（spec §4：限保留最近 5 份，超出滚动删除） */
export const CONFLICT_COPIES_MAX = 5

export interface ConflictCopy {
  /** 文件名（conflict-{sourceId}-{ts}.totpbackup，匹配 READABLE_BACKUP_RE 可恢复；导出时作下载名） */
  name: string
  /** 入列表时刻（毫秒；滚动删除按入列序，列表即新在尾） */
  at: number
  /** 加密 envelope 字节（base64）——原样存储，不解密不校验 */
  bytesBase64: string
}

function isConflictCopy(x: unknown): x is ConflictCopy {
  const c = x as Partial<ConflictCopy> | null
  return typeof c?.name === 'string' && typeof c.at === 'number' && typeof c.bytesBase64 === 'string'
}

export async function listConflictCopies(adapter: StorageAdapter): Promise<ConflictCopy[]> {
  let raw: string | null = null
  try {
    raw = await adapter.get(CONFLICT_COPIES_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isConflictCopy) // 形态不符元素逐条丢弃（条粒度损坏隔离）
  } catch {
    return [] // 坏 JSON：回落空列表（副本属救灾数据，不阻断同步主流程）
  }
}

/** 追加冲突副本（runner saveConflictBackup / CloudCard 手动通道共用的落位出口）：
 *  命名与 desktop saveConflictBackupToDir 同构 conflict-{sourceId}-{ts}（sourceId 缺省=通用名），
 *  超 CONFLICT_COPIES_MAX 滚动删除最旧（列表头）。返回副本名（回填 outcome.conflictBackup /
 *  CloudPlatform.saveConflictBackup 提示形态）。 */
export async function addConflictCopy(adapter: StorageAdapter, bytes: Uint8Array, sourceId?: string): Promise<string> {
  const list = await listConflictCopies(adapter)
  const name = conflictBackupName(sourceId, new Date())
  list.push({ name, at: Date.now(), bytesBase64: bytesToBase64(bytes) })
  const capped = list.length > CONFLICT_COPIES_MAX ? list.slice(list.length - CONFLICT_COPIES_MAX) : list
  await adapter.set(CONFLICT_COPIES_KEY, JSON.stringify(capped))
  return name
}

export async function removeConflictCopy(adapter: StorageAdapter, name: string): Promise<void> {
  const list = await listConflictCopies(adapter)
  await adapter.set(CONFLICT_COPIES_KEY, JSON.stringify(list.filter((c) => c.name !== name)))
}

/** 导出（UI 显式调用才触发下载；废除后台自动下载的裁定出口）：按名取副本字节 → Blob 下载。
 *  无该名（已被滚动删除/已裁决清理）→ false 交 UI 提示。 */
export async function exportConflictCopy(adapter: StorageAdapter, name: string): Promise<boolean> {
  const copy = (await listConflictCopies(adapter)).find((c) => c.name === name)
  if (!copy) return false
  const blob = new Blob([base64ToBytes(copy.bytesBase64) as BlobPart], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = copy.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
