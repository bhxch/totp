/**
 * 云源/保管区存储域（extension 宿主实现，纯逻辑可测；plan16 T13 源化后职责）：
 * - sources 域读写（loadSourcesImpl/saveSourcesImpl）：core loadSources/saveSources 包装，
 *   语义与 desktop 的 *Impl 一致（源元数据明文存 settings 域 backupSources 键）；
 * - 旧多目标键（cloudCreds/cloudCred/cloudRevs/cloudRev）→ 源模型 + DEK 保管区的一次性迁移
 *   （migrateLegacySources）：源 id=旧 backend 键（保基线兼容）、凭据经注入的 saveCred
 *   （=store.saveSourceCredOp）写入保管区、基线平移至 sourceRevs、先写新后删旧、幂等。
 * - 冲突副本命名与自动状态格式化（conflictBackupName/formatAutoStatusText）不变。
 * 旧 createCloudCredStore（cloudCreds/cloudRevs 四成员）已随 T13 删除：新读取统一走
 * core loadSources/loadSourceRevs，旧键仅在本模块迁移函数内出现。
 */
import {
  conflictBackupFileName, loadSources, saveSourceRev, saveSources,
  type BackupSource, type CloudCred, type SourceKind, type StorageAdapter,
} from '@totp/core'

const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_CREDS_KEY = 'cloudCreds'
const CLOUD_REV_KEY = 'cloudRev'
const CLOUD_REVS_KEY = 'cloudRevs'

/** 旧目标 backend → 用户可见名（与 ui CloudCard BACKEND_LABEL 同表；ui 未导出，宿主侧冗余一份） */
const BACKEND_LABEL: Record<SourceKind, string> = {
  webdav: 'WebDAV', s3: 'S3', gist: 'GitHub Gist', gdrive: 'Google Drive', onedrive: 'OneDrive', local: '本地目录',
}

// ---------- sources 域（core 包装，宿主注入 adapter；与 desktop loadSourcesImpl/saveSourcesImpl 同语义） ----------

export function loadSourcesImpl(adapter: StorageAdapter): Promise<BackupSource[]> {
  return loadSources(adapter)
}

export function saveSourcesImpl(adapter: StorageAdapter, sources: BackupSource[]): Promise<void> {
  return saveSources(adapter, sources)
}

// ---------- 旧多目标键 → 源模型迁移（plan16 T13） ----------

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
 * 2. 构造 BackupSource[]：id=旧 backend 键（保基线兼容——旧 sourceRevs 之前的 cloudRevs 键即 backend 名）、
 *    kind=cred.backend、name=BACKEND_LABEL、retention overwrite（旧模型无每源保留策略）、enabled 原值；
 *    与盘上已有源按 id 去重后追加（中断重跑 / 用户已建同 backend 源时不重复）。
 * 3. 先写新：saveSources 落源列表 → 逐源 deps.saveCred 写保管区 → 基线平移 saveSourceRev
 *    （cloudRevs 全表按源存在平移；无 cloudRevs 时旧 cloudRev 仅由唯一首源继承，同旧 loadTargetHash 语义）。
 * 4. 后删旧：全部成功才删除四个旧键；任一步抛错即中止（异常上抛），旧键原样保留，重跑自愈。
 * 返回本次实际迁移的源数（幂等重跑返回 0），供宿主状态提示。
 */
