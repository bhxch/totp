import type { Vault } from '@totp/core'

/** 备份模式：keep=滚动保留最近 N 份；overwrite=覆盖单一固定文件 */
export type BackupMode = { type: 'keep'; n: number } | { type: 'overwrite' }

/** 自动备份偏好（D2）：onChange=变更后自动备份；onInterval=定时自动备份；intervalMinutes=定时间隔（分钟） */
export interface BackupAutoPrefs {
  onChange: boolean
  onInterval: boolean
  intervalMinutes: number
}

/**
 * 备份平台能力（由宿主注入：desktop=Tauri 备份目录/系统对话框；extension=Blob 下载/input file）。
 * BackupCard 只依赖此接口，platform 为 null 时整卡不渲染（popup 零影响）。
 *
 * 与简报差异（最小可用裁定）：
 * - restoreFromPicker/restoreByName 增加 password 入参：口令复用卡内输入框，
 *   因为 Tauri 无原生 prompt、扩展页 input file 也拿不到口令，envelope 解密必须由卡内口令驱动。
 * - 新增可选 replaceAllOp：恢复确认覆盖后由卡调用，宿主绑定 store.replaceAllOp。
 */
export interface BackupPlatform {
  /** 立即备份（备份内容=调用方组装的 vaultJson 快照），返回实际落盘方式 */
  createBackup(vaultJson: string, password: string): Promise<'created' | 'overwritten'>
  /** 当前备份模式（宿主用 reactive/ref 保证变更可追踪） */
  mode: BackupMode
  /** 切换模式（宿主负责持久化偏好） */
  setMode(m: BackupMode): Promise<void>
  /** [可选] 导出到系统选择的文件（desktop：dialog save + OS 写）；false=用户取消（未写文件），true=已导出 */
  exportToFile?(vaultJson: string, password: string): Promise<boolean>
  /** [可选] 从文件选择器选取备份并解密，返回明文 vault JSON；用户取消返回 null */
  restoreFromPicker?(password: string): Promise<{ json: string } | null>
  /** [可选] 桌面备份文件列表（渲染用，新在前） */
  listBackups?(): Promise<Array<{ name: string }>>
  /** [可选] 按名字读取桌面备份目录内文件并解密 */
  restoreByName?(name: string, password: string): Promise<{ json: string } | null>
  /** [可选] 恢复确认覆盖后整体替换当前 vault（宿主绑定 store.replaceAllOp） */
  replaceAllOp?(v: Vault): Promise<void>
  /** [可选] 选择并读取导入文件（desktop：dialog open + OS 白名单读取；extension：动态 input file）；用户取消返回 null（ImportCard 用） */
  readImportFile?(): Promise<{ text: string; name: string } | null>
  /** [可选] SQLite 字节入口：读最近一次导入文件原始字节（不经文本管道），无最近选择时补弹选择器；用户取消返回 null（ImportCard 用） */
  readImportFileBytes?(): Promise<{ bytes: Uint8Array; name: string } | null>
  /** [可选] WinAuth DPAPI 层解密（base64 密文 → UTF-8 明文），仅桌面端提供（ImportCard 用） */
  decryptDpapi?(b64: string): Promise<string>
  /** [可选] 读取自动备份偏好（D2；宿主不提供则卡内隐藏自动区）。可能同步返回 */
  getAutoPrefs?(): BackupAutoPrefs
  /** [可选] 回写自动备份偏好（宿主负责持久化；卡内每次传完整对象） */
  setAutoPrefs?(p: BackupAutoPrefs): void | Promise<void>
  /** [可选] 读取「上次自动备份」状态文本（design §4.1：宿主自 backupAutoStatus 键 JSON {at,ok,summary} 格式化；
   *  仅 desktop 提供自动备份通道）；宿主不提供则卡内隐藏该状态行 */
  getAutoStatus?(): Promise<string | null>
  /** [可选] 当前备份目录；null=默认（应用数据目录）。宿主不提供则卡内隐藏目录行 */
  getBackupDir?(): Promise<string | null>
  /** [可选] 设置备份目录；null=恢复默认 */
  setBackupDir?(dir: string | null): Promise<void>
  /** [可选] 弹出目录选择对话框；null=用户取消 */
  pickBackupDir?(): Promise<string | null>
}
