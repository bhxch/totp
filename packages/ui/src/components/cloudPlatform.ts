import {
  createGDriveBackend, createGistBackend, createOneDriveBackend, createS3Backend, createWebdavBackend,
  type CloudBackend, type CloudCred,
} from '@totp/core'

/** 云端对象固定路径（内容=加密 envelope JSON，见计划 10 Global Constraints） */
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
 * 云同步平台能力（宿主注入：desktop=Tauri fs；extension=chrome.storage.local+Blob 下载）。
 * CloudCard 只依赖此接口，platform 为 null 时整卡不渲染（popup 零影响）。
 *
 * 与简报差异（最小裁定）：
 * - pickBackendCred 不设方法：裁定为表单内联（后端下拉+动态字段+保存到 cloudCred），卡内自持表单。
 * - getPassword 保持可选且卡内不消费：裁定 CloudCard 自带口令输入，与 BackupCard 独立。
 * - 新增可选 loadHash/saveHash：cloudRev（上次已知云端内容 hash）按计划持久化于 local 键；
 *   缺省时退化为会话内基线（重启后首次同步按 downloaded 语义处理）。
 */
export interface CloudPlatform {
  /** 读取已存凭据（local 键 cloudCred）；未存/读取失败 → null */
  loadCred(): Promise<CloudCred | null>
  /** 持久化凭据（含 GDrive onCredChange 回存 fileId 的回写） */
  saveCred(c: CloudCred): Promise<void>
  /** 当前本地明文 vault 快照（saveVault 同款 JSON） */
  readVaultJson(): string
  /** 采用云端数据（恢复链路：卡内 parseVaultJson 校验+两步确认 → 宿主整体替换本地存储） */
  persistDownloaded(json: string): Promise<void>
  /** [可选] 冲突副本落盘（desktop=AppData/backups；extension=Blob 下载），返回副本名回填提示 */
  saveConflictBackup?(bytes: Uint8Array): Promise<string | null>
  /** [可选] 读取 cloudRev（上次已知云端内容 hash）；从未记录 → null */
  loadHash?(): Promise<string | null>
  /** [可选] 持久化 cloudRev（uploaded/成功采用云端后调用） */
  saveHash?(hash: string): Promise<void>
  /** [可选] 会话口令缓存（简报原接口；裁定 CloudCard 自带口令输入，故不消费） */
  getPassword?(): string | null
}
