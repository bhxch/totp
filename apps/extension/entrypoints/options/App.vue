<script setup lang="ts">
import { backupFileName, base64ToBytes, createAutoRunScheduler, createBackupEnvelope, loadSourceRevs, normalizeSchemes, openBackupEnvelope, OVERWRITE_NAME, randomBytes, saveSourceRev, SCHEMES_KEY, type BackupEnvelope, type ImportScheme, type Retention, type Vault } from '@totp/core'
import { CLIPBOARD_CLEAR_DELAY_MS, createAppI18n, createIconStore, createPrfCredential, LockScreen, NavigationShell, prfSupported, useTheme, type BackupPlatform, type CloudAutoPrefs, type CloudPlatform, type ImportSchemesApi, type SecurityPlatform, type SyncPlatform } from '@totp/ui'
import { computed, getCurrentInstance, onMounted, onUnmounted, ref, watch } from 'vue'
import { createExtensionCloudRunner, downloadConflictBackup } from '../../src/cloudRunnerFactory'
import { formatAutoStatusText, hasLegacyCloudKeys, loadSourcesImpl, migrateLegacySources, saveSourcesImpl } from '../../src/cloudCredStore'
import { createSyncScheduler } from '../../src/syncScheduler'
import { createDekSession } from '../../src/dekSession'
import { createIdleLockWatcher } from '../../src/lockEnforcer'
import { createExtensionStore, storageAdapter } from '../../src/store'
import { markSyncOff, SYNC_STATUS_KEY } from '../../src/syncEngine'

// spec §7 末尾：options 窗口独立解锁——windowId='options' 与 popup 隔离，各持各的 DEK。
// plan16 T12：dekPersist 接 chrome.storage.session——解锁态 DEK 入会话存储，popup 经共享
// session 区自动恢复解锁；本页 initStore 时同样从 session DEK 自动解锁（重启浏览器即清）。
// onCommittedExtra：写提交 → 存活期自动云同步的变更通知（scheduler 在下方定义；写提交只会
// 发生在挂载后的异步时点，闭包引用无 TDZ 问题）
const store = createExtensionStore('options', {
  onCommittedExtra: () => scheduler.notifyChanged(),
  dekPersist: createDekSession(),
})
// D1 i18n 挂载：store 在本组件 setup 创建（页面生命周期内唯一实例），装入当前 app 供全部子组件
// useI18n/$t。appContext.app 须在 setup 同步段取；装入发生在 setup 中段，本组件自身的 script setup
// 内 useI18n() 不可用（注入尚未就绪），壳层翻译走 i18n.global.t——子组件不受限
const i18n = createAppI18n(store)
getCurrentInstance()?.appContext.app.use(i18n)
/** 壳层翻译（i18n.global.t 包装：overload 直赋 TranslateFn 不兼容，同 runner deps.t 既有包装口径；
 *  cloudCredStore 纯函数与 recordStatus 分隔符共用） */
const tr = (key: string, params: Record<string, unknown> = {}): string => i18n.global.t(key, params)
const {
  vault, initStore, registerStorageSync,
  locked, hasEncryption, unlock, lock, enableEncryption, disableEncryption, changePassphrase,
  prfSources, addPrfSourceOp, removePrfSourceOp, replaceAllOp, settings,
} = store
const commitSettings = store.commitSettings

const icons = createIconStore(storageAdapter)

/**
 * 导入映射方案存取：直读写 storageAdapter 的 SCHEMES_KEY（跨端随 storage 同步）。
 * load 容错：坏 JSON/读失败 → 空表（core normalizeSchemes 兜底解析）。
 */
const schemesApi: ImportSchemesApi = {
  async load(): Promise<ImportScheme[]> {
    try {
      const raw = await storageAdapter.get(SCHEMES_KEY)
      return raw ? normalizeSchemes(JSON.parse(raw)) : []
    } catch {
      return []
    }
  },
  async save(list: ImportScheme[]): Promise<void> {
    await storageAdapter.set(SCHEMES_KEY, JSON.stringify(list))
  },
}

const loadError = ref('')
/** plan16 T13 迁移提示：本次挂载/解锁迁移了 N 个旧云目标时显示（幂等重跑=0 不再提示） */
const migrateNote = ref('')
/** 审查 I6：迁移被跳过/失败后旧键仍滞留 storage 时的 UI 提示（与 migrateNote 同层展示）。
 *  未启用加密的用户迁移链走不通（saveCred 需 DEK），若无此提示云目标会静默消失、无任何解释；
 *  下次运行成功迁移（旧键删除）后检测自然为 false，提示消失 */
