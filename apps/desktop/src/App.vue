<script setup lang="ts">
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open, save } from '@tauri-apps/plugin-dialog'
import { backupFileName, createBackupEnvelope, loadSourceRevs, loadSources, normalizeSchemes, openBackupEnvelope, randomBytes, saveSourceRev, saveSources, SCHEMES_KEY, sha256Hex, type BackupSource, type CloudCred, type ImportScheme, type KdfProfile, type Retention, type StorageAdapter, type Vault } from '@totp/core'
import { createClipboardClearer, createCloudBackend, createCloudSyncRunner, createIconStore, createPrfCredential, createVueStore, LockScreen, NavigationShell, prfSupported, useTheme, type BackupAutoPrefs, type BackupPlatform, type CloudAutoPrefs, type CloudPlatform, type DpapiUnlockOps, type IconStore, type ImportSchemesApi, type LocalSourceView, type SecurityPlatform, type VueStore } from '@totp/ui'
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { createDesktopAutoRunner, formatAutoStatusText } from './autoBackup'
import { createBackupToSources, listBackupsFromSources, readBackupByName, readBackupFileOs, saveConflictBackupToDir, saveCloudSourcesPreservingLocal, writeBackupFileOs } from './backupService'
import { decryptDpapiOs, readImportFileBytesOs, readImportFileOs } from './importService'
import { createIdleLockExecutor } from './idleLock'
import { lockPrefsUnsupportedKeys } from './lockPrefs'
import { BACKUP_DIR_KEY, migrateLegacyCloudSources, migrateLegacyLocalSource } from './legacyMigrate'
import { createTauriFs } from './tauriFs'
import { osAutoProtectOs, osAutoUnprotectOs } from './tauriSecurity'

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

// 最后一次导入选择的路径（模块级缓存）：SQLite 字节入口复用，避免同一文件二次弹窗
let lastImportPath: string | null = null

/** envelope 文本 → 解密出明文 vault JSON（口令错误/文件损坏由 openBackupEnvelope 抛错，卡片统一展示） */
async function openBackupText(text: string, password: string): Promise<string> {
  return openBackupEnvelope(JSON.parse(text), password)
}

const BACKUP_FILE_FILTERS = [{ name: 'TOTP 备份', extensions: ['totpbackup'] }]
// 与 Rust 端 read_import_file_os 扩展名白名单一致（.json/.wauth/.xml/.txt/.aegis）+ SQLite .db/.sqlitedb/.sqlite
// （.db 经文本读取报 UTF-8 错时由 ImportCard 转字节入口复查，见 read_import_file_bytes_os）
const IMPORT_FILE_FILTERS = [
  { name: '导入文件', extensions: ['json', 'wauth', 'txt', 'aegis', 'xml', 'db', 'sqlitedb', 'sqlite'] },
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
    const source: BackupSource = { ...v, kind: 'local' }
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
    // 先出 save 对话框拿路径（取消则直接 false），再做 Argon2id 加密写文件，省一次白跑的 KDF（档位随备份设置）
    const path = await save({ defaultPath: backupFileName(new Date()), filters: BACKUP_FILE_FILTERS })
    if (!path) return false
    const envelope = await createBackupEnvelope(vaultJson, password, kdfProfileOf())
    await writeBackupFileOs(path, envelope)
    return true
  },
  async restoreFromPicker(password) {
    const path = await open({ multiple: false, directory: false, filters: BACKUP_FILE_FILTERS })
    if (typeof path !== 'string') return null
    return { json: await openBackupText(await readBackupFileOs(path), password) }
  },
  listBackups: async () => listBackupsFromSources(await loadAllSources()),
  async restoreByName(sourceId, name, password) {
    return { json: await openBackupText(await readBackupByName(sourceId, name, await loadAllSources()), password) }
  },
  getAutoPrefs: () => loadBackupPrefs(),
  setAutoPrefs: (p) => persistBackupPrefs(p),
  getAutoStatus: async () => readAutoStatusText(BACKUP_AUTO_STATUS_KEY),
  pickBackupDir: async () => {
    const path = await open({ directory: true, multiple: false })
    return typeof path === 'string' ? path : null
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
    const path = await open({ multiple: false, directory: false, filters: IMPORT_FILE_FILTERS })
    if (typeof path !== 'string') return null
    lastImportPath = path
    return { text: await readImportFileOs(path), name: path.split(/[\\/]/).pop() ?? path }
  },
  // SQLite 字节入口：复用最近一次选择的路径（避免二次弹窗）；无最近选择时补弹对话框
  async readImportFileBytes() {
    const path = lastImportPath ?? (await open({ multiple: false, directory: false, filters: IMPORT_FILE_FILTERS }))
    if (typeof path !== 'string') return null
    return { bytes: await readImportFileBytesOs(path), name: path.split(/[\\/]/).pop() ?? path }
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
  loadTargetHash: async (id) => (await loadSourceRevs(requireAdapter()))[id] ?? null,
  saveTargetHash: (id, h) => saveSourceRev(requireAdapter(), id, h),
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
  loadTargetHash: async (id) => (await loadSourceRevs(requireAdapter()))[id] ?? null,
  saveTargetHash: (id, h) => saveSourceRev(requireAdapter(), id, h),
  makeBackend: (cred) => createCloudBackend(cred),
  persistAdopted: (json) => replaceAllOps(JSON.parse(json) as Vault),
  // 审查 I9：Promise 原样交回 runner/core（syncWithCloud await 冲突回调）——写盘失败让该目标
  // 同步失败（recordStatus 记失败），不再静默吞掉后照常采纳远端并回推覆盖云端旧版本
  saveConflictBackup: (key, bytes) => saveConflictBackupToDir(bytes, null, key),
  kdfProfile: () => kdfProfileOf(),
  sourceName: (id) => cloudSourceNames.get(id) ?? id,
  onRetentionDeleted: (name, deleted) => {
    retentionNotes.push(deleted >= 0 ? `${name} 清理 ${deleted} 份旧云备份` : `${name} 后端不支持远端清理`)
  },
  recordStatus: (ok, summary) => {
    const notes = retentionNotes.join('；')
    retentionNotes = []
    recordAutoStatus(CLOUD_AUTO_STATUS_KEY, ok, notes ? `${summary}；${notes}` : summary)
  },
  onError: (err) => console.warn('[cloudAutoSync]', err),
})

