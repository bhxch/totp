/**
 * 云源/保管区存储域（extension 宿主实现，纯逻辑可测；plan16 T13 源化后职责）：
 * - sources 域读写（loadSourcesImpl/saveSourcesImpl）：core loadSources/saveSources 包装，
 *   语义与 desktop 的 *Impl 一致（源元数据明文存 settings 域 backupSources 键）；
 * - 旧多目标键（cloudCreds/cloudCred/cloudRevs/cloudRev）→ 源模型 + DEK 保管区的一次性迁移
 *   （migrateLegacySources）：R2 起实现下沉 core 单点（backup/legacyCloudMigrate，即本端
 *   审查修复语义），本模块仅改名重导出委托——desktop 委托同一实现后两端迁移收敛。
 * - 冲突副本命名与自动状态格式化（conflictBackupName/formatAutoStatusText）不变。
 * 旧 createCloudCredStore（cloudCreds/cloudRevs 四成员）已随 T13 删除：新读取统一走
 * core loadSources/loadSourceRevs，旧键仅出现在 core 迁移实现与本模块 hasLegacyCloudKeys 判据内。
 */
import {
  conflictBackupFileName, loadSources, saveSources,
  type BackupSource, type StorageAdapter,
} from '@totp/core'

const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_CREDS_KEY = 'cloudCreds'

// ---------- sources 域（core 包装，宿主注入 adapter；与 desktop loadSourcesImpl/saveSourcesImpl 同语义） ----------

export function loadSourcesImpl(adapter: StorageAdapter): Promise<BackupSource[]> {
  return loadSources(adapter)
}

export function saveSourcesImpl(adapter: StorageAdapter, sources: BackupSource[]): Promise<void> {
  return saveSources(adapter, sources)
}

// ---------- 旧多目标键 → 源模型迁移（R2 起实现下沉 core，本端仅改名重导出委托） ----------

/** 宿主旧名 migrateLegacySources 保留（options App.vue 调用点不动），实现即 core 单点版本 */
export { migrateLegacyCloudSources as migrateLegacySources } from '@totp/core'

/** 翻译函数注入（宿主传 i18n.global.t 包装 / 测试传 key→文案映射；与 ui cloudRunner deps.t 同签名） */
export type TranslateFn = (key: string, params?: Record<string, unknown>) => string

/** 滚动删除提示文案（审查 Minor：deleted=0 时「清理 0 份旧云备份」无信息量）：
 *  deleted>0 → cloudAuto.retentionDeleted「{name} 清理 N 份旧云备份」；deleted=0 → null（宿主不追加提示）；
 *  deleted<0（后端不支持远端清理的哨兵值）→ cloudAuto.retentionUnsupported「{name} 后端不支持远端清理」。
 *  D2 R1 key 化（对齐 desktop desktop.retentionCleaned/retentionUnsupported 模式）：t 由宿主注入，
 *  记录时翻译——提示并入 summary 随 cloudAutoStatus 落盘，存什么显示什么，不回填旧记录 */
export function retentionDeletedNote(t: TranslateFn, name: string, deleted: number): string | null {
  if (deleted === 0) return null
  return deleted > 0
    ? t('cloudAuto.retentionDeleted', { name, count: deleted })
    : t('cloudAuto.retentionUnsupported', { name })
}

/** 旧凭据键（cloudCreds/cloudCred）是否仍存在于 storage（审查 I6：迁移被跳过/失败后宿主据此置
 *  UI 提示，告知启用加密后将自动迁移；成功迁移后旧键已删，本函数自然返回 false，提示随之消失）。
 *  审查修复：只判凭据键——孤儿 revs 键（cloudRevs/cloudRev，纯 hash 基线）对新模型无影响、
 *  不构成「待迁移配置」，由 migrateLegacySources 的无凭据可迁出口顺带清理，否则
 *  「cloudCreds 已删、cloudRevs 残留」的中断形态重跑永不收敛、提示每次挂载重新置位。
 *  凭据键坏 JSON 滞留防数据丢失维持现状（提示在但迁移不跑，键读不出绝不删）。
 *  任一键读到即 true；读取异常按 false */
export async function hasLegacyCloudKeys(adapter: StorageAdapter): Promise<boolean> {
  for (const key of [CLOUD_CREDS_KEY, CLOUD_CRED_KEY]) {
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
 *  缺字段/坏 JSON/空值 → null（卡片显示「暂无」）。ok=null 渲染「跳过」（写侧 summary 仅存原因，
 *  前缀由本函数拼装）；旧 JSON 的 ok 恒为 true/false，照常渲染成功/失败。
 *  与 desktop autoBackup.formatAutoStatusText 同款语义：options App.vue loadAutoStatus 委托本实现，
 *  抽出供三态单测（审查 Minor-2，放 cloudCredStore 因同属 cloud 存储域纯逻辑可测模块）。
 *  入参含 storageAdapter.get 返回的 null（键不存在）：!raw 已统一兜住 null/undefined/空串。
 *  D2 R1 key 化：三态标签与冒号分隔符走 cloudAuto.statusOk/statusFailed/statusSkipped/statusSep，
 *  展示时取词（本函数仅渲染 cloudAutoStatus 落盘内容；summary 原文为记录时翻译，不回填旧记录） */
export function formatAutoStatusText(raw: string | null | undefined, t: TranslateFn): string | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as { at?: unknown; ok?: unknown; summary?: unknown }
    if (typeof s.at !== 'number' || typeof s.summary !== 'string' || s.summary === '') return null
    const d = new Date(s.at)
    const p = (n: number) => String(n).padStart(2, '0')
    const label = s.ok === null ? t('cloudAuto.statusSkipped') : s.ok === true ? t('cloudAuto.statusOk') : t('cloudAuto.statusFailed')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${label}${t('cloudAuto.statusSep')}${s.summary}`
  } catch {
    return null
  }
}
