/**
 * desktop 旧数据迁移（plan16 T14；App.vue 双汇合点调用，纯逻辑独立模块供单测）：
 * - migrateLegacyLocalSource：旧备份偏好（localStorage backupMode/backupKeepN 的 retention + AppData
 *   backupDir 的目录）→ 默认本地源（id='local-default'）。backupSources 键已存在（含空数组）即跳过
 *   （幂等）；成功后删除 AppData backupDir 键（localStorage 两键由宿主在成功后删——node 测试环境无
 *   localStorage，键删除留宿主编排）。
 * - migrateLegacyCloudSources：R2 起实现下沉 core 单点（backup/legacyCloudMigrate，以 extension 版
 *   审查修复语义为准），本模块仅重导出委托——消除此前 desktop 版缺三项修复的迁移漂移
 *   （双缺失清 revs 孤儿键 / 合法空配置删孤儿键 / targets 按 backend 去重）。
 */
import {
  saveSources, SOURCES_KEY,
  type BackupSource, type Retention, type StorageAdapter,
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
    retention: legacy.retention, enabled: true, dir: legacy.dir, role: 'replica',
  }
  await saveSources(adapter, [source])
  await adapter.delete(BACKUP_DIR_KEY) // dir 已入源：删 AppData 旧偏好键（先写新后删旧）
  return 'migrated'
}

// ---------- 旧云多目标键 → 源模型 + 保管区（R2 起实现下沉 core，本端仅重导出委托） ----------

export { migrateLegacyCloudSources } from '@totp/core'