const legacyNote = ref('')

/** 旧数据迁移编排（plan16 T13，幂等可重复跑）：vault.backupSecret → 保管区（store op）→
 *  旧云多目标键 → 源模型 + 保管区凭据。仅解锁态执行（保管区写入需 DEK）；未启用加密时
 *  saveCred 守护抛错 → 旧键保留（先写新后删旧），待启用加密后任一次重跑自愈。
 *  审查 I6：跳过/失败不以 console.warn 收场——旧键仍在则置 legacyNote 给用户可见的出口 */
async function runLegacyMigrations(): Promise<void> {
  if (store.locked.value) return
  try {
    await store.migrateLegacySecrets()
    const n = await migrateLegacySources(storageAdapter, { saveCred: store.saveSourceCredOp })
    if (n > 0) migrateNote.value = i18n.global.t('options.migrated', { count: n })
  } catch (e) {
    console.warn('[migrate] 旧数据迁移失败（旧键保留，解锁后重试）', e)
  }
  // 成功迁移后旧键已删 → 检测为 false 提示自然消失；仍滞留（跳过/失败）→ 提示置位
  legacyNote.value = (await hasLegacyCloudKeys(storageAdapter))
    ? i18n.global.t('options.legacyNote')
    : ''
}

onMounted(async () => {
  try {
    await initStore()
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(store)
    registerStorageSync()
    await icons.init()
    // 旧数据迁移（plan16 T13）：initStore 已含会话 DEK 自动恢复，解锁态在此直接跑（幂等）
    await runLegacyMigrations()
    // 自动云同步（页面存活期，勘误 §4.1）：读偏好填充缓存后启动调度器；initStore 失败（页面不可用）则不启动
    await refreshCloudAutoPrefs()
    scheduler.start()
    // 跟随拉取调度（跨端同步 T2）：解锁边沿 + 3min 轮询，gate 内查锁定态
    followScheduler.start()
    // idle/锁屏自动锁定（plan16 T12）：initStore 后启动（settings/加密态已就绪，watcher 内部自判 prefs）
    lockWatcher.start()
  } catch (e) {
    loadError.value = i18n.global.t('options.readError', { message: e instanceof Error ? e.message : String(e) })
  }
})

// 页面卸载即停：清防抖与定时器，stop 后在途 run 不再补跑（彻底静默）；锁定轮询同停
onUnmounted(() => {
  scheduler.stop()
  followScheduler.stop()
  lockWatcher.stop()
})

/**
 * 30s 清剪贴板：统一走 background(alarms+offscreen) 承载（与 popup 一致，重复复制由同名 alarm 覆盖重置）；
 * Firefox 无 offscreen API 降级不调度
 */
function scheduleClipboardClear(): void {
  if (!settings.clipboardClearEnabled) return
  if (typeof chrome === 'undefined' || !chrome.offscreen) return
  void chrome.runtime.sendMessage({ type: 'schedule-clipboard-clear', delayMs: CLIPBOARD_CLEAR_DELAY_MS }).catch(() => {})
}

async function copyToClipboard(code: string) {
  await navigator.clipboard.writeText(code)
  scheduleClipboardClear()
}

// ---------- 备份平台实现 ----------
// 文件命名偏好存扩展页 localStorage（非同步内容）：keep=时间戳文件名下载；overwrite=固定名下载。
// T9 后 BackupCard 已无模式切换（本地源归 desktop），本值仅决定 createBackup 的下载文件名（只读不再写）
const BACKUP_MODE_KEY = 'backupMode'
const BACKUP_KEEP_N_KEY = 'backupKeepN'
const DEFAULT_KEEP_N = 3

function loadBackupMode(): Retention {
  try {
    if (localStorage.getItem(BACKUP_MODE_KEY) === 'overwrite') return { type: 'overwrite' }
    const n = Number(localStorage.getItem(BACKUP_KEEP_N_KEY))
    return { type: 'keep', n: Number.isInteger(n) && n >= 1 ? n : DEFAULT_KEEP_N }
  } catch {
    return { type: 'keep', n: DEFAULT_KEEP_N }
  }
}

const backupMode = ref<Retention>(loadBackupMode())

