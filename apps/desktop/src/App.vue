<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { backupFileName, base64ToBytes, bytesToBase64, createBackupEnvelope, loadDeviceId, loadSources, loadSyncState, normalizeSchemes, openBackupEnvelope, randomBytes, saveSources, saveSyncState, SCHEMES_KEY, sha256Hex, type BackupSource, type CloudCred, type ImportScheme, type KdfProfile, type Retention, type Seal, type StorageAdapter, type Vault } from '@totp/core'
import { createAppI18n, createClipboardClearer, createCloudBackend, createCloudSyncRunner, createIconStore, createPrfCredential, createVueStore, LockScreen, NavigationShell, prfSupported, requestMergeConfirm, setSyncProgress, useTheme, type BackupAutoPrefs, type BackupPlatform, type CloudAutoPrefs, type CloudPlatform, type DevtoolsConfigDto, type DevtoolsPlatform, type DpapiUnlockOps, type IconStore, type ImportSchemesApi, type LocalSourceView, type McpConfigWithStatusDto, type McpPlatform, type ReleasePolicyDto, type ReleasePlatform, type SecurityPlatform, type VueStore } from '@totp/ui'
import { computed, getCurrentInstance, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { createDesktopAutoRunner, formatAutoStatusText } from './autoBackup'
import { createBackupToSources, listBackupsFromSources, pickBackupDirOs, pickBackupOpenOs, pickBackupSaveOs, readBackupByName, readBackupFileOs, saveConflictBackupToDir, saveCloudSourcesPreservingLocal, writeBackupFileOs, writeBytesFileOs, writeTextFileOs, type DialogFilterSpec, type PickedOsFile } from './backupService'
import { decryptDpapiOs, pickImportFileOs, readImportFileBytesOs, readImportFileOs } from './importService'
import { createIdleLockExecutor } from './idleLock'
import { lockPrefsUnsupportedKeys } from './lockPrefs'
import { BACKUP_DIR_KEY, migrateLegacyCloudSources, migrateLegacyLocalSource } from './legacyMigrate'
import { createMcpApprovalQueue, isToolConfirmItem, type McpApprovalAction } from './mcpApprovalQueue'
import { createMcpTriggers, startMcpBridge, type McpBridgeDeps } from './mcpBridge'
import McpConsentDialog from './McpConsentDialog.vue'
import { createTauriFs } from './tauriFs'
import { isEntropyBoundDekWrap, osAutoForgetOs, osAutoProtectOs, osAutoUnprotectOs } from './tauriSecurity'

// store 必须浅包装（T14 审查根修）：深 ref 会对值做 reactive 深代理，代理 get 对嵌套
// ref/computed 成员自动解包——闭包 `store.value.locked.value` / 组件 prop `props.store.X.value`
// 在深 ref 下全部得 undefined/TypeError（探针 storeWrap.test 实证），曾致自动备份/云同步恒跳过、
// creds/kdfProfile/锁定判定全族失效。shallowRef 下 .value 即原始对象，成员保持真 ref 语义；
// vault/settings 自身是 reactive，响应式不受影响。模板顶层解包只解一层，locked 经下方 computed 暴露
const store = shallowRef<VueStore | null>(null)
/** 模板锁定态（shallowRef 嵌套成员不再被模板隐式解包，显式顶层暴露） */
const locked = computed(() => store.value?.locked.value ?? false)
const icons = ref<IconStore | null>(null)
const loadError = ref('')
let unlistenFocus: (() => void) | null = null
// 释放策略联动监听（Task 14）：force-lock=暂停/销毁锁库；stash-dek-request=销毁不锁库路径先上报 DEK
let unlistenForceLock: (() => void) | null = null
let unlistenStashDek: (() => void) | null = null
// D1 i18n 挂载（store 就绪后装入，见 onMounted 内 mountI18n）：app 引用必须在 setup 同步段获取
// （onMounted await 之后 instance 上下文已失效）；本组件 store 仅在挂载时创建一次
const appForI18n = getCurrentInstance()?.appContext.app
let i18nInstalled = false
// D2 抽串：壳层 t() 走捕获的 i18n 实例（本组件 script setup 内 useI18n 注入不可用，沿 options 页口径）。
// 未装入（初始化失败等）时兜底回原文 key
const i18nRef = shallowRef<ReturnType<typeof createAppI18n> | null>(null)
function tr(key: string, params: Record<string, unknown> = {}): string {
  return i18nRef.value ? i18nRef.value.global.t(key, params) : key
}
function mountI18n(s: VueStore): void {
  if (appForI18n && !i18nInstalled) {
    const i18nInst = createAppI18n(s)
    appForI18n.use(i18nInst)
    i18nRef.value = i18nInst
    i18nInstalled = true
  }
}

/** platform 工厂与迁移共用的就绪断言：store/adapter 未就绪时统一中文报错（卡片展示） */
function requireStore(): VueStore {
  const s = store.value
  if (!s) throw new Error('数据尚未就绪')
  return s
}

// ---------- 导入映射方案存取 ----------
// adapter 在 onMounted 就绪后赋值；schemesApi 闭包实时读取（旧单页 仅在 store 就绪后渲染，不会读到 null）
let fsAdapter: StorageAdapter | null = null

function requireAdapter(): StorageAdapter {
  if (!fsAdapter) throw new Error('数据尚未就绪')
  return fsAdapter
}

/** 直读写 adapter 的 SCHEMES_KEY（本地 AppData JSON）；load 容错：坏 JSON → 空表 */
const schemesApi: ImportSchemesApi = {
  async load(): Promise<ImportScheme[]> {
    if (!fsAdapter) return []
    try {
      const raw = await fsAdapter.get(SCHEMES_KEY)
      return raw ? normalizeSchemes(JSON.parse(raw)) : []
    } catch {
      return []
    }
  },
  async save(list: ImportScheme[]): Promise<void> {
    if (!fsAdapter) throw new Error('数据尚未就绪')
    await fsAdapter.set(SCHEMES_KEY, JSON.stringify(list))
  },
}

// ---------- 备份源存取（plan16 T14 源化）----------
// 源元数据明文存 AppData backupSources 键（core loadSources/saveSources）；云源凭据存 DEK 保管区
// （store.saveSourceCredOp/removeSourceCredOp），基线按源 id 存 sourceRevs。

/** 全部源列表（云源+本地源；各消费方按 kind 过滤） */
function loadAllSources(): Promise<BackupSource[]> {
  return loadSources(requireAdapter())
}

/** core 本地源 → ui LocalSourceView（BackupCard 源列表区渲染/编辑用） */
function toLocalViews(list: BackupSource[]): LocalSourceView[] {
  return list
    .filter((s) => s.kind === 'local')
    .map(({ id, name, dir, retention, enabled }) => ({ id, name, dir: dir ?? null, retention, enabled }))
}

/** 备份加密强度档位（plan16 T11.5）：本地备份/云上传 envelope 按此档位生成；store 未就绪兜底 balanced */
function kdfProfileOf(): KdfProfile {
  return store.value?.settings.backupKdfProfile ?? 'balanced'
}

// ---------- 自动备份偏好（D2）----------
// 本地偏好存桌面 localStorage（ui BackupCard 读写经 platform 同一对函数）；源与目录已源化（backupSources 键）
const BACKUP_AUTO_PREFS_KEY = 'backupAutoPrefs'
const LAST_BACKUP_HASH_KEY = 'lastBackupHash'
const DEFAULT_AUTO_PREFS: BackupAutoPrefs = { onChange: false, onInterval: false, intervalMinutes: 60 }

/** Task 7（BackupCard）与 Task 10（自动备份 runner deps）共用的唯一读写实现，避免两处漂移 */
function loadBackupPrefs(): BackupAutoPrefs {
  try {
    const raw = localStorage.getItem(BACKUP_AUTO_PREFS_KEY)
    if (!raw) return { ...DEFAULT_AUTO_PREFS }
    const p = JSON.parse(raw) as Partial<BackupAutoPrefs>
    const minutes = Number(p.intervalMinutes)
    return {
      onChange: p.onChange === true,
      onInterval: p.onInterval === true,
      // 兜底最小 15 分钟：与 core 调度器 30s tick 粒度匹配，防误配置出低于 tick 语义的间隔
      intervalMinutes: Number.isInteger(minutes) && minutes >= 15 ? minutes : DEFAULT_AUTO_PREFS.intervalMinutes,
    }
  } catch {
    return { ...DEFAULT_AUTO_PREFS }
  }
}

function persistBackupPrefs(p: BackupAutoPrefs): void {
  try {
    localStorage.setItem(BACKUP_AUTO_PREFS_KEY, JSON.stringify(p))
  } catch { /* 偏好持久化失败不影响功能 */ }
}

// ---------- 旧备份偏好迁移读取（plan16 T14）----------
// 旧「备份模式」localStorage 键仅作迁移读取（→ 默认本地源 retention），迁移成功后由宿主删除
const BACKUP_MODE_KEY = 'backupMode'
const BACKUP_KEEP_N_KEY = 'backupKeepN'
const DEFAULT_KEEP_N = 3

/** 旧 backupMode/backupKeepN → retention（与旧 loadBackupMode 同口径：overwrite 或 keep，n 非法回退 3） */
function legacyRetention(): Retention {
  try {
    if (localStorage.getItem(BACKUP_MODE_KEY) === 'overwrite') return { type: 'overwrite' }
    const n = Number(localStorage.getItem(BACKUP_KEEP_N_KEY))
    return { type: 'keep', n: Number.isInteger(n) && n >= 1 ? n : DEFAULT_KEEP_N }
  } catch {
    return { type: 'keep', n: DEFAULT_KEEP_N }
  }
}

/** store 整体替换的唯一实现：backupPlatform.replaceAllOp / cloudPlatform.persistDownloaded / 云 runner persistAdopted 共用 */
async function replaceAllOps(v: Vault): Promise<void> {
  await requireStore().replaceAllOp(v)
}

// 最后一次导入选择的 Rust 对话框结果（F4：path+token 成对缓存）：SQLite 字节入口复用，避免同一文件二次弹窗
let lastImportPick: PickedOsFile | null = null

/** envelope 文本 → 解密出明文 vault JSON（口令错误/文件损坏由 openBackupEnvelope 抛错，卡片统一展示） */
async function openBackupText(text: string, password: string): Promise<string> {
  return openBackupEnvelope(JSON.parse(text), password)
}

// 文件对话框过滤器名（D2 抽串）：i18n 随 store 就绪装入，而平台方法均在其后调用——改为工厂函数调用时取词
const backupFileFilters = (): DialogFilterSpec[] => [{ name: tr('desktop.filterBackup'), extensions: ['totpbackup'] }]
// 文本导出（批① §2.3）对话框过滤器：otpauth 文本落 .txt、Aegis 导出落 .json
const textFileFilters = (): DialogFilterSpec[] => [{ name: tr('desktop.filterExport'), extensions: ['json', 'txt'] }]
// 图片导出（批① §2.5 二维码拼版）对话框过滤器：拼版 PNG 落 .png
const imageFileFilters = (): DialogFilterSpec[] => [{ name: tr('desktop.filterImage'), extensions: ['png'] }]
// 与 Rust 端 read_import_file_os 扩展名白名单一致（.json/.wauth/.xml/.txt/.aegis）+ SQLite .db/.sqlitedb/.sqlite
// （.db 经文本读取报 UTF-8 错时由 ImportCard 转字节入口复查，见 read_import_file_bytes_os）+ AP .zip（手动选择字节通道）
const importFileFilters = (): DialogFilterSpec[] => [
  { name: tr('desktop.filterImport'), extensions: ['json', 'wauth', 'txt', 'aegis', 'xml', 'db', 'sqlitedb', 'sqlite', 'zip'] },
]

/**
 * 备份平台实现（plan16 T9 源化形状）：createBackup=全部启用本地源按各自 retention 落盘并返回中文摘要；
 * 本地源经 listLocalSources/saveLocalSource/removeLocalSource 增删改（AppData backupSources 键）；
 * 备份/恢复按 (sourceId, name) 定位来源目录；旧 backupMode/getBackupDir/setBackupDir 随源模型删除
 * （retention 进每源，目录=每源 dir，迁移见 runLegacyMigrations）。
 */
const backupPlatform: BackupPlatform = {
  createBackup: async (vaultJson, password) => {
    // 审查 I8：按结构化结果如实提示；仅全部启用源成功才记录 lastBackupHash——
    // 部分失败推进基线会让自动通道按 unchanged 跳过后续重试（静默停摆），与自动通道同口径
    const r = await createBackupToSources(await loadAllSources(), vaultJson, password, kdfProfileOf())
    if (r.outcome === 'ok') {
      try {
        localStorage.setItem(LAST_BACKUP_HASH_KEY, await sha256Hex(new TextEncoder().encode(vaultJson)))
      } catch { /* hash 记录失败不影响备份本身 */ }
    }
    return r.summary
  },
  listLocalSources: async () => toLocalViews(await loadAllSources()),
  async saveLocalSource(v) {
    const adapter = requireAdapter()
    const source: BackupSource = { ...v, kind: 'local', role: 'replica' }
    const list = await loadSources(adapter)
    const idx = list.findIndex((s) => s.id === v.id)
    if (idx >= 0) list[idx] = source
    else list.push(source)
    await saveSources(adapter, list)
  },
  async removeLocalSource(id) {
    const adapter = requireAdapter()
    await saveSources(adapter, (await loadSources(adapter)).filter((s) => s.id !== id))
  },
  async exportToFile(vaultJson, password) {
    // F4：save 对话框改由 Rust 打开并登记保存位置父目录（取消则直接 false），
    // 再做 Argon2id 加密写文件，省一次白跑的 KDF（档位随备份设置）
    const picked = await pickBackupSaveOs(backupFileName(new Date()), backupFileFilters())
    if (!picked) return false
    const envelope = await createBackupEnvelope(vaultJson, password, kdfProfileOf())
    await writeBackupFileOs(picked, envelope)
    return true
  },
  // 文本导出（批① §2.3）：save 对话框（Rust 登记授权）+ OS 白名单写；取消=不写盘返回 false
  async saveTextFile(name, content) {
    const picked = await pickBackupSaveOs(name, textFileFilters())
    if (!picked) return false
    await writeTextFileOs(picked, content)
    return true
  },
  // 图片导出（批① §2.5 多选二维码拼版 PNG）：save 对话框（Rust 登记授权）+ OS 白名单字节写
  // （dataUrl 解 base64 为原始字节，不经文本管道）；取消=不写盘返回 false
  async saveImageFile(name, dataUrl) {
    const picked = await pickBackupSaveOs(name, imageFileFilters())
    if (!picked) return false
    await writeBytesFileOs(picked, base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1)))
    return true
  },
  async restoreFromPicker(password) {
    // F4：open 对话框由 Rust 打开（path+dirToken 成对返回），遏制基准=后端登记父目录
    const picked = await pickBackupOpenOs(backupFileFilters())
    if (!picked) return null
    return { json: await openBackupText(await readBackupFileOs(picked), password) }
  },
  listBackups: async () => listBackupsFromSources(await loadAllSources()),
  async restoreByName(sourceId, name, password) {
    return { json: await openBackupText(await readBackupByName(sourceId, name, await loadAllSources()), password) }
  },
  getAutoPrefs: () => loadBackupPrefs(),
  setAutoPrefs: (p) => persistBackupPrefs(p),
  getAutoStatus: async () => readAutoStatusText(BACKUP_AUTO_STATUS_KEY),
  pickBackupDir: async () => {
    // F4：目录选择经 Rust pick_dir_os（canonical 登记 + 跨会话持久化），前端仍只持久化 path
    return pickBackupDirOs()
  },
  replaceAllOp: async (v) => replaceAllOps(v),
  // 备份加密强度档位（plan16 T11.5）：settings 持久化（backupKdfProfile 字段 + commitSettings）
  backupKdfProfile: {
    get: () => kdfProfileOf(),
    set: (p) => {
      const s = requireStore()
      s.settings.backupKdfProfile = p
      void s.commitSettings()
    },
  },
  async readImportFile() {
    // F4：open 对话框由 Rust 打开（登记父目录返回 token），文本/字节入口共用同一登记结果
    const picked = await pickImportFileOs(importFileFilters())
    if (!picked) return null
    lastImportPick = picked
    return { text: await readImportFileOs(picked), name: picked.path.split(/[\\/]/).pop() ?? picked.path }
  },
  // SQLite 字节入口：复用最近一次选择的登记结果（避免二次弹窗）；无最近选择时补弹对话框
  async readImportFileBytes() {
    const picked = lastImportPick ?? (await pickImportFileOs(importFileFilters()))
    if (!picked) return null
    return { bytes: await readImportFileBytesOs(picked), name: picked.path.split(/[\\/]/).pop() ?? picked.path }
  },
  decryptDpapi: (b64) => decryptDpapiOs(b64),
}

