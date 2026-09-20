import type { KdfProfile, Retention, Vault } from '@totp/core'

/** 自动备份偏好（D2）：onChange=变更后自动备份；onInterval=定时自动备份；intervalMinutes=定时间隔（分钟） */
export interface BackupAutoPrefs {
  onChange: boolean
  onInterval: boolean
  intervalMinutes: number
}

/**
 * 本地源视图（plan16 §3「目录=源」：desktop 宿主实现；缺省=无本地源区，extension/popup 零影响）。
 * dir=null 即默认源（应用数据目录），宿主迁移后保证至少一条；同目录可建多条源（各自 retention/enabled 独立）。
 */
export interface LocalSourceView {
  id: string
  /** 用户可见别名（添加目录时默认取目录末段） */
  name: string
  /** 备份目录绝对路径；null=默认（应用数据目录） */
  dir: string | null
  /** 每源保留策略：overwrite=覆盖固定文件；keep=滚动保留最近 n 份 */
  retention: Retention
  enabled: boolean
}

/**
 * 备份平台能力（由宿主注入：desktop=Tauri 备份目录/系统对话框；extension=Blob 下载/input file）。
 * BackupCard 只依赖此接口，platform 为 null 时整卡不渲染（popup 零影响）。
 *
 * plan16 T9 源化：createBackup 遍历全部启用本地源按各自 retention 落盘并返回中文摘要；
 * 本地源经 listLocalSources/saveLocalSource/removeLocalSource 增删改（可选，缺省则卡内不渲染源区）。
 * 与简报差异（最小可用裁定，沿袭）：
 * - restoreFromPicker/restoreByName 增加 password 入参：口令复用卡内输入框，
 *   因为 Tauri 无原生 prompt、扩展页 input file 也拿不到口令，envelope 解密必须由卡内口令驱动。
 * - 新增可选 replaceAllOp：恢复确认覆盖后由卡调用，宿主绑定 store.replaceAllOp。
 */
export interface BackupPlatform {
  /** 向全部启用本地源备份（各按其 retention），返回中文摘要（如「已备份到 2 个目录」）；
   *  无启用源时返回提示文案由卡展示（卡内对空串兜底「未配置启用目录」） */
  createBackup(vaultJson: string, password: string): Promise<string>
  /** [可选] 本地源列表（宿主不提供则卡内不渲染源列表区） */
  listLocalSources?(): Promise<LocalSourceView[]>
  /** [可选] 保存单个本地源（新增/名称/保留策略/启用态编辑均整源落盘） */
  saveLocalSource?(s: LocalSourceView): Promise<void>
  /** [可选] 移除本地源（幂等；目录内已备份文件不受影响） */
  removeLocalSource?(id: string): Promise<void>
  /** [可选] 导出到系统选择的文件（desktop：dialog save + OS 写）；false=用户取消（未写文件），true=已导出 */
  exportToFile?(vaultJson: string, password: string): Promise<boolean>
  /** [可选] 保存任意文本导出文件（批① §2.3：otpauth 文本 .txt / Aegis JSON；desktop=save 对话框 + OS 写，
   *  extension=Blob 下载）；false=用户取消（未写文件），true=已导出 */
  saveTextFile?(name: string, content: string): Promise<boolean>
  /** [可选] 保存图片文件（批① §2.5 多选二维码拼版 PNG；desktop=save 对话框 + OS 字节写，
   *  extension=dataUrl→Blob 下载）；false=用户取消（未写文件），true=已导出 */
  saveImageFile?(name: string, dataUrl: string): Promise<boolean>
  /** [可选] 从文件选择器选取备份并解密，返回明文 vault JSON；用户取消返回 null */
  restoreFromPicker?(password: string): Promise<{ json: string } | null>
  /** [可选] 聚合全部本地源的备份文件列表（渲染用，新在前；sourceId 供恢复定位来源目录） */
  listBackups?(): Promise<Array<{ sourceId: string; name: string }>>
  /** [可选] 按源 id + 文件名读取该本地源目录内备份并解密 */
  restoreByName?(sourceId: string, name: string, password: string): Promise<{ json: string } | null>
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
  /** [可选] 读取「上次自动备份」状态文本（design §4.1：宿主自 backupAutoStatus 键 JSON {at, ok: boolean|null, summary} 格式化，ok=null=跳过态；
   *  仅 desktop 提供自动备份通道）；宿主不提供则卡内隐藏该状态行 */
  getAutoStatus?(): Promise<string | null>
  /** [可选] 弹出目录选择对话框；null=用户取消（「添加目录」建源用） */
  pickBackupDir?(): Promise<string | null>
  /** [可选] 备份加密强度档位（plan16 T11.5：本地备份/云上传 envelope 按此档位生成；宿主映射 AppSettings.backupKdfProfile 读写）。
   *  宿主不提供则卡内不渲染「备份加密强度」行；get 可能异步，载入完成前卡内不渲染（防闪烁，同 lockPrefs 模式） */
  backupKdfProfile?: {
    get(): KdfProfile | Promise<KdfProfile>
    set(p: KdfProfile): void | Promise<void>
  }
}