export async function migrateLegacySources(
  adapter: StorageAdapter,
  deps: { saveCred(id: string, cred: CloudCred): Promise<void> },
): Promise<number> {
  // 读旧凭据：cloudCreds（数组）→ 缺失回退 cloudCred（单对象 → enabled:true）；bad（存在但不可解析）
  // 一律返回 0 且保留旧键（读不出 = 不删，绝不把可能存在的凭据当已迁移）；两者都无 → 幂等出口 0
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

  // targets 按 backend 去重（审查 Minor：旧 cloudCreds 数组内同 backend 重复项——
  // 原实现会写入重复 id 源）；首现胜（凭据与 enabled 均取首现项）
  const deduped: LegacyTarget[] = []
  const seenBackends = new Set<string>()
  for (const t of targets) {
    if (!seenBackends.has(t.cred.backend)) {
      seenBackends.add(t.cred.backend)
      deduped.push(t)
    }
  }
  const existing = await loadSources(adapter)
  const migrated: BackupSource[] = deduped.map((t) => ({
    id: t.cred.backend,
    kind: t.cred.backend,
    name: BACKEND_LABEL[t.cred.backend] ?? t.cred.backend,
    retention: { type: 'overwrite' },
    enabled: t.enabled,
  }))
  // 源列表整体按 id 去重（保留首现：existing 优先）——覆盖中断重跑/用户已建同 backend 源场景
  const mergedIds = new Set<string>()
  const merged: BackupSource[] = []
  for (const s of [...existing, ...migrated]) {
    if (!mergedIds.has(s.id)) {
      mergedIds.add(s.id)
      merged.push(s)
    }
  }

  // 先写新（源列表 → 凭据 → 基线），全部成功才删旧；任一步抛错旧键保留。
  // 凭据按去重后的 targets 全量重放（含 existing 已有同 id 源——中断重跑自愈依赖覆盖写幂等）
  await saveSources(adapter, merged)
  for (const t of deduped) await deps.saveCred(t.cred.backend, t.cred)

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

/** 旧多目标键（cloudCreds/cloudCred/cloudRevs/cloudRev）是否仍存在于 storage
 *  （审查 I6：迁移被跳过/失败后旧键滞留——宿主据此置 UI 提示，告知启用加密后将自动迁移；
 *  成功迁移后旧键已删，本函数自然返回 false，提示随之消失）。任一键读到即 true；读取异常按 false */
export async function hasLegacyCloudKeys(adapter: StorageAdapter): Promise<boolean> {
  for (const key of [CLOUD_CREDS_KEY, CLOUD_CRED_KEY, CLOUD_REVS_KEY, CLOUD_REV_KEY]) {
    if ((await adapter.get(key).catch(() => null)) !== null) return true
  }
  return false
}

// ---------- 冲突副本命名 / 自动状态格式化（本任务不变面） ----------

/** 多目标冲突副本名：conflict-{backendKey}-{yyyyMMdd-HHmmss}.totpbackup——与 desktop backupService
 *  同构（core conflictBackupFileName 取 conflict- 后缀段拼接），匹配 READABLE_BACKUP_RE 的可选
 *  backend 段，跨宿主备份列表均可恢复；sourceId/缺省保持旧名格式（T13 起参数语义=源 id，仅用于文件名区分） */
export function conflictBackupName(backendKey: string | undefined, now: Date): string {
  const base = conflictBackupFileName(now)
  return backendKey ? `conflict-${backendKey}-${base.slice('conflict-'.length)}` : base
}

/** 自动状态 JSON → 卡片展示文本（design §4.1）：「YYYY-MM-DD HH:mm 成功/失败/跳过：summary」；
 *  缺字段/坏 JSON/undefined → null（卡片显示「暂无」）。ok=null 渲染「跳过」（写侧 summary 仅存原因，
 *  前缀由本函数拼装）；旧 JSON 的 ok 恒为 true/false，照常渲染成功/失败。
 *  与 desktop autoBackup.formatAutoStatusText 同款语义：options App.vue formatAutoStatus 委托本实现，
 *  抽出供三态单测（审查 Minor-2，放 cloudCredStore 因同属 cloud 存储域纯逻辑可测模块） */
export function formatAutoStatusText(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as { at?: unknown; ok?: unknown; summary?: unknown }
    if (typeof s.at !== 'number' || typeof s.summary !== 'string' || s.summary === '') return null
    const d = new Date(s.at)
    const p = (n: number) => String(n).padStart(2, '0')
    const label = s.ok === null ? '跳过' : s.ok === true ? '成功' : '失败'
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${label}：${s.summary}`
  } catch {
    return null
  }
}