/** 自动备份 runner（D2）：backup/cloud 双通道。deps 闭包实时读 store/platform/localStorage，
 *  store 未就绪时 isLocked 兜底 true → decideAutoRun skip，保证锁定态/未初始化永不自动写 */
const auto = createDesktopAutoRunner({
  isLocked: () => store.value?.locked.value ?? true,
  getSecret: () => store.value?.backupSecret.value ?? null,
  getVaultJson: () => JSON.stringify(store.value?.vault ?? null),
  backupPrefs: () => loadBackupPrefs(),
  // 云通道偏好（Task 11 接入）：与 CloudCard autoPrefs 同一读写实现（cloudAutoPrefs 键）
  cloudPrefs: () => loadCloudPrefs(),
  getLastBackupHash: () => localStorage.getItem(LAST_BACKUP_HASH_KEY),
  setLastBackupHash: (h) => {
    try {
      localStorage.setItem(LAST_BACKUP_HASH_KEY, h)
    } catch { /* hash 持久化失败仅影响去重，不阻塞 */ }
  },
  doBackup: async (secret) => {
    // plan16 T14：全部启用本地源各按 retention 落盘；审查 I8：返回结构化成败结果（部分失败
    // 不推进基线）；审查 M3：vault 快照在此单次取得并随结果返回，runner 以落盘内容计基线 hash
    return createBackupToSources(await loadAllSources(), JSON.stringify(store.value?.vault ?? null), secret, kdfProfileOf())
  },
  // Task 11：desktop 云多目标编排接入（cloudSync 在下方定义；busy 防重入内建于 runner）
  doCloudSync: () => cloudSync.run(),
  // core sha256Hex 接收字节：vault JSON → UTF-8 编码后摘要
  sha256Hex: (s) => sha256Hex(new TextEncoder().encode(s)),
  // 「上次自动备份/同步」状态记录（design §4.1；Task 13 卡片渲染消费）
  recordStatus: (ok, summary) => recordAutoStatus(BACKUP_AUTO_STATUS_KEY, ok, summary),
  onError: (err, channel) => console.warn(`[autoBackup:${channel}]`, err),
})

