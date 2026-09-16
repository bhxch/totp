<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open, save } from '@tauri-apps/plugin-dialog'
import { backupFileName, createBackupEnvelope, openBackupEnvelope, normalizeSchemes, randomBytes, SCHEMES_KEY, sha256Hex, type CloudCred, type ImportScheme, type StorageAdapter, type Vault } from '@totp/core'
import { createClipboardClearer, createCloudBackend, createCloudSyncRunner, createIconStore, createPrfCredential, createVueStore, LockScreen, NavigationShell, prfSupported, useTheme, type BackupAutoPrefs, type BackupMode, type BackupPlatform, type CloudAutoPrefs, type CloudPlatform, type CloudTarget, type DpapiUnlockOps, type IconStore, type ImportSchemesApi, type SecurityPlatform, type VueStore } from '@totp/ui'
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { createDesktopAutoRunner } from './autoBackup'
import { createBackupToDir, listBackups, readBackupByName, readBackupFileOs, saveConflictBackupToDir, writeBackupFileOs } from './backupService'
import { decryptDpapiOs, readImportFileBytesOs, readImportFileOs } from './importService'
import { createTauriFs } from './tauriFs'
import { dpapiProtectOs, dpapiUnprotectOs } from './tauriSecurity'

const store = ref<VueStore | null>(null)
const icons = ref<IconStore | null>(null)
const loadError = ref('')
let unlistenFocus: (() => void) | null = null

// ---------- 导入映射方案存取 ----------
// adapter 在 onMounted 就绪后赋值；schemesApi 闭包实时读取（旧单页 仅在 store 就绪后渲染，不会读到 null）
let fsAdapter: StorageAdapter | null = null

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

// ---------- 备份平台实现 ----------
// 模式与保留份数属本地偏好（非同步内容）：存桌面 localStorage，key backupMode/backupKeepN
const BACKUP_MODE_KEY = 'backupMode'
const BACKUP_KEEP_N_KEY = 'backupKeepN'
const DEFAULT_KEEP_N = 3

function loadBackupMode(): BackupMode {
  try {
    if (localStorage.getItem(BACKUP_MODE_KEY) === 'overwrite') return { type: 'overwrite' }
    const n = Number(localStorage.getItem(BACKUP_KEEP_N_KEY))
    return { type: 'keep', n: Number.isInteger(n) && n >= 1 ? n : DEFAULT_KEEP_N }
  } catch {
    return { type: 'keep', n: DEFAULT_KEEP_N }
  }
}

function persistBackupMode(m: BackupMode): void {
  try {
    localStorage.setItem(BACKUP_MODE_KEY, m.type)
    if (m.type === 'keep') localStorage.setItem(BACKUP_KEEP_N_KEY, String(m.n))
  } catch { /* 偏好持久化失败不影响功能 */ }
}

const backupMode = ref<BackupMode>(loadBackupMode())

// ---------- 自动备份偏好与自选备份目录（D2/D4）----------
// 两者均为本地偏好：autoPrefs 存桌面 localStorage（ui BackupCard 读写经 platform 同一对函数）；目录存 AppData JSON（fsAdapter）
const BACKUP_AUTO_PREFS_KEY = 'backupAutoPrefs'
const BACKUP_DIR_KEY = 'backupDir'
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

async function getBackupDir(): Promise<string | null> {
  if (!fsAdapter) return null
  try {
    return await fsAdapter.get(BACKUP_DIR_KEY)
  } catch {
    return null
  }
}

async function setBackupDir(d: string | null): Promise<void> {
  if (!fsAdapter) throw new Error('数据尚未就绪')
  if (d === null) await fsAdapter.delete(BACKUP_DIR_KEY)
  else await fsAdapter.set(BACKUP_DIR_KEY, d)
}

