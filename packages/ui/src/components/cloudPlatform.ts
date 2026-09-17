import {
  createGDriveBackend, createGistBackend, createOneDriveBackend, createS3Backend, createWebdavBackend,
  type CloudBackend, type CloudCred, type CloudSyncOutcome,
} from '@totp/core'

/** 云端对象固定路径（内容=加密 envelope JSON，见计划 10 Global Constraints）
 *  @deprecated 仅作兼容导出，云对象路径改用 core resolveObjectPath(cred)（cred.objectPath 可自定义，缺省 DEFAULT_OBJECT_PATH）
 */
export const CLOUD_BACKUP_PATH = 'totp-backup.totpbackup'

/**
 * cred → backend 实例工厂（ui 侧 switch 五个 core create*Backend——core 无统一工厂，
 * 取 ui 侧 switch：不加 core API 面，与简报「backend 由 cred 工厂创建（switch backend id）」一致）。
 * onCredChange 仅 GDrive 消费（首推自动建文件回存 fileId），由调用方持久化新凭据。
 */
export function createCloudBackend(cred: CloudCred, onCredChange?: (cred: CloudCred) => void): CloudBackend {
  switch (cred.backend) {
    case 'webdav': return createWebdavBackend(cred)
    case 's3': return createS3Backend(cred)
    case 'gist': return createGistBackend(cred)
    case 'gdrive': return createGDriveBackend(cred, onCredChange ? { onCredChange } : {})
    case 'onedrive': return createOneDriveBackend(cred)
    default: throw new Error('未知的云后端类型')
  }
}

/**
 * 存储键约定（desktop=AppData JSON 键 / extension=storage.local 键，实现一致），
 * 两端宿主实现共同遵守（Task 11/12/13 依据）：
 * - 新键 cloudCreds：JSON 数组 CloudTarget[]；旧键 cloudCred：单对象。
 * - 读取：cloudCreds 缺失而 cloudCred 存在 → [{ cred: 旧值, enabled: true }]；两者皆缺 → []。
 * - 保存：只写 cloudCreds 并删除旧键 cloudCred。
 * - 基线：新键 cloudRevs：Record<backend, string>；旧键 cloudRev 单串。
 * - 读取：cloudRevs 缺失而 cloudRev 存在 → 该值写入 targets[0].cred.backend 键（cloudCreds 为空数组时该值丢弃）；保存只写 cloudRevs 并删除旧键 cloudRev。
 * - 偏好：两端统一键 cloudAutoPrefs（JSON CloudAutoPrefs）。
 * - 自动状态：两端统一键 cloudAutoStatus（JSON {at, ok: boolean|null, summary}，ok=null=跳过态），宿主格式化为文本经 loadAutoStatus 提供。
 * - backend 键取 cred.backend（同后端仅一份凭据）。
 * - 云端对象路径不落键：由 core resolveObjectPath(cred) 从 cred.objectPath 解析。
 */

/** 多目标云同步单个目标：凭据 + 启用态 */
export interface CloudTarget { cred: CloudCred; enabled: boolean }
/** 云同步自动触发偏好（变更触发/间隔触发及间隔分钟数） */
export interface CloudAutoPrefs { onChange: boolean; onInterval: boolean; intervalMinutes: number }

/**
 * 云同步动作 → 中文状态文案（Minor-6 中文化）：手动 CloudCard statusMap 与自动 runner
 * recordStatus summary 共用；「key: label」拼接后的自动状态行与手动状态行口径一致。
 */
export const CLOUD_ACTION_LABEL: Record<CloudSyncOutcome['action'], string> = {
  uploaded: '已上传', downloaded: '已下载', 'conflict-resolved': '冲突已解决', 'in-sync': '已是最新',
}

/**
 * 云同步平台能力（宿主注入：desktop=Tauri fs；extension=chrome.storage.local+Blob 下载）。
 * CloudCard 只依赖此接口，platform 为 null 时整卡不渲染（popup 零影响）。
 *
 * Task 13 收口：旧单目标四成员 loadCred/saveCred/loadHash/saveHash 与 getPassword 已删除
 * （卡内不再自持口令输入，改由 SyncPage 注入 sessionSecret prop），新五成员转必需。
 */
export interface CloudPlatform {
  /** 多目标凭据列表（启用态随项）。宿主实现须按迁移约定回退读取旧键 */
  loadCreds(): Promise<CloudTarget[]>
  /** 持久化凭据列表（含 GDrive onCredChange 回存 fileId 的回写） */
  saveCreds(targets: CloudTarget[]): Promise<void>
  /** 当前本地明文 vault 快照（saveVault 同款 JSON） */
  readVaultJson(): string
  /** 采用云端数据（恢复链路：卡内 parseVaultJson 校验+两步确认 → 宿主整体替换本地存储） */
  persistDownloaded(json: string): Promise<void>
  /** [可选] 冲突副本落盘（desktop=AppData/backups；extension=Blob 下载），返回副本名回填提示；
   *  backendKey=目标 backend 键（多目标场景副本名 conflict-{backendKey}-{ts} 区分来源） */
  saveConflictBackup?(bytes: Uint8Array, backendKey?: string): Promise<string | null>
  /** 按 backend 键读取该目标的远端字节摘要基线（迁移约定见上）；该 backend 无基线 → null */
  loadTargetHash(backend: string): Promise<string | null>
  /** 按 backend 键写入基线；hash=null 语义为删除该 backend 的基线键（不是写入 null 值） */
  saveTargetHash(backend: string, hash: string | null): Promise<void>
  /** 云同步自动触发偏好（desktop/extension 均提供；缺省则卡片不渲染自动区）。
   *  get 允许异步返回（extension storage.local 读写即异步，卡片 await 兼容同步/异步两种形态） */
  autoPrefs: { get(): CloudAutoPrefs | Promise<CloudAutoPrefs>; set(p: CloudAutoPrefs): void | Promise<void> }
  /** [可选] 读取「上次自动同步」状态文本（宿主自 cloudAutoStatus 键 JSON {at,ok,summary} 格式化）；缺省则卡片不显示自动状态行 */
  loadAutoStatus?(): Promise<string | null>
}