/**
 * 云同步平台实现（plan16 T14 源化口径，键约定见 ui cloudPlatform.ts 注释块）：
 * - 源元数据（云源+本地源）明文存 AppData backupSources 键（core loadSources/saveSources）；
 * - 源凭据是秘密，存 DEK 保管区（store.saveSourceCredOp/removeSourceCredOp，解锁态限定，未解锁中文报错）；
 * - 基线按源 id 存 sourceRevs（core loadSourceRevs/saveSourceRev，hash=null 删键）；
 * - 旧 cloudCreds/cloudCred/cloudRevs/cloudRev 四键由 migrateLegacyCloudSources 一次性迁移（runLegacyMigrations）。
 * - 冲突副本写 backups/conflict-{sourceId}-{ts}.totpbackup；采用云端数据经 store.replaceAllOp 整体替换。
 * - 自审（竞态，低概率接受）：自动同步在途期间用户于 CloudCard 改源/凭据，读-改-写可能互相覆盖
 *   （backupSources/sourceRevs 均为整键覆写）；runner busy 只防自动与自动重叠，与手动同步的并发
 *   为已知边界，不引入跨实例锁。
 */

/** 云同步自动触发偏好：localStorage 键 cloudAutoPrefs，与 loadBackupPrefs 同风格、独立实现（键不同） */
const CLOUD_AUTO_PREFS_KEY = 'cloudAutoPrefs'
/** 云同步 auto 内容门持久基线（spec §1.3）：localStorage 键 cloudContentHash（runner loadContentHash/saveContentHash 消费） */
const CLOUD_CONTENT_HASH_KEY = 'cloudContentHash'
const DEFAULT_CLOUD_AUTO_PREFS: CloudAutoPrefs = { onChange: false, onInterval: false, intervalMinutes: 60 }

function loadCloudPrefs(): CloudAutoPrefs {
  try {
    const raw = localStorage.getItem(CLOUD_AUTO_PREFS_KEY)
    if (!raw) return { ...DEFAULT_CLOUD_AUTO_PREFS }
    const p = JSON.parse(raw) as Partial<CloudAutoPrefs>
    const minutes = Number(p.intervalMinutes)
    return {
      onChange: p.onChange === true,
      onInterval: p.onInterval === true,
      // 与 backup 偏好同口径兜底最小 15 分钟：匹配 core 调度器 30s tick 粒度
      intervalMinutes: Number.isInteger(minutes) && minutes >= 15 ? minutes : DEFAULT_CLOUD_AUTO_PREFS.intervalMinutes,
    }
  } catch {
    return { ...DEFAULT_CLOUD_AUTO_PREFS }
  }
}

