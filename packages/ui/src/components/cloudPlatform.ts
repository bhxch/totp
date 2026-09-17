import {
  createGDriveBackend, createGistBackend, createOneDriveBackend, createS3Backend, createWebdavBackend,
  type BackupSource, type CloudBackend, type CloudCred, type CloudSyncOutcome, type KdfProfile,
} from '@totp/core'

/** 云端对象固定路径（内容=加密 envelope JSON，见计划 10 Global Constraints）
 *  @deprecated 仅作兼容导出，云对象路径改用 core resolveObjectPath(cred)（cred.objectPath 可自定义，缺省 DEFAULT_OBJECT_PATH）；keep 源改用 resolveTimestampPath
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
 * 存储键约定（plan16 源模型，desktop=AppData JSON 键 / extension=storage.local 键，实现一致）：
 * - 源元数据（非秘密）：`backupSources`（JSON BackupSource[]），经 core loadSources/saveSources 读写；
 * - 源凭据（秘密）：DEK 保管区 `secretBag`，经 store saveSourceCredOp/removeSourceCredOp 读写（解锁态限定）；
 * - 基线：`sourceRevs`（Record<sourceId, string>），经 core saveSourceRev 读写（hash=null 删键）；
 * - 偏好：两端统一键 cloudAutoPrefs（JSON CloudAutoPrefs）。
 * - 自动状态：两端统一键 cloudAutoStatus（JSON {at, ok: boolean|null, summary}，ok=null=跳过态），宿主格式化为文本经 loadAutoStatus 提供。
 * - 旧键 cloudCreds/cloudCred/cloudRevs/cloudRev → 源模型迁移由宿主负责（plan16 T13/T14）。
 * - 源键统一 source.id（uuid，同 kind 可多份）；云端对象路径不落键：由 core resolveObjectPath(cred) /
 *   resolveTimestampPath(cred, now) 从 cred.objectPath 解析。
 */

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
 * plan16 T8 源化：源元数据（loadSources/saveSources）明文存 settings 域；凭据经保管区 op
 * （saveCred/removeCred，语义=store.saveSourceCredOp/removeSourceCredOp，未解锁 reject 中文错误）；
 * creds 为 store.credsCache 只读视图（锁定态为空对象，列表与开关仍可渲染）。
 */
export interface CloudPlatform {
  /** 源列表（云源；本地源在 BackupCard 管理，本卡不消费 local 项） */
  loadSources(): Promise<BackupSource[]>
  /** 持久化源列表（增删/名称/保留策略/启用态编辑均整体落盘） */
  saveSources(list: BackupSource[]): Promise<void>
  /** 保存源凭据（走 store.saveSourceCredOp；未解锁 reject 中文错误） */
  saveCred(id: string, cred: CloudCred): Promise<void>
  /** 删除源凭据（幂等；源移除时同步清理） */
  removeCred(id: string): Promise<void>
  /** 凭据缓存（store.credsCache 只读视图；锁定态为空） */
  readonly creds: Record<string, CloudCred>
  /** 当前本地明文 vault 快照（saveVault 同款 JSON） */
  readVaultJson(): string
  /** 采用云端数据（恢复链路：卡内 parseVaultJson 校验+两步确认 → 宿主整体替换本地存储） */
  persistDownloaded(json: string): Promise<void>
  /** [可选] 冲突副本落盘（desktop=AppData/backups；extension=Blob 下载），返回副本名回填提示；
   *  sourceId=源 id（多源场景副本名 conflict-{sourceId}-{ts} 区分来源） */
  saveConflictBackup?(bytes: Uint8Array, sourceId?: string): Promise<string | null>
  /** 按源 id 读取该源的远端字节摘要基线（迁移约定见上）；该源无基线 → null */
  loadTargetHash(sourceId: string): Promise<string | null>
  /** 按源 id 写入基线；hash=null 语义为删除该源的基线键（不是写入 null 值） */
  saveTargetHash(sourceId: string, hash: string | null): Promise<void>
  /** 云同步自动触发偏好（desktop/extension 均提供；缺省则卡片不渲染自动区）。
   *  get 允许异步返回（extension storage.local 读写即异步，卡片 await 兼容同步/异步两种形态） */
  autoPrefs: { get(): CloudAutoPrefs | Promise<CloudAutoPrefs>; set(p: CloudAutoPrefs): void | Promise<void> }
  /** [可选] 读取「上次自动同步」状态文本（宿主自 cloudAutoStatus 键 JSON {at,ok,summary} 格式化）；缺省则卡片不显示自动状态行 */
  loadAutoStatus?(): Promise<string | null>
  /** KDF 档位（备份设置所选，信封生成用）；缺省 balanced */
  kdfProfile?: () => KdfProfile
}