/** store 整体替换的唯一实现：backupPlatform.replaceAllOp / cloudPlatform.persistDownloaded / 云 runner persistAdopted 共用 */
async function replaceAllOps(v: Vault): Promise<void> {
  const s = store.value
  if (!s) throw new Error('数据尚未就绪')
  await s.replaceAllOp(v)
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

const backupPlatform: BackupPlatform = {
  get mode() { return backupMode.value },
  async setMode(m) {
    backupMode.value = m
    persistBackupMode(m)
  },
  createBackup: async (vaultJson, password) => {
    const dirOverride = await getBackupDir()
    const r = await createBackupToDir(vaultJson, password, backupMode.value, dirOverride)
    // 手动备份同样记录 lastBackupHash：自动备份的 unchanged 去重以最新落盘内容为基线
    try {
      localStorage.setItem(LAST_BACKUP_HASH_KEY, await sha256Hex(new TextEncoder().encode(vaultJson)))
    } catch { /* hash 记录失败不影响备份本身 */ }
    return r
  },
  async exportToFile(vaultJson, password) {
    // 先出 save 对话框拿路径（取消则直接 false），再做 Argon2id 加密写文件，省一次白跑的 KDF
    const path = await save({ defaultPath: backupFileName(new Date()), filters: BACKUP_FILE_FILTERS })
    if (!path) return false
    const envelope = await createBackupEnvelope(vaultJson, password)
    await writeBackupFileOs(path, envelope)
    return true
  },
  async restoreFromPicker(password) {
    const path = await open({ multiple: false, directory: false, filters: BACKUP_FILE_FILTERS })
    if (typeof path !== 'string') return null
    return { json: await openBackupText(await readBackupFileOs(path), password) }
  },
  listBackups: async () => listBackups(await getBackupDir()),
  async restoreByName(name, password) {
    return { json: await openBackupText(await readBackupByName(name, await getBackupDir()), password) }
  },
  getAutoPrefs: () => loadBackupPrefs(),
  setAutoPrefs: (p) => persistBackupPrefs(p),
  pickBackupDir: async () => {
    const path = await open({ directory: true, multiple: false })
    return typeof path === 'string' ? path : null
  },
  getBackupDir,
  setBackupDir,
  replaceAllOp: async (v) => replaceAllOps(v),
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
  doBackup: async (json, secret) => {
    await createBackupToDir(json, secret, backupMode.value, await getBackupDir())
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
 * 云同步平台实现：凭据与基线存 AppData 本地 JSON（不做系统级加密）。
 * 多目标迁移约定（Task 8，见 ui cloudPlatform.ts 注释块）：
 * - 新键 cloudCreds（JSON CloudTarget[]）/ cloudRevs（JSON Record<backend,string>）；
 *   旧键 cloudCred / cloudRev 只在读取时回退、保存后删除，绝不把旧值写入新键。
 * - 冲突副本写 backups/conflict-{backendKey}-{ts}.totpbackup；采用云端数据经 store.replaceAllOp 整体替换。
 * - 自审（竞态，低概率接受）：自动同步在途期间用户于 CloudCard 改凭据/基线，二者的读-改-写可能
 *   互相覆盖（cloudRevs/cloudCreds 均为整键覆写）；与 runner busy 的防重入只管自动与自动重叠，
 *   与手动同步的并发为已知边界，不引入跨实例锁。
 */
const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_CREDS_KEY = 'cloudCreds'
const CLOUD_REV_KEY = 'cloudRev'
const CLOUD_REVS_KEY = 'cloudRevs'

/** 多目标凭据列表：cloudCreds 缺失而旧 cloudCred 存在 → 视为唯一启用目标（只读回退，不回写新键） */
async function loadCredsImpl(): Promise<CloudTarget[]> {
  if (!fsAdapter) return []
  try {
    const raw = await fsAdapter.get(CLOUD_CREDS_KEY)
    if (raw) return JSON.parse(raw) as CloudTarget[]
    const legacy = await fsAdapter.get(CLOUD_CRED_KEY)
    return legacy ? [{ cred: JSON.parse(legacy) as CloudCred, enabled: true }] : []
  } catch {
    return []
  }
}

async function saveCredsImpl(targets: CloudTarget[]): Promise<void> {
  if (!fsAdapter) throw new Error('数据尚未就绪')
  await fsAdapter.set(CLOUD_CREDS_KEY, JSON.stringify(targets))
  await fsAdapter.delete(CLOUD_CRED_KEY)
}

/** cloudRevs 进程内缓存（undefined=未读）：避免 runner 每轮对同一键重复读盘 */
let cloudRevsCache: Record<string, string> | null | undefined

async function readCloudRevs(): Promise<Record<string, string> | null> {
  if (cloudRevsCache !== undefined) return cloudRevsCache
  if (fsAdapter) {
    try {
      const raw = await fsAdapter.get(CLOUD_REVS_KEY)
      cloudRevsCache = raw ? (JSON.parse(raw) as Record<string, string>) : null
      return cloudRevsCache
    } catch { /* 坏 JSON 按无基线处理 */ }
  }
  cloudRevsCache = null
  return null
}

async function loadTargetHashImpl(backend: string): Promise<string | null> {
  const revs = await readCloudRevs()
  if (revs && revs[backend] !== undefined) return revs[backend] ?? null
  if (revs !== null || !fsAdapter) return null
  // 迁移回退：cloudRevs 缺失且旧 cloudRev 存在 → 仅首个目标（targets[0]）继承旧基线；不回写
  try {
    const legacy = await fsAdapter.get(CLOUD_REV_KEY)
    if (!legacy) return null
    const targets = await loadCredsImpl()
    return targets[0]?.cred.backend === backend ? legacy : null
  } catch {
    return null
  }
}

async function saveTargetHashImpl(backend: string, hash: string | null): Promise<void> {
  if (!fsAdapter) throw new Error('数据尚未就绪')
  const revs = { ...(await readCloudRevs()) }
  if (hash === null) delete revs[backend] // null 语义=删除该 backend 的基线键（非写入 null 值）
  else revs[backend] = hash
  await fsAdapter.set(CLOUD_REVS_KEY, JSON.stringify(revs))
  cloudRevsCache = revs
  await fsAdapter.delete(CLOUD_REV_KEY) // 迁移约定：保存只写新键并删除旧键
}

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

/** 「上次自动备份/同步」状态记录（design §4.1：{at, ok, summary}；Task 13 卡片渲染消费，本任务只写） */
const BACKUP_AUTO_STATUS_KEY = 'backupAutoStatus'
const CLOUD_AUTO_STATUS_KEY = 'cloudAutoStatus'

function recordAutoStatus(key: 'backupAutoStatus' | 'cloudAutoStatus', ok: boolean, summary: string): void {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), ok, summary }))
  } catch { /* 状态记录失败不影响主流程 */ }
}