function persistCloudPrefs(p: CloudAutoPrefs): void {
  try {
    localStorage.setItem(CLOUD_AUTO_PREFS_KEY, JSON.stringify(p))
  } catch { /* 偏好持久化失败不影响功能 */ }
}

/** 「上次自动备份/同步」状态记录（design §4.1：{at, ok, summary}；Task 13 卡片渲染消费）。
 *  ok 三态（批 4）：true=成功 / false=失败 / null=跳过 */
const BACKUP_AUTO_STATUS_KEY = 'backupAutoStatus'
const CLOUD_AUTO_STATUS_KEY = 'cloudAutoStatus'

function recordAutoStatus(key: 'backupAutoStatus' | 'cloudAutoStatus', ok: boolean | null, summary: string): void {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), ok, summary }))
  } catch { /* 状态记录失败不影响主流程 */ }
}

/** 状态 JSON → 卡片展示文本：读 backupAutoStatus/cloudAutoStatus 键后委托 autoBackup.formatAutoStatusText
 *  （三态格式化纯函数，单测覆盖；审查 Minor-2 抽出） */
function readAutoStatusText(key: 'backupAutoStatus' | 'cloudAutoStatus'): string | null {
  try {
    return formatAutoStatusText(localStorage.getItem(key))
  } catch {
    return null
  }
}

const cloudPlatform: CloudPlatform = {
  // ---- 源模型成员（plan16 T14；本卡仅消费云源，local 项归 BackupCard）----
  loadSources: async () => (await loadAllSources()).filter((s) => s.kind !== 'local'),
  // 审查 I11：合并写入——保留并发改动中的本地源（BackupCard 通道），仅覆盖本卡提交的云源列表
  saveSources: (list) => saveCloudSourcesPreservingLocal(requireAdapter(), list),
  saveCred: (id, cred) => requireStore().saveSourceCredOp(id, cred),
  removeCred: (id) => requireStore().removeSourceCredOp(id),
  // getter 形态：CloudCard 渲染/回调按 id 动态读取（p.creds[id]），锁定清空/解锁装载/保存后即时可见
  get creds() { return requireStore().credsCache.value },
  readVaultJson() {
    const s = store.value
    if (!s) throw new Error('数据尚未就绪')
    return JSON.stringify(s.vault)
  },
  persistDownloaded: (json) => replaceAllOps(JSON.parse(json) as Vault),
  saveConflictBackup: async (bytes, sourceId) => saveConflictBackupToDir(bytes, null, sourceId),
  // rev 基线（spec §1.2）+ DEK seal 静态保护：与 runner 通道共用同一 revSeal（共享 cloudSyncState
  // 键——手动/自动两侧读写形态必须一致，缺 seal 侧会把密文当明文 bag 互踩并泄漏 baseSnapshot）
  loadSourceState: (id) => loadSyncState(requireAdapter(), id, revSeal(requireStore())),
  saveSourceState: (id, st) => saveSyncState(requireAdapter(), id, st, revSeal(requireStore())),
  deviceId: () => loadDeviceId(requireAdapter()),
  // KDF 档位（备份设置所选）：云上传/冲突副本 envelope 生成口径与本地备份一致
  kdfProfile: () => kdfProfileOf(),
  autoPrefs: {
    get: () => loadCloudPrefs(),
    set: (p) => persistCloudPrefs(p),
  },
  loadAutoStatus: async () => readAutoStatusText(CLOUD_AUTO_STATUS_KEY),
}

/** keep 源远端滚动删除的待并入提示（runner 顺序保证：先逐源 onRetentionDeleted 后 recordStatus，
 *  状态写盘前拼入 summary 并清空，不跨轮残留） */
let retentionNotes: string[] = []

/** rev 基线 seal（spec §1.2 静态保护，T9 装配约定 5）：解锁态经 store 的 DEK seal 助手加密。
 *  两态语义（审查 Important 1 修正）：未启用加密（security 为空）→ sealWithDek 返回 null → 明文回落
 *  （明文库语义）；加密启用但窗口锁定（DEK 已清）→ sealWithDek 抛 'vault locked' → 不吞错，
 *  落盘整体失败（下轮按旧基线重做），绝不把 baseSnapshot/冲突记录明文回落落盘。
 *  unseal 不可解（换 DEK/明文记录）回落原文——core 解析层自然判废（明文可解析=兼容读取，
 *  密文垃圾解析失败=回落空态重建） */
function revSeal(s: VueStore): Seal {
  return {
    seal: async (plain) => (await s.sealWithDek(plain)) ?? plain,
    unseal: async (sealed) => (await s.unsealWithDek(sealed)) ?? sealed,
  }
}

/** 源 id→名称进程内缓存（审查 I4：runner sourceName 同步解析显示名用）；runner 每轮 loadSources
 *  装配时刷新（summary/onRetentionDeleted 均在其后，缓存必已就绪）；取不到回退 id */
const cloudSourceNames = new Map<string, string>()

/** 自动云同步 runner（D6，ui 共享实现，desktop/extension 同一编排；plan16 T14 源口径）：
 *  loadSources 装配「启用云源 × 保管区凭据」对（无凭据的源跳过——锁定态 credsCache 为空自然全跳过）；
 *  冲突副本已由 onConflictBackup 落盘，故 adopt 分支自动执行、不弹确认——裁定来源=设计 §4
 *  「自动执行结果不打扰」（区别于 CloudCard 手动同步的两步确认）；GDrive 首推凭据回存由
 *  CloudCard 手动通道持有（runner deps 新口径不含 onCredChange） */