function downloadEnvelope(envelope: BackupEnvelope, name: string): void {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 动态 input[type=file] 选择文件（accept 指定扩展名过滤）。
 * 取消：input cancel 事件（Chromium 113+）→ null；旧内核无 cancel 事件会永挂起 → 30s 超时 reject「文件选择超时」兜底
 * （选超时而非 window focus 监听：系统文件选择器的焦点恢复语义跨内核不一致，超时是无条件、最简可靠的兜底）。
 * input 挂到 body（部分内核 detached input 不触发文件框），结算后移除。
 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (f: File | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      input.remove()
      resolve(f)
    }
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      input.remove()
      reject(new Error('文件选择超时'))
    }, 30_000)
    input.onchange = () => finish(input.files?.[0] ?? null)
    input.oncancel = () => finish(null)
    document.body.appendChild(input)
    input.click()
  })
}

const pickBackupFile = (): Promise<File | null> => pickFile('.totpbackup')

// 最后一次导入选择的 File（模块级缓存）：SQLite 字节入口复用，避免同一文件二次弹窗
let lastImportFile: File | null = null

/** 安全平台：security 闭包绑 store；剪贴板/弹窗延迟走 settings+commitSettings（extension 有 popup，提供 popupCloseDelayMs）；
 *  passkey(PRF)：WebAuthn 交互（创建/求值）经 ui prf.ts，绑定落盘走 store 的 prf 源 op。
 *  plan16 T11 审查四项：changePassphrase opts 透传（漏接=档位切换误触发全库轮换）、kdfProfile、
 *  passwordChangedAt、lockPrefs——.vue 无 typecheck 对 platform 成员的覆盖，漏接无编译信号，全量接线。 */
const securityPlatform: SecurityPlatform = {
  security: {
    locked,
    hasEncryption,
    enableEncryption: (pw) => enableEncryption(pw),
    disableEncryption: () => disableEncryption(),
    changePassphrase: (pw, opts) => changePassphrase(pw, opts),
    kdfProfile: computed(() => store.securitySettings.value?.profile ?? 'balanced'),
    passwordChangedAt: computed(() => store.securitySettings.value?.passwordChangedAt ?? null),
    passkey: {
      sources: computed(() => prfSources.value.map((p) => ({ credentialId: p.credentialId }))),
      prfSupported: () => prfSupported(),
      async add() {
        // 绑定盐：注册期 create 与权威 get 均以该盐求值，解锁期用同一盐复现（同认证器+同盐→同输出）
        const salt = randomBytes(32)
        const created = await createPrfCredential('TOTP 验证码工具', salt, {
          excludeCredentialIds: prfSources.value.map((p) => p.credentialId),
        })
        if (!created) return false
        await addPrfSourceOp(created.credentialId, created.prfOutput, salt)
        return true
      },
      remove: (credentialId) => removePrfSourceOp(credentialId),
    },
  },
  clipboardClearEnabled: computed(() => settings.clipboardClearEnabled),
  async setClipboardClear(v) {
    settings.clipboardClearEnabled = v
    await commitSettings()
  },
  popupCloseDelayMs: computed(() => settings.popupCloseDelayMs),
  async setPopupCloseDelay(ms) {
    settings.popupCloseDelayMs = ms
    await commitSettings()
  },
  // 锁定策略（plan16 T11）：三字段整体覆写进 settings 后持久化（core loadSettings 已归一化）。
  // 审查 Minor：lockOnRestart 在 ext 无效果（DEK 存 chrome.storage.session，浏览器退出必清，
  // 两取值行为一致）——显式声明不支持，SecurityCard 隐藏「重启后保持锁定」控件防无效设置
  lockPrefs: {
    get: () => ({ lockOnRestart: settings.lockOnRestart, lockIdleMinutes: settings.lockIdleMinutes, lockOnSystemLock: settings.lockOnSystemLock }),
    set: (p) => {
      Object.assign(settings, p)
      void commitSettings()
    },
    unsupported: ['lockOnRestart'],
  },
}

/**
 * 浏览器同步平台：开关经 settings+commitSettings 持久化（写路径由 store 统一调度推送）；
 * 关闭时直写 local 区 sync:status='off'（engine 导出的 markSyncOff，免 background 往返）；
 * 状态读取直查 local 区 sync:status，形状不符/读取失败按无状态处理。
 */
