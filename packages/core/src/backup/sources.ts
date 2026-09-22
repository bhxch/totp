/** 备份源统一模型（设计 §3）：云后端与桌面本地目录同构为「源」，同 kind 可多条，每源独立保留策略。
 *  元数据（本模块）明文存 settings 域；凭据是秘密，存 DEK 保管区（secretBag.ts）按 id 关联。 */
import type { StorageAdapter } from '../storage/adapter'

export type SourceKind = 'webdav' | 's3' | 'gist' | 'gdrive' | 'onedrive' | 'local'
export type Retention = { type: 'overwrite' } | { type: 'keep'; n: number }
export type SourceRole = 'primary' | 'replica'

export interface BackupSource {
  id: string
  kind: SourceKind
  /** 用户可见别名（如「家里 WebDAV」），同 kind 多份时区分用 */
  name: string
  retention: Retention
  enabled: boolean
  /** 活动目标角色（设计 §2）：primary 裁决同步、replica 收敛复制；启用源中恒恰一个 primary。
   *  存量数据缺省此字段（isBackupSource 容忍缺失），loadSources 经 normalizeSourceRoles 补齐 */
  role: SourceRole
  /** 本地源目录；null/缺省=应用数据 backups 目录 */
  dir?: string | null
}

export const SOURCES_KEY = 'backupSources'
export const SOURCE_REVS_KEY = 'sourceRevs'

const KINDS: readonly SourceKind[] = ['webdav', 's3', 'gist', 'gdrive', 'onedrive', 'local']

export function normalizeRetention(x: unknown): Retention {
  const r = x as { type?: unknown; n?: unknown } | null
  if (r?.type === 'keep' && typeof r.n === 'number' && Number.isInteger(r.n) && r.n >= 1) return { type: 'keep', n: r.n }
  return { type: 'overwrite' }
}

export function isBackupSource(x: unknown): x is BackupSource {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o['id'] === 'string' && o['id'] !== '' &&
    typeof o['kind'] === 'string' && (KINDS as readonly string[]).includes(o['kind']) &&
    typeof o['name'] === 'string' &&
    typeof o['enabled'] === 'boolean' &&
    isRetentionShape(o['retention']) &&
    // role 容忍缺失（存量数据，normalize 补齐）；出现时校验值域
    (o['role'] === undefined || o['role'] === 'primary' || o['role'] === 'replica')
  )
}

function isRetentionShape(x: unknown): boolean {
  const r = x as { type?: unknown; n?: unknown } | null
  if (r === null || typeof r !== 'object') return false
  if (r.type === 'overwrite') return true
  return r.type === 'keep' && typeof r.n === 'number' && Number.isInteger(r.n) && r.n >= 1
}

/** 活动目标单选归一（设计 §2）：首个 enabled 源=primary，其余（含 disabled）强制 replica；
 *  全部 disabled 时无 primary，保持输入原 role 不变（缺失 role 补 replica） */
export function normalizeSourceRoles(sources: BackupSource[]): BackupSource[] {
  const primaryIdx = sources.findIndex((s) => s.enabled)
  if (primaryIdx === -1) return sources.map((s) => ({ ...s, role: s.role ?? 'replica' }))
  return sources.map((s, i) => ({ ...s, role: i === primaryIdx ? 'primary' : 'replica' }))
}

export async function loadSources(adapter: StorageAdapter): Promise<BackupSource[]> {
  let raw: string | null
  try {
    raw = await adapter.get(SOURCES_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? normalizeSourceRoles(parsed.filter(isBackupSource)) : []
  } catch {
    return []
  }
}

export async function saveSources(adapter: StorageAdapter, sources: BackupSource[]): Promise<void> {
  await adapter.set(SOURCES_KEY, JSON.stringify(sources))
}

export async function loadSourceRevs(adapter: StorageAdapter): Promise<Record<string, string>> {
  let raw: string | null
  try {
    raw = await adapter.get(SOURCE_REVS_KEY)
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** hash=null 语义为删除该源基线键（与旧 saveTargetHash 一致，非写入 null 值） */
export async function saveSourceRev(adapter: StorageAdapter, id: string, hash: string | null): Promise<void> {
  const revs = await loadSourceRevs(adapter)
  if (hash === null) delete revs[id]
  else revs[id] = hash
  await adapter.set(SOURCE_REVS_KEY, JSON.stringify(revs))
}
