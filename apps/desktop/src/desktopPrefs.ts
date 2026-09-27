/**
 * desktop 壳层 localStorage 偏好/状态读写（P4 自 App.vue 抽出，纯搬移行为不变）：
 * - loadBackupPrefs/persistBackupPrefs：自动备份偏好（backupAutoPrefs 键，间隔 ≥15min 钳制）——
 *   ui BackupCard（经 backupPlatform 工厂）与自动备份 runner deps 共用的唯一读写实现；
 * - loadCloudPrefs/persistCloudPrefs：云同步自动偏好（cloudAutoPrefs 键，同口径钳制）——
 *   ui CloudCard（经 cloudPlatform 工厂）与云 runner deps 共用；
 *   （R13：两键读写经 loadChannelPrefs/persistChannelPrefs 参数化收敛，钳制/归一化仅此一份）
 * - legacyRetention：旧 backupMode/backupKeepN 键迁移读取（→ 默认本地源 retention，宿主删除旧键）；
 * - recordAutoStatus/readAutoStatusText：自动通道状态键 {at, ok, summary} 写入与卡片展示文本
 *   （readAutoStatusText 委托 formatAutoStatusText 三态格式化纯函数，本体在本模块）；
 * - lastBackupHash/cloudContentHash：自动通道基线键读写（null=删键）。
 * 本地偏好存桌面 localStorage；键常量集中于此防宿主各处漂移。
 */
import type { Retention } from '@totp/core'
import {
  formatAutoStatusText as formatAutoStatusTextShared,
  normalizeAutoPrefs,
  type AutoPrefsShape, type AutoStatusLabels, type BackupAutoPrefs, type CloudAutoPrefs,
} from '@totp/ui'

// ---------- 通道自动偏好（D2/Task 11，R13 参数化收敛）----------
/** 通道自动偏好统一形态（偏好类型合一）：ui BackupAutoPrefs/CloudAutoPrefs 同构三字段，
 *  两键共用同一读写实现（loadChannelPrefs/persistChannelPrefs）；归一化（15min 钳制）经
 *  ui normalizeAutoPrefs 单点（R14），本模块只承担键绑定与存储兜底 */
type ChannelAutoPrefsShape = AutoPrefsShape

/** 参数化偏好读取：键缺失/坏 JSON → 全默认；布尔严格 === true 判定；间隔非法回落默认（60）
 *  （钳制下限 15min 与归一化规则走 ui normalizeAutoPrefs 单点，R14） */
function loadChannelPrefs<T extends ChannelAutoPrefsShape>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { ...fallback }
    return normalizeAutoPrefs(JSON.parse(raw), fallback)
  } catch {
    return { ...fallback }
  }
}

/** 参数化偏好写入：持久化失败静默（不影响功能） */
function persistChannelPrefs(key: string, p: ChannelAutoPrefsShape): void {
  try {
    localStorage.setItem(key, JSON.stringify(p))
  } catch { /* 偏好持久化失败不影响功能 */ }
}

// ---------- 自动备份偏好（D2）----------
export const BACKUP_AUTO_PREFS_KEY = 'backupAutoPrefs'
export const LAST_BACKUP_HASH_KEY = 'lastBackupHash'
const DEFAULT_AUTO_PREFS: BackupAutoPrefs = { onChange: false, onInterval: false, intervalMinutes: 60 }

/** Task 7（BackupCard）与 Task 10（自动备份 runner deps）共用的唯一读写实现（backupAutoPrefs 键绑定） */
export function loadBackupPrefs(): BackupAutoPrefs {
  return loadChannelPrefs(BACKUP_AUTO_PREFS_KEY, DEFAULT_AUTO_PREFS)
}

export function persistBackupPrefs(p: BackupAutoPrefs): void {
  persistChannelPrefs(BACKUP_AUTO_PREFS_KEY, p)
}

// ---------- 旧备份偏好迁移读取（plan16 T14）----------
// 旧「备份模式」localStorage 键仅作迁移读取（→ 默认本地源 retention），迁移成功后由宿主删除
export const BACKUP_MODE_KEY = 'backupMode'
export const BACKUP_KEEP_N_KEY = 'backupKeepN'
const DEFAULT_KEEP_N = 3

