/**
 * desktop 旧数据迁移（plan16 T14；App.vue 双汇合点调用，纯逻辑独立模块供单测）：
 * - migrateLegacyLocalSource：旧备份偏好（localStorage backupMode/backupKeepN 的 retention + AppData
 *   backupDir 的目录）→ 默认本地源（id='local-default'）。backupSources 键已存在（含空数组）即跳过
 *   （幂等）；成功后删除 AppData backupDir 键（localStorage 两键由宿主在成功后删——node 测试环境无
 *   localStorage，键删除留宿主编排）。
 * - migrateLegacyCloudSources：旧云多目标键 cloudCreds/cloudCred/cloudRevs/cloudRev → 源模型 + DEK
 *   保管区（与 extension cloudCredStore.migrateLegacySources 同构，desktop 走 fsAdapter）：源
 *   id=旧 backend 键（保基线兼容）、凭据经注入 saveCred（=store.saveSourceCredOp）写入保管区、
 *   基线平移至 sourceRevs、先写新后删旧、幂等。
 */
import {
  loadSources, saveSourceRev, saveSources, SOURCES_KEY,
  type BackupSource, type CloudCred, type Retention, type SourceKind, type StorageAdapter,
} from '@totp/core'

/** 旧「自选备份目录」AppData 键（T14 前由 getBackupDir/setBackupDir 读写；迁移后目录入源，键删除） */
export const BACKUP_DIR_KEY = 'backupDir'

/** 默认本地源 id：dir=null（AppData/backups），旧版无目录概念时的等效落点 */
export const DEFAULT_LOCAL_SOURCE_ID = 'local-default'

/**
 * 旧备份偏好 → 默认本地源（幂等）：backupSources 键不存在才写（新装首启与老库升级各建一条
 * dir=null 默认源，retention/dir 取旧偏好——与旧版「开箱即用 AppData/backups + keep」行为连续）；
 * 返回 'migrated'（本次写入）或 'skipped'（键已存在=已迁移/用户已配置，不动任何键）。
 */
export async function migrateLegacyLocalSource(
  adapter: StorageAdapter,
  legacy: { retention: Retention; dir: string | null },
): Promise<'migrated' | 'skipped'> {
  const raw = await adapter.get(SOURCES_KEY)
  if (raw !== null) return 'skipped'
  const source: BackupSource = {
    id: DEFAULT_LOCAL_SOURCE_ID, kind: 'local', name: '本地备份',
    retention: legacy.retention, enabled: true, dir: legacy.dir,
  }
  await saveSources(adapter, [source])
  await adapter.delete(BACKUP_DIR_KEY) // dir 已入源：删 AppData 旧偏好键（先写新后删旧）
  return 'migrated'
}

// ---------- 旧云多目标键 → 源模型 + 保管区（与 extension cloudCredStore.migrateLegacySources 同构） ----------

const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_CREDS_KEY = 'cloudCreds'
const CLOUD_REV_KEY = 'cloudRev'
const CLOUD_REVS_KEY = 'cloudRevs'

/** 旧目标 backend → 用户可见名（与 ui CloudCard BACKEND_LABEL 同表；ui 未导出，宿主侧冗余一份） */
const BACKEND_LABEL: Record<SourceKind, string> = {
  webdav: 'WebDAV', s3: 'S3', gist: 'GitHub Gist', gdrive: 'Google Drive', onedrive: 'OneDrive', local: '本地目录',
}

/** 旧多目标条目（Task 8 形状）：cred + 启用态。仅迁移读取用 */
interface LegacyTarget { cred: CloudCred; enabled: boolean }

/** 旧 cloudCreds 键三态：missing=键不存在（可回退旧单对象）；bad=存在但不可解析（不迁移不删键） */
type ParsedTargets = { state: 'ok'; targets: LegacyTarget[] } | { state: 'missing' } | { state: 'bad' }

/** 宽松解析旧 cloudCreds（数组）：非数组/元素缺 backend 丢弃；键缺失 → missing；坏 JSON → bad */
function parseLegacyTargets(raw: string | null): ParsedTargets {
  if (raw === null) return { state: 'missing' }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return { state: 'bad' }
    const targets: LegacyTarget[] = []
    for (const t of parsed) {
      const o = t as { cred?: { backend?: unknown }; enabled?: unknown }
      if (typeof o?.cred?.backend === 'string' && typeof o.enabled === 'boolean') {
        targets.push({ cred: o.cred as CloudCred, enabled: o.enabled })
      }
    }
    return { state: 'ok', targets }
  } catch {
    return { state: 'bad' }
  }
}