const cloudPlatform: CloudPlatform = {
  async loadCred() {
    if (!fsAdapter) return null
    try {
      const raw = await fsAdapter.get(CLOUD_CRED_KEY)
      return raw ? (JSON.parse(raw) as CloudCred) : null
    } catch {
      return null
    }
  },
  async saveCred(c) {
    if (!fsAdapter) throw new Error('数据尚未就绪')
    await fsAdapter.set(CLOUD_CRED_KEY, JSON.stringify(c))
  },
  readVaultJson() {
    const s = store.value
    if (!s) throw new Error('数据尚未就绪')
    return JSON.stringify(s.vault)
  },
  persistDownloaded: (json) => replaceAllOps(JSON.parse(json) as Vault),
  saveConflictBackup: async (bytes, backendKey) => saveConflictBackupToDir(bytes, await getBackupDir(), backendKey),
  async loadHash() {
    if (!fsAdapter) return null
    try {
      return await fsAdapter.get(CLOUD_REV_KEY)
    } catch {
      return null
    }
  },
  async saveHash(hash) {
    if (!fsAdapter) throw new Error('数据尚未就绪')
    await fsAdapter.set(CLOUD_REV_KEY, hash)
  },
  // ---- 多目标新成员（Task 11；旧四成员 Task 13 才删） ----
  loadCreds: loadCredsImpl,
  saveCreds: saveCredsImpl,
  loadTargetHash: loadTargetHashImpl,
  saveTargetHash: saveTargetHashImpl,
  autoPrefs: {
    get: () => loadCloudPrefs(),
    set: (p) => persistCloudPrefs(p),
  },
}