const cloudSync = createCloudSyncRunner({
  isLocked: () => store.value?.locked.value ?? true,
  getSecret: () => store.value?.backupSecret.value ?? null,
  getVaultJson: () => JSON.stringify(store.value?.vault ?? null),
  loadSources: async () => {
    const s = requireStore()
    const all = await loadAllSources()
    for (const x of all) cloudSourceNames.set(x.id, x.name)
    return all
      .filter((x) => x.kind !== 'local') // 云通道只装配云源（本地源归 BackupCard 通道）
      .map((x) => ({ source: x, cred: s.credsCache.value[x.id] }))
      .filter((p): p is { source: BackupSource; cred: CloudCred } => p.cred !== undefined)
  },
  // rev 基线（spec §1.2）+ DEK seal 静态保护（T9 装配约定 5：baseSnapshot 明文落盘问题的修复）
  loadSyncState: (id) => loadSyncState(requireAdapter(), id, revSeal(requireStore())),
  saveSyncState: (id, st) => saveSyncState(requireAdapter(), id, st, revSeal(requireStore())),
  // 内容门持久基线（spec §1.3）：localStorage 键 cloudContentHash（跨会话/页面重开生效）
  loadContentHash: async () => localStorage.getItem(CLOUD_CONTENT_HASH_KEY),
  saveContentHash: async (h) => {
    try {
      if (h === null) localStorage.removeItem(CLOUD_CONTENT_HASH_KEY)
      else localStorage.setItem(CLOUD_CONTENT_HASH_KEY, h)
    } catch { /* 基线落盘失败仅影响去重，不阻塞 */ }
  },
  deviceId: () => loadDeviceId(requireAdapter()),
  makeBackend: (cred) => createCloudBackend(cred),
  persistAdopted: (json) => replaceAllOps(JSON.parse(json) as Vault),
  // 审查 I9：Promise 原样交回 runner/core（syncWithCloudRev await 冲突回调）——写盘失败让该目标
  // 同步失败（recordStatus 记失败），不再静默吞掉后照常采纳远端并回推覆盖云端旧版本
  saveConflictBackup: (key, bytes) => saveConflictBackupToDir(bytes, null, key),
  kdfProfile: () => kdfProfileOf(),
  sourceName: (id) => cloudSourceNames.get(id) ?? id,
  // D2 抽串：runner 状态摘要经注入 t() 记录时取词（tr 内部读 locale ref；runner 回调均在 i18n 装入后触发）
  t: (key, params) => tr(key, params),
  onRetentionDeleted: (name, deleted) => {
    // D2 抽串：记录时取词（摘要持久化于 cloudAutoStatus，展示端按落盘内容显示）
    retentionNotes.push(deleted >= 0 ? tr('desktop.retentionCleaned', { name, count: deleted }) : tr('desktop.retentionUnsupported', { name }))
  },
  recordStatus: (ok, summary) => {
    const notes = retentionNotes.join(tr('desktop.noteSep'))
    retentionNotes = []
    recordAutoStatus(CLOUD_AUTO_STATUS_KEY, ok, notes ? `${summary}${tr('desktop.noteSep')}${notes}` : summary)
  },
  // 条目冲突入库桥（spec §3/§4）：fire-and-forget，入库失败不影响同步结果（下轮合并重报）
  onMergeConflicts: (conflicts) => {
    void requireStore().addMergeConflictsOp(conflicts).catch((err) => console.warn('[cloudAutoSync] 冲突记录入库失败', err))
  },
  // 未裁决冲突计数（宿主闭包读 store.conflictCount）
  conflictCount: () => store.value?.conflictCount.value ?? 0,
  // 冲突强提示（spec §4 应用内横幅）：desktop=SyncPage 健康条 SyncHealthBar 徽标高亮（store
  // conflictCount 同源），此处留 console 留痕；托盘 tooltip 计数不做，记 backlog
  onConflicts: (count) => {
    console.info('[cloudAutoSync] 未裁决同步冲突:', count)
  },
  // 手动合并预览确认（spec §4，T11）：经 cloudSyncBridge 挂起征询 → CloudCard 的
  // MergePreviewDialog 打开，组件事件 settle 结清（取消/卸载=false，runner 记跳过态）
  onManualConfirm: (preview) => requestMergeConfirm(preview),
  // 逐源进度（spec §5 ⑥，T11）：经 cloudSyncBridge → CloudCard「x/y 源完成」spinner
  onProgress: (done, total) => setSyncProgress(done, total),
  onError: (err) => console.warn('[cloudAutoSync]', err),
})

/** 解锁方式按端命名：UA 平台标识判定宿主端。
 *  依据（自审声明）：desktop 桌面壳 UA 形态——Windows WebView2 恒含 "Windows NT"；
 *  macOS WKWebView/Safari 恒含 "Mac OS X"（"Macintosh" 平台段）；Linux 桌面浏览器 UA
 *  恒含 "X11; Linux"。桌面端不存在 iPhone/iPad 形态，排除规则仅作防御（防 UA 伪造/异常）。 */
const ua = navigator.userAgent
const isMac = /Mac/i.test(ua) && !/iPhone|iPad/i.test(ua)
const isWin = /Windows/i.test(ua)
/** 解锁方式显示名（D2 抽串）：改工厂调用时取词——securityPlatform computed 求值与 dpapiOps.label
 *  getter 读取均发生在 i18n 装入后，且经 locale ref 建立响应依赖（locale 切换联动） */
const unlockNaming = (): { prfLabel: string; osAutoLabel: string | null } =>
  isMac
    ? { prfLabel: 'Touch ID (Passkey)', osAutoLabel: tr('desktop.unlockKeychain') }
    : isWin
      ? { prfLabel: 'Windows Hello (Passkey)', osAutoLabel: tr('desktop.unlockWindows') }
      : { prfLabel: 'Passkey', osAutoLabel: tr('desktop.unlockKeyring') }

/** OS 自动解锁通道（三平台统一，见 lib.rs os_auto_protect/unprotect）：Windows 下委托同一
 *  DEK 通道（运行时行为与旧 dpapi_* 命令等价），macOS/Linux 经 keyring。Rust os_auto_* 与
 *  dpapi_* 命令并存，dpapi_* 保留供语义兼容（kekSources kind 仍 'dpapi'）。
 *  F3：Windows 侧 v2 格式 = TOTPDEK1 前缀 + DPAPI(DEK, 应用附加熵)，仅主窗口可调用，
 *  旧格式（无熵）由 Rust 32B 兜底解出并在解锁后迁移（migrateDekWrapToEntropyBound）。
 *  SecurityCard（启用/移除）与 LockScreen（挂载静默解锁）共用同一对象；label 注入按端显示名
 *  （?? 回退防未来分支 osAutoLabel 变 null 时静默 undefined），techSuffix 为已绑定行技术标注 */
const dpapiOps: DpapiUnlockOps = {
  // getter：读取时取词（SecurityCard/LockScreen 渲染期读取，晚于 i18n 装入；?? 回退防未来分支为 null）
  get label() { return unlockNaming().osAutoLabel ?? tr('desktop.unlockWindows') },
  techSuffix: isWin ? '（DPAPI）' : isMac ? '（Keychain）' : '（Secret Service）',
  source: computed(() => store.value?.dpapiSource.value ?? null),
  getCurrentDek: () => store.value?.getCurrentDek() ?? null,
  protect: (dek) => osAutoProtectOs(dek),
  unprotect: (wrapped) => osAutoUnprotectOs(wrapped),
  async add(wrappedDekD) {
    const s = store.value
    if (!s) throw new Error('数据尚未就绪')
    await s.addDpapiSourceOp(wrappedDekD)
  },
  async remove() {
    const s = store.value
    if (!s) throw new Error('数据尚未就绪')
    await s.removeDpapiSourceOp()
    // 审查 M1（C1 遗留）：移除成功后 best-effort 清 keyring DEK 条目（mac/Linux；Windows 为
    // 报错桩，静默忽略）。失败不影响移除主流程——security JSON 已更新，残留条目仅是 OS 凭据
    // 库卫生问题。mac/Linux keyring 分支未真机验证挂账不变（见 tauriSecurity.ts 头注释）。
    // 失败不吞进黑洞：warn 留痕（排查残留条目时需要失败原因），不弹 UI
    void osAutoForgetOs().catch((e: unknown) => { console.warn('[desktop] keyring 条目清理失败', e) })
  },
}

/** F3 迁移：历史 wrappedDekD（无应用附加熵的旧格式）在下一次成功解锁后重包为 v2 应用熵绑定
 *  格式（TOTPDEK1 前缀 + DPAPI(DEK, 熵)，见 tauriSecurity 与 lib.rs dek 通道）。幂等（已是 v2 跳过）；
 *  best-effort：失败仅告警——Rust 端旧格式 32B 兜底仍可解锁，下次成功解锁重试 */