const syncPlatform: SyncPlatform = {
  get syncEnabled() { return settings.syncEnabled },
  // 明文同步警示：SyncCard 据此在「开关开启且未启用加密」时提示（hasEncryption 直接暴露 ComputedRef<boolean>）
  hasEncryption,
  async setSyncEnabled(v) {
    settings.syncEnabled = v
    await commitSettings()
    if (!v) {
      await markSyncOff().catch(() => {})
      return
    }
    // 开启同步：主动调度一次拉取（开启开关只写 local settings，不触发 background 的 onChanged('sync')；
    // 缺这次拉取，新设备开启后若不写盘将永不应用远端较新数据）。SW 未就绪/上下文失效时忽略。
    try {
      void chrome.runtime.sendMessage({ type: 'sync-pull' }).catch(() => {})
    } catch { /* 扩展上下文失效（重载中）：忽略 */ }
  },
  async readStatus() {
    try {
      const raw = (await chrome.storage.local.get(SYNC_STATUS_KEY))[SYNC_STATUS_KEY]
      if (typeof raw !== 'object' || raw === null) return null
      const s = raw as { state?: unknown; at?: unknown }
      return typeof s.state === 'string' && typeof s.at === 'number' ? { state: s.state, at: s.at } : null
    } catch {
      return null
    }
  },
  canSync: typeof chrome !== 'undefined' && !!chrome.storage?.sync,
}

const backupPlatform: BackupPlatform = {
  async createBackup(vaultJson, password) {
    // plan16 T11.5：本地备份 envelope 按备份设置所选 KDF 档位生成（默认 balanced 兜底旧设置）
    const envelope = await createBackupEnvelope(vaultJson, password, settings.backupKdfProfile)
    const overwrite = backupMode.value.type === 'overwrite'
    const name = overwrite ? OVERWRITE_NAME : backupFileName(new Date())
    downloadEnvelope(envelope, name)
    // T9 后 BackupCard 直接展示宿主摘要：返回记录时语言文案（含文件名，诚实反映导出结果；D2 i18n）
    return overwrite
      ? i18n.global.t('options.exportedOverwrite', { name })
      : i18n.global.t('options.exported', { name })
  },
  async restoreFromPicker(password) {
    const file = await pickBackupFile()
    if (!file) return null
    return { json: await openBackupEnvelope(JSON.parse(await file.text()), password) }
  },
  replaceAllOp: (v) => replaceAllOp(v),
  // 导入：浏览器 input file 读取文本；无 DPAPI 能力，WinAuth DPAPI 条目由 core 逐条 failure「请用桌面版」
  async readImportFile() {
    const file = await pickFile('.json,.jsonl,.wauth,.txt,.aegis,.xml,.db,.sqlitedb,.sqlite,.zip')
    if (!file) return null
    lastImportFile = file
    return { text: await file.text(), name: file.name }
  },
  // SQLite 字节入口：文本管道会损坏二进制，复用最近一次选择的文件（File.arrayBuffer 原生读字节）；
  // 无最近选择时补弹选择器
  async readImportFileBytes() {
    const file = lastImportFile ?? (await pickFile('.db,.sqlitedb,.sqlite,.json,.jsonl,.txt,.xml,.wauth,.aegis,.zip'))
    if (!file) return null
    lastImportFile = file
    return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }
  },
  // 备份加密强度档位（plan16 T11.5）：settings 持久化（跨端随设置同步；extension 无本地源，仅影响 envelope 生成）
  backupKdfProfile: {
    get: () => settings.backupKdfProfile,
    set: (p) => {
      settings.backupKdfProfile = p
      void commitSettings()
    },
  },
  // 文本导出（批① §2.3）：otpauth 文本/Aegis JSON 走 Blob 下载（downloadEnvelope 同款 a[download] 通道）；浏览器下载无「取消」回执，恒 true
  async saveTextFile(name, content) {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return true
  },
  // 图片导出（批① §2.5 多选二维码拼版 PNG）：dataUrl 解 base64 → Blob 走同一 a[download] 通道；无「取消」回执，恒 true
  async saveImageFile(name, dataUrl) {
    const bytes = base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1))
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return true
  },
}