/** 宽松解析旧 cloudCred（单对象）：有 backend 字段才认；坏 JSON/形状不符 → null */
function parseLegacySingle(raw: string | null): CloudCred | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof (parsed as { backend?: unknown }).backend === 'string') return parsed as CloudCred
    return null
  } catch {
    return null
  }
}

/**
 * 旧多目标键 → 源模型 + 保管区迁移（幂等，可重复调用）：
 * 1. 读旧凭据：cloudCreds（数组）缺失回退 cloudCred（单对象 → [{cred, enabled:true}]）；
 *    两者都无 → 直接返回 0（幂等出口，不动任何键）；坏 JSON → 返回 0 且保留旧键（读不出 = 不删）。
 * 2. 构造 BackupSource[]：id=旧 backend 键（保基线兼容）、kind=cred.backend、name=BACKEND_LABEL、
 *    retention overwrite（旧模型无每源保留策略）、enabled 原值；与盘上已有源按 id 去重后追加
 *    （中断重跑 / 前置本地源迁移已写默认源时不重复、不覆盖）。
 * 3. 先写新：saveSources 落源列表 → 逐源 deps.saveCred 写保管区 → 基线平移 saveSourceRev
 *    （cloudRevs 全表按源平移；无 cloudRevs 时旧 cloudRev 仅由唯一首源继承，同旧 loadTargetHash 语义）。
 * 4. 后删旧：全部成功才删除四个旧键；任一步抛错即中止（异常上抛），旧键原样保留，重跑自愈。
 * 返回本次实际迁移的源数（幂等重跑返回 0），供宿主状态提示。
 */
export async function migrateLegacyCloudSources(
  adapter: StorageAdapter,
  deps: { saveCred(id: string, cred: CloudCred): Promise<void> },
): Promise<number> {
  let targets: LegacyTarget[]
  try {
    const parsed = parseLegacyTargets(await adapter.get(CLOUD_CREDS_KEY))
    if (parsed.state === 'bad') return 0
    if (parsed.state === 'ok') {
      targets = parsed.targets
    } else {
      const single = parseLegacySingle(await adapter.get(CLOUD_CRED_KEY))
      if (single === null) return 0 // 单对象缺失或不可解析：无源可迁，不删键
      targets = [{ cred: single, enabled: true }]
    }
  } catch {
    return 0 // storage 读取异常：按无旧键出口，下轮重试
  }
  if (targets.length === 0) return 0

  // 构造源并与已有源按 id 去重（已有同 id=中断重跑或用户自建，元数据不覆盖）
  const existing = await loadSources(adapter)
  const migrated: BackupSource[] = targets.map((t) => ({
    id: t.cred.backend,
    kind: t.cred.backend,
    name: BACKEND_LABEL[t.cred.backend] ?? t.cred.backend,
    retention: { type: 'overwrite' },
    enabled: t.enabled,
  }))
  const merged = [...existing, ...migrated.filter((m) => !existing.some((e) => e.id === m.id))]

  // 先写新（源列表 → 凭据 → 基线），全部成功才删旧；任一步抛错旧键保留
  await saveSources(adapter, merged)
  for (const t of targets) await deps.saveCred(t.cred.backend, t.cred)

  let revs: Record<string, string> | null = null
  try {
    const raw = await adapter.get(CLOUD_REVS_KEY)
    if (raw !== null) revs = JSON.parse(raw) as Record<string, string>
  } catch {
    revs = null
  }
  const ids = new Set(migrated.map((m) => m.id))
  if (revs !== null) {
    for (const [id, hash] of Object.entries(revs)) {
      if (typeof hash === 'string' && ids.has(id)) await saveSourceRev(adapter, id, hash)
    }
  } else {
    // 无 cloudRevs → 旧 cloudRev 仅由首源继承（旧 loadTargetHash「targets[0] 继承」语义）
    try {
      const legacy = await adapter.get(CLOUD_REV_KEY)
      const first = migrated[0]
      if (legacy !== null && first) await saveSourceRev(adapter, first.id, legacy)
    } catch { /* 读失败放弃基线平移（下次同步全量重比，无损） */ }
  }

  // 后删旧：四个旧键全清（重复删除幂等）
  await adapter.delete(CLOUD_CREDS_KEY)
  await adapter.delete(CLOUD_CRED_KEY)
  await adapter.delete(CLOUD_REVS_KEY)
  await adapter.delete(CLOUD_REV_KEY)
  return migrated.length
}