/** 解锁方式按端命名：UA 平台标识判定宿主端。
 *  依据（自审声明）：desktop 桌面壳 UA 形态——Windows WebView2 恒含 "Windows NT"；
 *  macOS WKWebView/Safari 恒含 "Mac OS X"（"Macintosh" 平台段）；Linux 桌面浏览器 UA
 *  恒含 "X11; Linux"。桌面端不存在 iPhone/iPad 形态，排除规则仅作防御（防 UA 伪造/异常）。 */
const ua = navigator.userAgent
const isMac = /Mac/i.test(ua) && !/iPhone|iPad/i.test(ua)
const isWin = /Windows/i.test(ua)
const unlockNaming = isMac
  ? { prfLabel: 'Touch ID (Passkey)', osAutoLabel: '钥匙串自动解锁' }
  : isWin
    ? { prfLabel: 'Windows Hello (Passkey)', osAutoLabel: 'Windows 自动解锁' }
    : { prfLabel: 'Passkey', osAutoLabel: '密钥环自动解锁' }

/** OS 自动解锁通道（三平台统一，见 lib.rs os_auto_protect/unprotect）：Windows 下委托同一
 *  DPAPI（运行时行为与旧 dpapi_* 命令等价），macOS/Linux 经 keyring。Rust os_auto_* 与
 *  dpapi_* 命令并存，dpapi_* 保留供语义兼容（kekSources kind 仍 'dpapi'）。
 *  SecurityCard（启用/移除）与 LockScreen（挂载静默解锁）共用同一对象；label 注入按端显示名
 *  （?? 回退防未来分支 osAutoLabel 变 null 时静默 undefined），techSuffix 为已绑定行技术标注 */
const dpapiOps: DpapiUnlockOps = {
  label: unlockNaming.osAutoLabel ?? 'Windows 自动解锁',
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
  },
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
    unlockNaming,
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
 * 旧数据迁移编排（plan16 T14，幂等可重复跑）：vault.backupSecret → 保管区（store op）→
 * localStorage 备份偏好 + AppData backupDir → 默认本地源 → 旧云多目标键 → 源模型 + 保管区凭据。
 * locked 短路（保管区写入需 DEK）；未启用加密时 saveCred 守护抛错 → 云旧键保留（先写新后删旧），
 * 待启用加密后任一次重跑自愈。汇合点两处：onMounted initStore 后（含 DPAPI/会话恢复态）与
 * LockScreen @unlocked（口令/PRF 解锁成功回调）。
 */
async function runLegacyMigrations(): Promise<void> {
  const s = store.value
  if (!s || s.locked.value) return
  try {
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
    store.value = s
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
    loadError.value = '本地数据初始化失败：' + (e instanceof Error ? e.message : String(e))
  }
})

onScopeDispose(() => {
  auto.stop()
  unlistenFocus?.()
  unlistenSystemLock?.()
  idleLock.stop()
  document.removeEventListener('pointerdown', onUserActivity)
  document.removeEventListener('keydown', onUserActivity)
})

/** 30s 清剪贴板：settings.clipboardClearEnabled 开启时复制后定时清空（重复复制重置计时；setup 作用域销毁自动 dispose；store 未就绪时读不到开关视为关闭） */
const clearer = createClipboardClearer(
  () => store.value?.settings.clipboardClearEnabled === true,
  () => writeText(''),
)

async function copyToClipboard(code: string) {
  await writeText(code)
  clearer.notifyCopied()
}

/** Rail 底部「隐藏到托盘」：原 header 按钮迁移为 Shell 动作（失焦自动隐藏开关迁至设置页） */
const railActions = [{ label: '隐藏到托盘', onClick: () => void getCurrentWindow().hide() }]
</script>

<template>
  <div v-if="loadError && !store" class="error">{{ loadError }}</div>
  <!-- 解锁成功回调补跑迁移（plan16 T14，幂等）：口令/PRF 解锁各路径在 LockScreen 内 emit unlocked -->
  <LockScreen v-else-if="store && locked" :store="store" :dpapi="dpapiOps" @unlocked="runLegacyMigrations" />
  <NavigationShell v-else-if="store" :store="store" :platform="backupPlatform" :security-platform="securityPlatform" :cloud-platform="cloudPlatform" :icons="icons" :schemes-api="schemesApi" :rail-actions="railActions" @copy="copyToClipboard" />
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.error { color: var(--md-sys-color-error); padding: 16px; }
</style>