/**
 * 云同步平台实现（plan16 T13 源化口径）：源元数据明文存 backupSources 键（core loadSources/saveSources
 * 包装）；凭据是秘密存 DEK 保管区（store.saveSourceCredOp/removeSourceCredOp，解锁态限定，未解锁中文报错）；
 * 基线按源 id 存 sourceRevs（core loadSourceRevs/saveSourceRev）。旧 cloudCreds/cloudCred/cloudRevs/cloudRev
 * 四键由 migrateLegacySources 一次性迁移（见 runLegacyMigrations）。冲突副本经既有 Blob 下载通道；
 * 采用云端数据经 replaceAllOp 整体替换。
 */

// ---------- 自动云同步偏好（cloudAutoPrefs 键，storage.local 异步读写）----------
const CLOUD_AUTO_PREFS_KEY = 'cloudAutoPrefs'
const DEFAULT_CLOUD_AUTO_PREFS: CloudAutoPrefs = { onChange: false, onInterval: false, intervalMinutes: 60 }

/** 归一化（与 desktop loadCloudPrefs 同口径）：缺失位 false；间隔非法/<15 回退 60（匹配调度器 30s tick 粒度） */
function normalizeCloudAutoPrefs(parsed: unknown): CloudAutoPrefs {
  const p = (parsed ?? {}) as Partial<CloudAutoPrefs>
  const minutes = Number(p.intervalMinutes)
  return {
    onChange: p.onChange === true,
    onInterval: p.onInterval === true,
    intervalMinutes: Number.isInteger(minutes) && minutes >= 15 ? minutes : DEFAULT_CLOUD_AUTO_PREFS.intervalMinutes,
  }
}

/** 偏好进程内缓存：storage.local 异步读进不了同步 get()/intervalMs 回调——挂载时读一次、
 *  set 时双写；页面打开期间他端/跨页对 storage 的直改需待下次挂载才可见（容忍滞后，已知边界） */
let cloudAutoPrefs: CloudAutoPrefs = { ...DEFAULT_CLOUD_AUTO_PREFS }

async function refreshCloudAutoPrefs(): Promise<void> {
  try {
    const raw = await storageAdapter.get(CLOUD_AUTO_PREFS_KEY)
    if (raw) cloudAutoPrefs = normalizeCloudAutoPrefs(JSON.parse(raw))
  } catch { /* 坏 JSON/读取失败保持缓存现值 */ }
}

async function persistCloudAutoPrefs(p: CloudAutoPrefs): Promise<void> {
  cloudAutoPrefs = p // 先更缓存再异步落盘：guard/intervalMs 立即按新值生效
  await storageAdapter.set(CLOUD_AUTO_PREFS_KEY, JSON.stringify(p))
}

/** 存活期自动云同步 runner（D6，ui 共享实现，与 desktop 同一编排；plan16 T13 源口径）。
 *  跨端同步 T2：装配代码抽至 cloudRunnerFactory（popup/options 共用），差异仅 i18n t 注入；
 *  loadSources 装配「启用云源 × 保管区凭据」对（无凭据的源跳过——锁定态 credsCache 为空自然全跳过）；
 *  GDrive 首推凭据回存由 CloudCard 手动通道持有 */
const cloudSync = createExtensionCloudRunner({ store, t: tr })

/** 跟随拉取调度（跨端同步 T2）：解锁边沿 + 3min 轮询，经 syncScheduler gate（锁定态零网络）。
 *  与既有 cloudAutoPrefs 的 change/interval 通道相互独立（autoFollow 是跟随拉取的开关，勿混）；
 *  autoFollowEnabled 待 T3 接 settings.syncPrefs.autoFollow，暂恒 true */
const followScheduler = createSyncScheduler({
  isUnlocked: () => !locked.value,
  onUnlocked: (cb) => watch(locked, (v) => { if (!v) cb() }),
  runPull: () => cloudSync.run(),
  autoFollowEnabled: () => true,
  intervalMs: () => 180_000,
  onError: (e) => console.warn('[syncFollow]', e),
})

/** core 调度器（勘误 §4.1：不用 chrome.alarms——SW 后台无解锁 DEK、读不到会话备份口令，
 *  alarms 触发的同步无法加密；改为 options 页存活期运行，页面卸载即停）。
 *  guard 按 reason 双开关过滤；开关与间隔读进程内缓存（异步读进不了同步回调，滞后见上注释） */
const scheduler = createAutoRunScheduler({
  debounceMs: 10_000,
  intervalMs: () => (cloudAutoPrefs.onInterval ? cloudAutoPrefs.intervalMinutes * 60_000 : null),
  run: async (reason) => {
    if (reason === 'change' && !cloudAutoPrefs.onChange) return
    if (reason === 'interval' && !cloudAutoPrefs.onInterval) return
    await cloudSync.run()
  },
})