async function migrateDekWrapToEntropyBound(): Promise<void> {
  const s = store.value
  const src = dpapiOps.source.value
  const dek = s?.getCurrentDek()
  if (!s || s.locked.value || !src || !dek) return
  if (isEntropyBoundDekWrap(src.wrappedDekD)) return
  try {
    await dpapiOps.add(await dpapiOps.protect(dek))
  } catch (e) {
    console.warn('[migrate] DEK 包裹升级为应用熵绑定格式失败（旧格式仍可解锁，下次重试）', e)
  }
}

/** 安全平台：security 闭包绑 store；剪贴板开关走 settings+commitSettings；desktop 无 popup，不提供 popupCloseDelayMs；
 *  passkey(PRF)：WebAuthn 交互（创建/求值）经 ui prf.ts，绑定落盘走 store 的 prf 源 op。
 *  plan16 T11 审查四项：changePassphrase opts 透传（漏接=档位切换误触发全库轮换）、kdfProfile、
 *  passwordChangedAt、lockPrefs——.vue 无 typecheck 对 platform 成员的覆盖，漏接无编译信号，全量接线。 */
const securityPlatform = computed<SecurityPlatform | null>(() => {
  const s = store.value
  if (!s) return null
  return {
    security: {
      locked: s.locked,
      hasEncryption: s.hasEncryption,
      enableEncryption: (pw) => s.enableEncryption(pw),
      disableEncryption: () => s.disableEncryption(),
      // opts 透传：档位切换走 { rotateDek: false, profile }（重 wrap 立即生效，不误触发全库轮换）
      changePassphrase: (pw, opts) => s.changePassphrase(pw, opts),
      kdfProfile: computed(() => s.securitySettings.value?.profile ?? 'balanced'),
      passwordChangedAt: computed(() => s.securitySettings.value?.passwordChangedAt ?? null),
      passkey: {
        sources: computed(() => s.prfSources.value.map((p) => ({ credentialId: p.credentialId }))),
        prfSupported: () => prfSupported(),
        async add() {
          // 绑定盐：注册期 create 与权威 get 均以该盐求值，解锁期用同一盐复现（同认证器+同盐→同输出）
          const salt = randomBytes(32)
          const created = await createPrfCredential('TOTP 验证码工具', salt, {
            excludeCredentialIds: s.prfSources.value.map((p) => p.credentialId),
          })
          if (!created) return false
          await s.addPrfSourceOp(created.credentialId, created.prfOutput, salt)
          return true
        },
        remove: (credentialId) => s.removePrfSourceOp(credentialId),
      },
    },
    dpapi: dpapiOps,
    unlockNaming: unlockNaming(),
    clipboardClearEnabled: computed(() => s.settings.clipboardClearEnabled),
    async setClipboardClear(v) {
      s.settings.clipboardClearEnabled = v
      await s.commitSettings()
    },
    // 锁定策略（plan16 T11）：三字段整体覆写进 settings 后持久化（core loadSettings 已归一化）。
    // 审查 I10：desktop 无会话级 DEK 存储 → lockOnRestart 全平台无实现支撑（重启必锁）；
    // 系统锁屏事件源仅 Windows（lock_events WTS），非 Windows 追加声明 lockOnSystemLock——
    // SecurityCard 按 unsupported 隐藏对应开关防无效设置
    lockPrefs: {
      get: () => ({ lockOnRestart: s.settings.lockOnRestart, lockIdleMinutes: s.settings.lockIdleMinutes, lockOnSystemLock: s.settings.lockOnSystemLock }),
      set: (p) => {
        Object.assign(s.settings, p)
        void s.commitSettings()
      },
      unsupported: lockPrefsUnsupportedKeys(ua),
    },
  }
})

/**
 * 旧数据迁移编排（plan16 T14，幂等可重复跑）：历史 wrappedDekD → v2 应用熵绑定重包（F3，
 * 需 DEK 在手）→ vault.backupSecret → 保管区（store op）→ localStorage 备份偏好 + AppData
 * backupDir → 默认本地源 → 旧云多目标键 → 源模型 + 保管区凭据。
 * locked 短路（保管区写入需 DEK）；未启用加密时 saveCred 守护抛错 → 云旧键保留（先写新后删旧），
 * 待启用加密后任一次重跑自愈。汇合点两处：onMounted initStore 后（含 DPAPI/会话恢复态）与
 * LockScreen @unlocked（口令/PRF 解锁成功回调）。
 */
async function runLegacyMigrations(): Promise<void> {
  const s = store.value
  if (!s || s.locked.value) return
  try {
    // F3：DPAPI 静默解锁成功（或会话恢复）后第一时间把旧格式 wrappedDekD 重包为应用熵绑定格式
    await migrateDekWrapToEntropyBound()
    await s.migrateLegacySecrets()
    // localStorage backupMode/backupKeepN + AppData backupDir → 默认本地源（backupSources 键已存在则跳过）
    let legacyDir: string | null = null
    try {
      legacyDir = (await requireAdapter().get(BACKUP_DIR_KEY)) || null // 空串按无目录
    } catch { /* 读失败按无目录 */ }
    const local = await migrateLegacyLocalSource(requireAdapter(), { retention: legacyRetention(), dir: legacyDir })
    if (local === 'migrated') {
      try {
        localStorage.removeItem(BACKUP_MODE_KEY)
        localStorage.removeItem(BACKUP_KEEP_N_KEY)
      } catch { /* localStorage 不可用不影响迁移本身 */ }
    }
    const n = await migrateLegacyCloudSources(requireAdapter(), { saveCred: (id, cred) => requireStore().saveSourceCredOp(id, cred) })
    if (n > 0) console.info(`[migrate] 已迁移 ${n} 个云目标到新模型`)
  } catch (e) {
    console.warn('[migrate] 旧数据迁移失败（旧键保留，解锁后重试）', e)
  }
}

// ---------- 锁定策略执行（plan16 T15，设计 §1 四触发器的桌面端执行面）----------
// 系统锁屏：Rust lock_events 模块（Windows WTS）广播 system-lock（mac/Linux 挂账，事件恒不触发
// 自然降级）；回调实时读 settings（不缓存快照），开关变更即时生效；store.lock() 幂等。
let unlistenSystemLock: (() => void) | null = null

// 空闲超时：与 extension lockEnforcer（chrome.idle 版）语义一致的原生实现——document 级
// pointerdown/keydown 节流刷新活动时间戳，30s tick 用 core shouldLockNow 判定（idleLock.ts）；
// deps 每 tick 现读 settings；store 未就绪时 isLocked 兜底 true（与 autoRunner 同口径）恒不动作。
const idleLock = createIdleLockExecutor({
  getIdleMinutes: () => store.value?.settings.lockIdleMinutes ?? 0,
  isLocked: () => store.value?.locked.value ?? true,
  lock: () => store.value?.lock(),
  now: () => Date.now(),
})
const onUserActivity = (): void => idleLock.notifyActivity()

// ---------- MCP 事件桥与首连审批（plan17 T10）----------
// 平台适配器：三配置命令 + 审批吊销 + 复制复用 copyToClipboard（F16 暂存通道 + 自动清空与取码复制同一事实源）
const mcpPlatform: McpPlatform = {
  getConfig: () => invoke('mcp_get_config') as Promise<McpConfigWithStatusDto>,
  setConfig: (cfg) => invoke('mcp_set_config', { cfg }) as Promise<void>,
  regenerateToken: () => invoke('mcp_regenerate_token') as Promise<string>,
  revokeApprovals: () => invoke('mcp_revoke_approvals') as Promise<number>,
  copyText: (value) => copyToClipboard(value),
}

