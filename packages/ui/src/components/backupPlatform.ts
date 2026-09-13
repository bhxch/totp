import type { Vault } from '@totp/core'

/** 备份模式：keep=滚动保留最近 N 份；overwrite=覆盖单一固定文件 */
export type BackupMode = { type: 'keep'; n: number } | { type: 'overwrite' }

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
}
