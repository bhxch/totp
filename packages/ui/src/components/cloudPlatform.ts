import {
  createGDriveBackend, createGistBackend, createOneDriveBackend, createS3Backend, createWebdavBackend,
  type BackupSource, type CloudBackend, type CloudCred, type KdfProfile, type SourceSyncState,
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
 * 非本机 http 明文地址判定（F11）：WebDAV serverUrl / S3 endpoint 经此校验——
 * scheme 为 http 且主机非 localhost/127.0.0.1/[::1]/*.localhost 视为「凭据明文出网」，
 * CloudCard 输入时显示行内警告、保存前要求显式确认；本机回环 http（自建服务合法场景）与
 * https 不拦截。URL 解析失败返回 false：格式校验沿用既有行为（core 请求时报错），此处不二次惩罚。
 */
export function isPlaintextHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:') return false
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !host.endsWith('.localhost')
  } catch {
    return false
  }
}

/**
 * 存储键约定（plan16 源模型，desktop=AppData JSON 键 / extension=storage.local 键，实现一致）：
 * - 源元数据（非秘密）：`backupSources`（JSON BackupSource[]），经 core loadSources/saveSources 读写；
 * - 源凭据（秘密）：DEK 保管区 `secretBag`，经 store saveSourceCredOp/removeSourceCredOp 读写（解锁态限定）；
 * - rev 基线：`cloudSyncState`（spec §1.2 SourceSyncState 按 sourceId 一份，DEK seal 静态保护），
 *   经 core loadSyncState/saveSyncState 读写；
 * - 内容门：`cloudContentHash`（spec §1.3 持久化规范化内容 hash，runner auto 通道消费）；
 * - 偏好：两端统一键 cloudAutoPrefs（JSON CloudAutoPrefs）。
 * - 自动状态：两端统一键 cloudAutoStatus（JSON {at, ok: boolean|null, summary}，ok=null=跳过态），宿主格式化为文本经 loadAutoStatus 提供。
 * - 旧键 cloudCreds/cloudCred/cloudRevs/cloudRev → 源模型迁移由宿主负责（plan16 T13/T14）。
 * - 源键统一 source.id（uuid，同 kind 可多份）；云端对象路径不落键：由 core resolveObjectPath(cred) /
 *   resolveTimestampPath(cred, now) 从 cred.objectPath 解析。
 */

/** 云同步自动触发偏好（变更触发/间隔触发及间隔分钟数） */
export interface CloudAutoPrefs { onChange: boolean; onInterval: boolean; intervalMinutes: number }

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
  /** [可选] 冲突副本落盘（desktop=AppData/backups；extension=storage.local 冲突列表），返回副本名回填提示；
   *  sourceId=源 id（多源场景副本名 conflict-{sourceId}-{ts} 区分来源） */
  saveConflictBackup?(bytes: Uint8Array, sourceId?: string): Promise<string | null>
  /** 按源 id 读取该源 rev 基线（core loadSyncState；spec §1.2 SourceSyncState），无记录 → 空状态 */
  loadSourceState(sourceId: string): Promise<SourceSyncState>
  /** 按源 id 持久化 rev 基线（core saveSyncState；同步编排返回的 states 逐源回写） */
  saveSourceState(sourceId: string, state: SourceSyncState): Promise<void>
  /** 本机设备标识（core loadDeviceId 持久 UUID，写入 v3 sync 头） */
  deviceId(): Promise<string>
  /** 云同步自动触发偏好（desktop/extension 均提供；缺省则卡片不渲染自动区）。
   *  get 允许异步返回（extension storage.local 读写即异步，卡片 await 兼容同步/异步两种形态） */
  autoPrefs: { get(): CloudAutoPrefs | Promise<CloudAutoPrefs>; set(p: CloudAutoPrefs): void | Promise<void> }
  /** [可选] 读取「上次自动同步」状态文本（宿主自 cloudAutoStatus 键 JSON {at,ok,summary} 格式化）；缺省则卡片不显示自动状态行 */
  loadAutoStatus?(): Promise<string | null>
  /** [可选] 手动同步成功回调（跨端同步审查 I1）：手动同步全部目标成功（无目标级失败/收敛失败）
   *  后触发——extension 宿主借此复位云凭据失效警示并重启跟随轮询（重新授权闭环，无需重开页面）；
   *  缺省不通知（desktop 无跟随调度器，零影响） */
  onManualSynced?(): void
  /** KDF 档位（备份设置所选，信封生成用）；缺省 balanced */
  kdfProfile?: () => KdfProfile
}