// 验收条目4：开发者平台适配器（WebView 远程调试设置读写）；改配置后重启，由 run() 最早期 apply_devtools_env 注入生效
const devtoolsPlatform: DevtoolsPlatform = {
  getConfig: () => invoke('devtools_get_config') as Promise<DevtoolsConfigDto>,
  setConfig: (enabled, port) => invoke('devtools_set_config', { enabled, port }) as Promise<void>,
}

// 释放策略平台适配器（spec 批⑧ §7.5）：桥接 release_policy_get/set（Rust 侧 snake_case 参数 +
// rename_all="camelCase"，invoke 键即 pauseMinutes/destroyMinutes/lockOnPause/lockOnDestroy）
const releasePlatform: ReleasePlatform = {
  getConfig: () => invoke('release_policy_get') as Promise<ReleasePolicyDto>,
  setConfig: (cfg) => invoke('release_policy_set', {
    pauseMinutes: cfg.pauseMinutes, destroyMinutes: cfg.destroyMinutes, lockOnPause: cfg.lockOnPause, lockOnDestroy: cfg.lockOnDestroy,
  }) as Promise<void>,
}

let mcpStop: (() => void) | null = null
// 首连审批队列（原单槽位 approval 的并发根修：对话框打开期间不同 ident 事件互相覆盖、
// 弹窗乒乓，见 mcpApprovalQueue.ts）。审批窗独立于锁定态（锁定时取码在桥内报 vault locked，属预期）
const approvalQueue = createMcpApprovalQueue({
  respond: async (ident, action) => {
    await invoke('mcp_approval_response', { ident, action })
  },
})
/** 模板消费的队首待审批；null=无待审批 */
const approval = approvalQueue.current
let unlistenApproval: (() => void) | null = null
// 工具级确认事件监听（T7）：与首连审批监听同风格独立容错注册
let unlistenToolApproval: (() => void) | null = null

/** 首连审批裁定（三键与关闭同路径）：队列先弹出队首再回执（清窗防连点重复回执）；审批无会话无 TTL，
 *  deny 后 Rust 侧 DENY_COOLDOWN 60s 冷却自然退避；回执失败仅告警不中断
 *  （客户端重试会再次弹审批窗，用户可再裁定）。队首为工具确认时不响应（通道分流，防误弹） */
function onApprovalAction(action: McpApprovalAction): void {
  const head = approvalQueue.current.value
  if (head && !isToolConfirmItem(head)) approvalQueue.resolve(head.ident, action)
}

/** 工具确认 Allow（T7）：逐次即焚无记忆授权，裁定即弹出并由 onDecide 回执 mcp_respond */
function onToolAllow(): void {
  const head = approvalQueue.current.value
  if (head && isToolConfirmItem(head)) approvalQueue.resolveTool(head.id, true)
}

/** 对话框关闭（Esc/遮罩/工具确认 Deny 键）：按队首通道分流 deny——首连审批回执 deny 进 60s
 *  冷却（「关掉=别再问了」）；工具确认回 result:false（拒绝统一 false，ok:false 留给异常） */
function onConsentClose(): void {
  const head = approvalQueue.current.value
  if (!head) return
  if (isToolConfirmItem(head)) approvalQueue.resolveTool(head.id, false)
  else approvalQueue.resolve(head.ident, 'deny')
}

onMounted(async () => {
  // 系统锁屏事件（plan16 T15）：WTS_SESSION_LOCK → system-lock 广播 → 按设置锁定
  unlistenSystemLock = await listen('system-lock', () => {
    if (store.value?.settings.lockOnSystemLock) store.value?.lock()
  })
  // 空闲锁定执行器：活动监听 + 30s tick（锁定延迟最长一个 tick 粒度）
  document.addEventListener('pointerdown', onUserActivity, { passive: true })
  document.addEventListener('keydown', onUserActivity)
  idleLock.start()
  // 主窗口失焦自动隐藏：仅注册一次，回调内实时读取开关值（勿在 watch 里叠加监听）
  const win = getCurrentWindow()
  const un = await win.onFocusChanged(({ payload: focused }) => {
    if (!focused && store.value?.settings.blurHideEnabled && win.label === 'main') void win.hide()
  })
  unlistenFocus = un
  try {
    const adapter = await createTauriFs()
    fsAdapter = adapter
    // spec §7 末尾：主窗口独立解锁——windowId='main' 与 mini 隔离 DEK；
    // onCommitted：任何经队列的写 op 成功后触发自动备份变更检测（锁定态由 runner 内 decideAutoRun 挡下）
    const s = createVueStore(adapter, { windowId: 'main', onCommitted: () => auto.notifyChanged() })
    await s.initStore()
    // 释放策略联动（spec 批⑧ §7.4-7.5，Task 14）：锁库事件 + 不锁库路径的 DEK 暂存回注。
    // 监听容错注册（失败仅该联动降级，不放大为整屏 loadError）
    unlistenForceLock = await listen('force-lock', () => {
      store.value?.lock()
    }).catch(() => null)
    unlistenStashDek = await listen('stash-dek-request', () => {
      // getCurrentDek：解锁态返回本窗口 DEK，锁定/未启用返回 null（锁库路径自然不上报）
      const dek = store.value?.getCurrentDek()
      if (dek) void invoke('stash_dek', { dek: bytesToBase64(dek) }).catch(() => {})
    }).catch(() => null)
    // 重建/冷启动回注（store 初始化后、首个页面渲染前）：有暂存 DEK 则恢复解锁态
    // （store.unlockWithDek 等价解锁后状态：写 dekByWin/dekPersist + 刷新 vault + 退出锁定 + 重装载保管区）；
    // 锁库路径无暂存（锁库时 Rust 侧清槽），DEK 失效（换库/损坏）抛错保持锁定页，自然兜底
    const stashed = await invoke<string | null>('take_stashed_dek').catch(() => null)
    if (stashed) {
      try {
        await s.unlockWithDek(base64ToBytes(stashed))
      } catch (e) {
        console.warn('[release] 暂存 DEK 回注失败，保持锁定', e)
      }
    }
    store.value = s
    // D1 i18n 挂载：设置已从盘载入（含 locale），装入 i18n 供组件树 useI18n/$t
    mountI18n(s)
    // 旧数据迁移（plan16 T14）：initStore 已完成解锁态判定，解锁态在此直接跑（幂等）；
    // 第二汇合点在模板 LockScreen @unlocked（口令/PRF 解锁成功后补跑）
    await runLegacyMigrations()
    auto.start()
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(s)
    const iconStore = createIconStore(adapter)
    await iconStore.init()
    icons.value = iconStore
  } catch (e) {
    // D2 抽串：前缀文案移至模板 tr()（i18n 可能未装入——initStore 失败先于 mountI18n），此处只存原始消息
    loadError.value = e instanceof Error ? e.message : String(e)
  }
  // MCP 装配（plan17 T10，可选增强功能）：独立 try/catch——MCP 故障只降级告警，绝不放大为
  // 整屏 loadError，也不阻断上方关键初始化与后续迁移/主题/图标；放在主 try 之外，
  // 关键初始化失败时 MCP 仍可装配（requireEntries 闭包惰性读 store，未就绪报 vault locked）
  try {
    // 只主窗口装配（本文件即 main；mini 另案）；锁定门控在 requireEntries 抛错（'vault locked' 文案直达 AI 客户端）
    const mcpDeps: McpBridgeDeps = {
      requireEntries: () => {
        const st = store.value
        if (!st || st.locked.value) throw new Error('vault locked')
        return st.vault.entries
      },
      tagsOf: (e) => {
        const tags = store.value?.vault.tags ?? []
        return e.tagIds.map((id) => tags.find((t) => t.id === id)?.name).filter((n): n is string => !!n)
      },
      // 触发器装配（spec §6.1；终审 I2 受理即返回）：前置同步判定回结构化 reason，触发通道
      // 启动但不等待（bridge_call 固定 5s 超时，慢同步/备份若 await 会把「仍在后台执行」误报
      // 成 app busy）；no enabled sources / no primary target 类原因由 runner recordStatus 记录、
      // 此处不重复判定——triggered=true 语义为「已受理执行」，业务结果经状态行呈现，绝不返回
      // vault 数据
      ...createMcpTriggers({
        guard: () => {
          const s = store.value
          if (!s || s.locked.value) return { triggered: false, reason: 'vault locked' }
          if (s.backupSecret.value === null) return { triggered: false, reason: 'no backup secret' }
          return null
        },
        runSync: () => cloudSync.run('manual'),
        runBackup: () => auto.runBackupNow(),
      }),
    }
    mcpStop = await startMcpBridge(mcpDeps, { listen, invoke: (c, a) => invoke(c, a as never).then(() => {}) })
  } catch (e) {
    console.warn('[mcp] MCP 桥装配失败，已降级跳过（不影响应用主流程）', e)
  }
  // 首连审批事件监听注册同理单独容错：事件入审批队列（同 ident 10s 去重见 mcpApprovalQueue.ts）
  try {
    unlistenApproval = await listen<{ ident: string; tool: string }>('mcp://approval', (e) => {
      approvalQueue.enqueue(e.payload)
    })
  } catch (e) {
    console.warn('[mcp] MCP 审批监听注册失败，已降级跳过（不影响应用主流程）', e)
  }
  // 工具级确认事件（spec §6.2，T7）：入同一审批队列弹「允许执行 <tool>？」（无 trust/once 梯度）；
  // 裁定后经既有 mcp_respond 回 {id, ok:true, result:allow, error:null}（allow=result true，
  // 拒绝统一 result:false）。60s 无响应由 Rust 侧超时兜底 fail-closed，回执失败仅告警
  try {
    unlistenToolApproval = await listen<{ id: number; ident: string; tool: string }>('mcp://tool-approval', (e) => {
      approvalQueue.queueToolConfirmation(e.payload, (allow) => {
        void invoke('mcp_respond', { id: e.payload.id, ok: true, result: allow, error: null }).catch((err) =>
          console.warn('[mcp] mcp_respond(tool confirm) failed', err),
        )
      })
    })
  } catch (e) {
    console.warn('[mcp] MCP 工具确认监听注册失败，已降级跳过（不影响应用主流程）', e)
  }
})