/** 自动云同步 runner（D6）：多目标编排收敛于 core syncMultipleTargets（runner 实现自本文件上提至
 *  ui 共享，desktop/extension 同一实现）；冲突副本已由 onConflictBackup 落盘，故 adopt 分支自动执行、
 *  不弹确认——裁定来源=设计 §4「自动执行结果不打扰」（区别于 CloudCard 手动同步的两步确认） */
const cloudSync = createCloudSyncRunner({
  isLocked: () => store.value?.locked.value ?? true,
  getSecret: () => store.value?.backupSecret.value ?? null,
  getVaultJson: () => JSON.stringify(store.value?.vault ?? null),
  loadCreds: loadCredsImpl,
  loadTargetHash: loadTargetHashImpl,
  saveTargetHash: saveTargetHashImpl,
  // onCredChange（GDrive 首推回存 fileId / gist public 探测回写）：以新凭据替换同 backend 项后落盘；
  // loadCreds 返回空（IO/坏 JSON 瞬时失败）时跳过回写，防止把空列表固化为凭据存储（审查 M-1）
  makeBackend: (cred) => createCloudBackend(cred, (next) => {
    void loadCredsImpl()
      .then((targets) => {
        if (targets.length === 0) return
        return saveCredsImpl(targets.map((t) => (t.cred.backend === next.backend ? { ...t, cred: next } : t)))
      })
      .catch((e) => console.warn('[cloudAutoSync] 凭据回存失败', e))
  }),
  persistAdopted: (json) => replaceAllOps(JSON.parse(json) as Vault),
  saveConflictBackup: async (key, bytes) => {
    await saveConflictBackupToDir(bytes, await getBackupDir(), key)
  },
  recordStatus: (ok, summary) => recordAutoStatus(CLOUD_AUTO_STATUS_KEY, ok, summary),
  onError: (err) => console.warn('[cloudAutoSync]', err),
})

/** DPAPI(Windows) 自动解锁通道：Rust dpapi_protect/unprotect + store dpapi 源 op。
 *  SecurityCard（启用/移除）与 LockScreen（挂载静默解锁）共用同一对象 */
const dpapiOps: DpapiUnlockOps = {
  source: computed(() => store.value?.dpapiSource.value ?? null),
  getCurrentDek: () => store.value?.getCurrentDek() ?? null,
  protect: (dek) => dpapiProtectOs(dek),
  unprotect: (wrapped) => dpapiUnprotectOs(wrapped),
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
 *  passkey(PRF)：WebAuthn 交互（创建/求值）经 ui prf.ts，绑定落盘走 store 的 prf 源 op */
const securityPlatform = computed<SecurityPlatform | null>(() => {
  const s = store.value
  if (!s) return null
  return {
    security: {
      locked: s.locked,
      hasEncryption: s.hasEncryption,
      enableEncryption: (pw) => s.enableEncryption(pw),
      disableEncryption: () => s.disableEncryption(),
      changePassphrase: (pw) => s.changePassphrase(pw),
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
    clipboardClearEnabled: computed(() => s.settings.clipboardClearEnabled),
    async setClipboardClear(v) {
      s.settings.clipboardClearEnabled = v
      await s.commitSettings()
    },
  }
})

onMounted(async () => {
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
  <LockScreen v-else-if="store && store.locked" :store="store" :dpapi="dpapiOps" />
  <NavigationShell v-else-if="store" :store="store" :platform="backupPlatform" :security-platform="securityPlatform" :cloud-platform="cloudPlatform" :icons="icons" :schemes-api="schemesApi" :rail-actions="railActions" @copy="copyToClipboard" />
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.error { color: var(--md-sys-color-error); padding: 16px; }
</style>