/** 旧 backupMode/backupKeepN → retention（与旧 loadBackupMode 同口径：overwrite 或 keep，n 非法回退 3） */
export function legacyRetention(): Retention {
  try {
    if (localStorage.getItem(BACKUP_MODE_KEY) === 'overwrite') return { type: 'overwrite' }
    const n = Number(localStorage.getItem(BACKUP_KEEP_N_KEY))
    return { type: 'keep', n: Number.isInteger(n) && n >= 1 ? n : DEFAULT_KEEP_N }
  } catch {
    return { type: 'keep', n: DEFAULT_KEEP_N }
  }
}

/** 自动备份基线（审查 I8/M3：仅全部启用源成功才写入；读写失败仅影响去重不阻塞） */
export function readLastBackupHash(): string | null {
  return localStorage.getItem(LAST_BACKUP_HASH_KEY)
}

export function writeLastBackupHash(h: string): void {
  try {
    localStorage.setItem(LAST_BACKUP_HASH_KEY, h)
  } catch { /* hash 持久化失败仅影响去重，不阻塞 */ }
}

// ---------- 云同步自动偏好（Task 11）----------
/** 云同步自动触发偏好：localStorage 键 cloudAutoPrefs（与 backup 偏好同一参数化实现，键不同） */
export const CLOUD_AUTO_PREFS_KEY = 'cloudAutoPrefs'
/** 云同步 auto 内容门持久基线（spec §1.3）：localStorage 键 cloudContentHash（runner loadContentHash/saveContentHash 消费） */
export const CLOUD_CONTENT_HASH_KEY = 'cloudContentHash'
const DEFAULT_CLOUD_AUTO_PREFS: CloudAutoPrefs = { onChange: false, onInterval: false, intervalMinutes: 60 }

export function loadCloudPrefs(): CloudAutoPrefs {
  return loadChannelPrefs(CLOUD_AUTO_PREFS_KEY, DEFAULT_CLOUD_AUTO_PREFS)
}

export function persistCloudPrefs(p: CloudAutoPrefs): void {
  persistChannelPrefs(CLOUD_AUTO_PREFS_KEY, p)
}

/** 内容门持久基线读写（spec §1.3）：null=删键；基线落盘失败仅影响去重，不阻塞 */
export function readCloudContentHash(): string | null {
  return localStorage.getItem(CLOUD_CONTENT_HASH_KEY)
}

export function writeCloudContentHash(h: string | null): void {
  try {
    if (h === null) localStorage.removeItem(CLOUD_CONTENT_HASH_KEY)
    else localStorage.setItem(CLOUD_CONTENT_HASH_KEY, h)
  } catch { /* 基线落盘失败仅影响去重，不阻塞 */ }
}

// ---------- 自动通道状态（design §4.1，Task 13 卡片渲染消费）----------
export const BACKUP_AUTO_STATUS_KEY = 'backupAutoStatus'
export const CLOUD_AUTO_STATUS_KEY = 'cloudAutoStatus'
export type AutoStatusKey = typeof BACKUP_AUTO_STATUS_KEY | typeof CLOUD_AUTO_STATUS_KEY

/** 「上次自动备份/同步」状态记录（design §4.1：{at, ok, summary}）。
 *  ok 三态（批 4）：true=成功 / false=失败 / null=跳过 */
export function recordAutoStatus(key: AutoStatusKey, ok: boolean | null, summary: string): void {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), ok, summary }))
  } catch { /* 状态记录失败不影响主流程 */ }
}

/** 状态 JSON → 卡片展示文本（design §4.1）：委托 ui formatAutoStatusText 单点（R14，原两份
 *  逐字实现合一），desktop 注入固定中文三态标签（桌面端无 i18n，与历史落盘展示一致）。
 *  纯函数导出：autoBackup.ts 以 re-export 兼容既有导入面，供三态单测（审查 Minor-2） */
const DESKTOP_AUTO_STATUS_LABELS: AutoStatusLabels = { ok: '成功', failed: '失败', skipped: '跳过', sep: '：' }

export function formatAutoStatusText(raw: string | null): string | null {
  return formatAutoStatusTextShared(raw, DESKTOP_AUTO_STATUS_LABELS)
}

/** 状态 JSON → 卡片展示文本：读 backupAutoStatus/cloudAutoStatus 键后委托 formatAutoStatusText
 *  （三态格式化纯函数，单测覆盖；审查 Minor-2 抽出） */
export function readAutoStatusText(key: AutoStatusKey): string | null {
  try {
    return formatAutoStatusText(localStorage.getItem(key))
  } catch {
    return null
  }
}