onScopeDispose(() => {
  auto.stop()
  mcpStop?.()
  unlistenApproval?.()
  unlistenToolApproval?.()
  unlistenFocus?.()
  unlistenSystemLock?.()
  unlistenForceLock?.()
  unlistenStashDek?.()
  idleLock.stop()
  // 卸载清算（T7）：未决工具确认立即回 result:false（Rust oneshot 不悬挂等 60s 超时兜底）
  approvalQueue.dispose()
  document.removeEventListener('pointerdown', onUserActivity)
  document.removeEventListener('keydown', onUserActivity)
})

/** 30s 清剪贴板：settings.clipboardClearEnabled 开启时复制后定时清空（重复复制重置计时；setup 作用域销自动 dispose；
 *  store 未就绪时读不到开关视为关闭）。
 *  F16：清除经 Rust clipboard_clear_if_staged 读回比对（仍为本应用复制内容才清空），dispose 欠清除补清、
 *  失败重试上报；托盘退出另有原生兜底。剪贴板读取只在 Rust 侧，webview JS 无读取能力 */
const clearer = createClipboardClearer(
  () => store.value?.settings.clipboardClearEnabled === true,
  () => invoke('clipboard_clear_if_staged').then(() => {}),
)

const copyFailed = ref(false) // 复制失败横幅（真机发现：剪贴板被第三方进程独占时 stage 命令拒绝，原实现静默无提示）
let copyFailedTimer: ReturnType<typeof setTimeout> | null = null

async function copyToClipboard(code: string) {
  // F16：复制经 Rust stage 命令登记暂存值（退出兜底比对的事实源）
  try {
    await invoke('stage_clipboard_write', { value: code })
  } catch {
    copyFailed.value = true
    if (copyFailedTimer) clearTimeout(copyFailedTimer)
    copyFailedTimer = setTimeout(() => (copyFailed.value = false), 3000)
    return
  }
  clearer.notifyCopied()
}

/** Rail 底部「隐藏到托盘」：原 header 按钮迁移为 Shell 动作（失焦自动隐藏开关迁至设置页）。
 *  label 用 getter 读取时取词（Shell 渲染期晚于 i18n 装入，随 locale 联动） */
const railActions = [{ get label() { return tr('desktop.hideToTray') }, onClick: () => void getCurrentWindow().hide() }]
</script>

<template>
  <div v-if="copyFailed" class="copy-failed" role="alert">{{ tr('desktop.copyFailed') }}</div>
  <div v-if="loadError && !store" class="error">{{ tr('desktop.loadFailed', { message: loadError }) }}</div>
  <!-- 解锁成功回调补跑迁移（plan16 T14，幂等）：口令/PRF 解锁各路径在 LockScreen 内 emit unlocked -->
  <LockScreen v-else-if="store && locked" :store="store" :dpapi="dpapiOps" @unlocked="runLegacyMigrations" />
  <NavigationShell v-else-if="store" :store="store" :platform="backupPlatform" :security-platform="securityPlatform" :cloud-platform="cloudPlatform" :icons="icons" :schemes-api="schemesApi" :rail-actions="railActions" :mcp-platform="mcpPlatform" :devtools-platform="devtoolsPlatform" :release-platform="releasePlatform" @copy="copyToClipboard" />
  <!-- MCP 首连审批/工具确认独立于上方 v-if 链：锁定态也要能弹（plan17 T10）；t 走壳层 tr（desktop 无 useI18n 注入） -->
  <!-- 关闭（Esc/遮罩/工具 Deny）按通道分流 deny：首连回执进 60s 冷却，工具确认回 result:false（逐次即焚）——
       否则 "approval pending" 诱导 AI 每 10s 重试、对话框反复重开抢焦点 -->
  <McpConsentDialog :open="approval !== null" :request="approval" :t="tr" @resolve="onApprovalAction" @allow="onToolAllow" @close="onConsentClose" />
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.error { color: var(--md-sys-color-error); padding: 16px; }
.copy-failed { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 1000; color: var(--md-sys-color-error); background: var(--md-sys-color-error-container); border-radius: 8px; padding: 8px 16px; font-size: var(--md-sys-typescale-body-medium); box-shadow: var(--md-sys-elevation-level2, 0 1px 3px rgba(0,0,0,.3)); }
</style>