// ---------- idle/锁屏自动锁定（plan16 T12，设计 §1 锁定策略·extension 执行端）----------
/** 每 tick 现读 settings.lockPrefs（core loadSettings 已归一化）；加密未启用 → null 不动作。
 *  与 locked 无关：watcher 内部自判（锁定态 tick 无副作用）。store.lock() 已清 dekPersist（T7），
 *  watcher 只需调 lock 不自清 session。异常经 onError 上报不中断轮询 */
const lockWatcher = createIdleLockWatcher({
  getPrefs: async () => {
    if (!hasEncryption.value) return null
    return { idleMinutes: settings.lockIdleMinutes, lockOnSystemLock: settings.lockOnSystemLock }
  },
  lock: () => store.lock(),
  onError: (e) => console.warn('[lockWatcher]', e),
})

const cloudPlatform: CloudPlatform = {
  // ---- 源模型成员（plan16 T13）----
  loadSources: () => loadSourcesImpl(storageAdapter),
  saveSources: (list) => saveSourcesImpl(storageAdapter, list),
  saveCred: (id, cred) => store.saveSourceCredOp(id, cred),
  removeCred: (id) => store.removeSourceCredOp(id),
  // getter 形态：CloudCard 渲染/回调按 id 动态读取（p.creds[id]），锁定清空/解锁装载/保存后即时可见
  get creds() { return store.credsCache.value },
  readVaultJson: () => JSON.stringify(store.vault),
  async persistDownloaded(json) {
    await replaceAllOp(JSON.parse(json) as Vault)
  },
  // 冲突副本 Blob 下载：sourceId 仅用于文件名区分来源（迁移源 id=旧 backend 键，文件名与旧格式一致）
  saveConflictBackup: (bytes, sourceId) => downloadConflictBackup(bytes, sourceId),
  loadTargetHash: async (id) => (await loadSourceRevs(storageAdapter))[id] ?? null,
  saveTargetHash: (id, h) => saveSourceRev(storageAdapter, id, h),
  kdfProfile: () => settings.backupKdfProfile,
  autoPrefs: {
    get: () => cloudAutoPrefs,
    set: (p) => persistCloudAutoPrefs(p),
  },
  loadAutoStatus: async () => {
    try {
      // cloudAutoStatus 键原文 → 三态格式化纯函数（单测覆盖；审查 Minor-2 抽出）。
      // D2 R1：标签/分隔符展示时取词（cloudAuto.status*），summary 原文为记录时翻译不回填
      return formatAutoStatusText(await storageAdapter.get('cloudAutoStatus'), tr)
    } catch {
      return null
    }
  },
}
</script>

<template>
  <!-- 解锁成功回调补跑迁移（plan16 T13，幂等）：口令/PRF 解锁各路径在 LockScreen 内 emit unlocked -->
  <LockScreen v-if="locked" :store="store" @unlocked="runLegacyMigrations" />
  <template v-else>
    <div v-if="loadError" class="error">{{ loadError }}</div>
    <template v-else>
      <!-- 迁移提示与主体并列（非互斥）：一次性提示，下次挂载重跑迁移=0 后不再出现；
           legacyNote（审查 I6）：迁移跳过/失败且旧键仍在时提示，成功迁移后消失 -->
      <div v-if="migrateNote" class="migrate-note">{{ migrateNote }}</div>
      <div v-if="legacyNote" class="migrate-note">{{ legacyNote }}</div>
      <!-- 同构五页:与桌面同一 Shell(无 railActions → 设置页不渲染桌面专属项;传 syncPlatform → 渲染扩展专属项) -->
      <NavigationShell :store="store" :platform="backupPlatform" :security-platform="securityPlatform" :sync-platform="syncPlatform" :cloud-platform="cloudPlatform" :icons="icons" :schemes-api="schemesApi" @copy="copyToClipboard" />
    </template>
  </template>
</template>

<style>
/* body 级样式须在非 scoped 块：scoped 会编译为 body[data-v-x] 永不匹配（审查 Minor），
   与 desktop App.vue 同做法 */
body { font-family: system-ui, sans-serif; margin: 0; }
</style>
<style scoped>
.error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); padding: 16px; }
.migrate-note { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-small); padding: 8px 16px; }
</style>
