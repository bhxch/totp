/**
 * legacy 云多目标键 → 源模型 + DEK 保管区迁移（R2 自两端宿主下沉 core，单点实现）：
 * 旧盘 v1 数据用 cloudCreds（数组）/cloudCred（单对象）/cloudRevs/cloudRev 四键承载云多目标同步；
 * 源化（plan16 T13）后统一为 backupSources 源列表 + sourceRevs 基线 + 凭据入宿主保管区（经注入
 * saveCred 写入）。历史上 extension（cloudCredStore.migrateLegacySources）与 desktop
 * （legacyMigrate.migrateLegacyCloudSources）各持一份同构实现且已漂移——desktop 版缺三项审查修复，
 * 同一旧盘数据两端迁移产出不同结果。本模块以 extension 版语义为准（三项修复全保留）：
 * ① cloudCreds/cloudCred 双缺失出口清 revs 孤儿键（中断形态收敛）；
 * ② cloudCreds 为合法空配置（'[]'）时删自身与 revs 孤儿键（幂等早退收敛）；
 * ③ targets 按 backend 去重（旧数组同 backend 重复项不写重复 id 源）。
 * 两端宿主各留一行委托调用；仅依赖 StorageAdapter + 注入 saveCred，无平台 API。
 */
import type { CloudCred } from '../cloud/backend'
import type { StorageAdapter } from '../storage/adapter'
import { loadSources, saveSourceRev, saveSources, type BackupSource, type SourceKind } from './sources'

const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_CREDS_KEY = 'cloudCreds'
const CLOUD_REV_KEY = 'cloudRev'
const CLOUD_REVS_KEY = 'cloudRevs'

/** 旧目标 backend → 用户可见名（与 ui CloudCard BACKEND_LABEL 同表；ui 未导出，core 侧持一份，
 *  R14 收敛后删冗余） */
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
 *    两者都无 → 无凭据可迁出口，revs 孤儿键顺带清理后返回 0（审查修复：中断形态收敛）；
 *    cloudCreds 为合法空配置（'[]'）→ 删自身与 revs 孤儿后返回 0（审查修复）；坏 JSON →
 *    返回 0 且保留旧键（读不出 = 不删，防数据丢失）。
 * 2. 构造 BackupSource[]：id=旧 backend 键（保基线兼容——旧 sourceRevs 之前的 cloudRevs 键即 backend 名）、
 *    kind=cred.backend、name=BACKEND_LABEL、retention overwrite（旧模型无每源保留策略）、enabled 原值；
 *    与盘上已有源按 id 去重后追加（中断重跑 / 用户已建同 backend 源时不重复）。
 * 3. 先写新：saveSources 落源列表 → 逐源 deps.saveCred 写保管区 → 基线平移 saveSourceRev
 *    （cloudRevs 全表按源存在平移；无 cloudRevs 时旧 cloudRev 仅由唯一首源继承，同旧 loadTargetHash 语义）。
 * 4. 后删旧：全部成功才删除四个旧键；任一步抛错即中止（异常上抛），旧键原样保留，重跑自愈。
 * 返回本次实际迁移的源数（幂等重跑返回 0），供宿主状态提示。
 */
export async function migrateLegacyCloudSources(
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
      const rawSingle = await adapter.get(CLOUD_CRED_KEY)
      if (rawSingle === null) {
        // cloudCreds/cloudCred 双缺失（审查修复）：无凭据可迁的确定性出口——revs 孤儿键顺带清理
        // （纯 hash 基线，新模型无凭据可迁即无消费方），否则中断形态重跑永不收敛、宿主「待迁移」提示永驻。
        // 存在才删：完成态重跑保持「零写盘」不变量（对不存在的键不发删除指令；数据终态与
        // 无条件删除等价）
        if ((await adapter.get(CLOUD_REVS_KEY)) !== null) await adapter.delete(CLOUD_REVS_KEY)
        if ((await adapter.get(CLOUD_REV_KEY)) !== null) await adapter.delete(CLOUD_REV_KEY)
        return 0
      }
      const single = parseLegacySingle(rawSingle)
      if (single === null) return 0 // 单对象存在但不可解析：读不出 = 不删（防数据丢失，含 revs 保守保留）
      targets = [{ cred: single, enabled: true }]
    }
  } catch {
    return 0 // storage 读取异常：按无旧键出口，下轮重试
  }
  if (targets.length === 0) {
    // cloudCreds 为已读出的合法空配置（如 '[]'）（审查修复）：无任何凭据内容，删除零风险；
    // 连同 revs 孤儿键一并清理——幂等早退不收敛则提示永驻。cloudCred 单对象键不在本出口处理
    // （数组存在时旧 loadCreds 语义不回退单对象，其是否待迁移由下轮 missing 出口判定）
    await adapter.delete(CLOUD_CREDS_KEY)
    await adapter.delete(CLOUD_REVS_KEY)
    await adapter.delete(CLOUD_REV_KEY)
    return 0
  }

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
    role: 'replica',
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
