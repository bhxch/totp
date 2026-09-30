/** 备份源统一模型（设计 §3）：云后端与桌面本地目录同构为「源」，同 kind 可多条，每源独立保留策略。
 *  元数据（本模块）明文存 settings 域；凭据是秘密，存 DEK 保管区（secretBag.ts）按 id 关联。 */
import type { CloudBackend } from '../cloud/backend'
import type { StorageAdapter } from '../storage/adapter'

/** 源 kind 联合由 CloudBackend['id'] 派生（R14，原为手写平行联合）：backend.ts 增删云后端后
 *  本联合自动跟进——原形态漏改时新 kind 源经 isBackupSource 的 KINDS 过滤被运行时静默丢弃；
 *  local=桌面本地目录源（desktop BackupCard 通道，不参与云同步）。 */
export type SourceKind = 'local' | CloudBackend['id']
export type Retention = { type: 'overwrite' } | { type: 'keep'; n: number; days?: number }
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

/** 后端 kind → 用户可见名（R14 单一来源；原 ui CloudCard 与 legacy 迁移实现各持一份手写表靠
 *  注释性同步）：云端五项为品牌名（各端一致，不 i18n）；local 为本地目录源默认名（与历史落盘
 *  值一致，英文界面由 ui sourceDisplayNames 做展示层回落翻译，见其「源名随数据落盘不走 i18n」注）。 */
export const BACKEND_LABEL: Record<SourceKind, string> = {
  webdav: 'WebDAV', s3: 'S3', gist: 'GitHub Gist', gdrive: 'Google Drive', onedrive: 'OneDrive', local: '本地目录',
}

/** kind 全集登记表（isBackupSource 白名单）：键集经 satisfies Record<SourceKind, boolean> 与
 *  派生联合双向锁定——增删后端后漏登记（缺键）或残留（多键）均编译期报错，取代原数组与联合
 *  「注释性同步」（数组 satisfies 只能防非法值、防不了漏项，漏项即上面的静默丢源）。 */
const KIND_TABLE = {
  webdav: true,
  s3: true,
  gist: true,
  gdrive: true,
  onedrive: true,
  local: true,
} satisfies Record<SourceKind, boolean>

const KINDS = Object.keys(KIND_TABLE) as SourceKind[]

export function normalizeRetention(x: unknown): Retention {
  const r = x as { type?: unknown; n?: unknown; days?: unknown } | null
  if (r?.type === 'keep' && typeof r.n === 'number' && Number.isInteger(r.n) && r.n >= 1) {
    // days 缺省=0=忽略天数条件（向后兼容旧数据无 days 字段）；存在但非法一律归 0
    const days = typeof r.days === 'number' && Number.isInteger(r.days) && r.days >= 0 ? r.days : 0
    return days > 0 ? { type: 'keep', n: r.n, days } : { type: 'keep', n: r.n }
  }
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
  const r = x as { type?: unknown; n?: unknown; days?: unknown } | null
  if (r === null || typeof r !== 'object') return false
  if (r.type === 'overwrite') return true
  // days 缺省合法（存量数据无此字段）；存在时须非负整数，非法整条拒绝（fail-closed）
  return (
    r.type === 'keep' && typeof r.n === 'number' && Number.isInteger(r.n) && r.n >= 1 &&
    (r.days === undefined || (typeof r.days === 'number' && Number.isInteger(r.days) && r.days >= 0))
  )
}

/** 活动目标单选归一（设计 §2）：首个 enabled 且非 local 的源=primary，其余（含 disabled 与 local）
 *  强制 replica；无 enabled 云源（全部 disabled 或仅 local enabled）时无 primary，保持输入原 role
 *  不变（缺失 role 补 replica）。local 源归桌面 BackupCard 本地通道、不参与云同步，恒不参与 primary
 *  选举（T11F：desktop saveCloudSourcesPreservingLocal 恒把保留的 local 源置于盘上列表头，按旧
 *  「首个 enabled」选举会把 local 选为 primary、云源全降 replica——云通道过滤 local 后无 primary
 *  → no primary target，用户选举静默回退） */
export function normalizeSourceRoles(sources: BackupSource[]): BackupSource[] {
  const primaryIdx = sources.findIndex((s) => s.enabled && s.kind !== 'local')
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

/**
 * 旧字节 hash 基线读取（sourceRevs 键）。
 * @deprecated 遗留口径，仅 legacy 云多目标迁移（legacyCloudMigrate.ts）平移旧基线用：新代码的
 * 源基线是 SourceSyncState（syncState.ts，rev 逻辑时钟 + baseSnapshot），不得再读写此键。
 */
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

/**
 * 旧字节 hash 基线写入；hash=null 语义为删除该源基线键（与旧 saveTargetHash 一致，非写入 null 值）。
 * @deprecated 遗留口径，仅 legacy 云多目标迁移（legacyCloudMigrate.ts）平移旧基线用：新代码的
 * 源基线是 SourceSyncState（syncState.ts，rev 逻辑时钟 + baseSnapshot），不得再读写此键。
 */
export async function saveSourceRev(adapter: StorageAdapter, id: string, hash: string | null): Promise<void> {
  const revs = await loadSourceRevs(adapter)
  if (hash === null) delete revs[id]
  else revs[id] = hash
  await adapter.set(SOURCE_REVS_KEY, JSON.stringify(revs))
}
