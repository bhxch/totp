<script setup lang="ts">
import { backupFileName, createAutoRunScheduler, createBackupEnvelope, openBackupEnvelope, normalizeSchemes, OVERWRITE_NAME, randomBytes, SCHEMES_KEY, type BackupEnvelopeV1, type ImportScheme, type Vault } from '@totp/core'
import { CLIPBOARD_CLEAR_DELAY_MS, createCloudBackend, createCloudSyncRunner, createIconStore, createPrfCredential, LockScreen, NavigationShell, prfSupported, useTheme, type BackupMode, type BackupPlatform, type CloudAutoPrefs, type CloudPlatform, type ImportSchemesApi, type SecurityPlatform, type SyncPlatform } from '@totp/ui'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { createCloudCredStore, conflictBackupName, formatAutoStatusText } from '../../src/cloudCredStore'
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

onMounted(async () => {
  try {
    await initStore()
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(store)
    registerStorageSync()
    await icons.init()
    // 自动云同步（页面存活期，勘误 §4.1）：读偏好填充缓存后启动调度器；initStore 失败（页面不可用）则不启动
    await refreshCloudAutoPrefs()
    scheduler.start()
    // idle/锁屏自动锁定（plan16 T12）：initStore 后启动（settings/加密态已就绪，watcher 内部自判 prefs）
    lockWatcher.start()
  } catch (e) {
    loadError.value = '本地数据读取失败：' + (e instanceof Error ? e.message : String(e))
  }
})

// 页面卸载即停：清防抖与定时器，stop 后在途 run 不再补跑（彻底静默）；锁定轮询同停
onUnmounted(() => {
  scheduler.stop()
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
// 模式偏好存扩展页 localStorage（非同步内容）：keep=时间戳文件名下载；overwrite=固定名下载
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

function downloadEnvelope(envelope: BackupEnvelopeV1, name: string): void {
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
 *  passkey(PRF)：WebAuthn 交互（创建/求值）经 ui prf.ts，绑定落盘走 store 的 prf 源 op */
const securityPlatform: SecurityPlatform = {
  security: {
    locked,
    hasEncryption,
    enableEncryption: (pw) => enableEncryption(pw),
    disableEncryption: () => disableEncryption(),
    changePassphrase: (pw) => changePassphrase(pw),
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
  get mode() { return backupMode.value },
  async setMode(m) {
    backupMode.value = m
    persistBackupMode(m)
  },
  async createBackup(vaultJson, password) {
    const envelope = await createBackupEnvelope(vaultJson, password)
    const name = backupMode.value.type === 'overwrite' ? OVERWRITE_NAME : backupFileName(new Date())
    downloadEnvelope(envelope, name)
    return backupMode.value.type === 'overwrite' ? 'overwritten' : 'created'
  },
  async restoreFromPicker(password) {
    const file = await pickBackupFile()
    if (!file) return null
    return { json: await openBackupEnvelope(JSON.parse(await file.text()), password) }
  },
  replaceAllOp: (v) => replaceAllOp(v),
  // 导入：浏览器 input file 读取文本；无 DPAPI 能力，WinAuth DPAPI 条目由 core 逐条 failure「请用桌面版」
  async readImportFile() {
    const file = await pickFile('.json,.jsonl,.wauth,.txt,.aegis,.xml,.db,.sqlitedb,.sqlite')
    if (!file) return null
    lastImportFile = file
    return { text: await file.text(), name: file.name }
  },
  // SQLite 字节入口：文本管道会损坏二进制，复用最近一次选择的文件（File.arrayBuffer 原生读字节）；
  // 无最近选择时补弹选择器
  async readImportFileBytes() {
    const file = lastImportFile ?? (await pickFile('.db,.sqlitedb,.sqlite,.json,.jsonl,.txt,.xml,.wauth,.aegis'))
    if (!file) return null
    lastImportFile = file
    return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }
  },
}

/**
 * 云同步平台实现：凭据与基线存 local 区（storage.local 键，不进浏览器同步）。
 * 多目标迁移约定（Task 8，见 ui cloudPlatform.ts 注释块）：多目标读写委托 cloudCredStore
 * （新键 cloudCreds/cloudRevs，旧键 cloudCred/cloudRev 只读回退、保存后删除，绝不回写新键）；
 * 冲突副本经既有 Blob 下载通道；采用云端数据经 replaceAllOp 整体替换。
 * Task 13：旧单目标四成员已删，卡内口令改由 sessionSecret 注入。
 */
const cloudCredStore = createCloudCredStore(storageAdapter)

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

/** 冲突副本 Blob 下载：命名经 conflictBackupName（与 desktop 同构，带 backendKey 时
 *  conflict-{backendKey}-{yyyyMMdd-HHmmss}.totpbackup，匹配 READABLE_BACKUP_RE 可恢复） */
async function downloadConflictBackup(bytes: Uint8Array, backendKey?: string): Promise<string> {
  const name = conflictBackupName(backendKey, new Date)
  const blob = new Blob([bytes as BlobPart], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return name
}

/** 存活期自动云同步 runner（D6，ui 共享实现，与 desktop 同一编排）：
 *  onCredChange（GDrive 首推回存 fileId 等）以新凭据替换同 backend 项后回存；
 *  loadCreds 返回空（IO/坏 JSON 瞬时失败）时跳过回写，防把空列表固化为凭据存储（同 desktop 审查 M-1） */
const cloudSync = createCloudSyncRunner({
  isLocked: () => store.locked.value,
  getSecret: () => store.backupSecret.value,
  getVaultJson: () => JSON.stringify(store.vault),
  loadCreds: () => cloudCredStore.loadCreds(),
  loadTargetHash: (b) => cloudCredStore.loadTargetHash(b),
  saveTargetHash: (b, h) => cloudCredStore.saveTargetHash(b, h),
  makeBackend: (cred) => createCloudBackend(cred, (next) => {
    void cloudCredStore.loadCreds()
      .then((targets) => {
        if (targets.length === 0) return
        return cloudCredStore.saveCreds(targets.map((t) => (t.cred.backend === next.backend ? { ...t, cred: next } : t)))
      })
      .catch((e) => console.warn('[cloudAutoSync] 凭据回存失败', e))
  }),
  persistAdopted: (json) => replaceAllOp(JSON.parse(json) as Vault),
  saveConflictBackup: (key, bytes) => {
    void downloadConflictBackup(bytes, key).catch(() => {})
  },
  // 状态记录不 await：storage 写失败不影响同步主流程。ok 三态（批 4）：true/false/null（跳过）
  recordStatus: (ok: boolean | null, summary) => {
    void storageAdapter.set('cloudAutoStatus', JSON.stringify({ at: Date.now(), ok, summary })).catch(() => {})
  },
  onError: (err) => console.warn('[cloudAutoSync]', err),
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
  readVaultJson: () => JSON.stringify(store.vault),
  async persistDownloaded(json) {
    await replaceAllOp(JSON.parse(json) as Vault)
  },
  saveConflictBackup: (bytes, backendKey) => downloadConflictBackup(bytes, backendKey),
  // ---- 多目标成员（Task 12；Task 13 起旧单目标四成员已删）----
  loadCreds: () => cloudCredStore.loadCreds(),
  saveCreds: (t) => cloudCredStore.saveCreds(t),
  loadTargetHash: (b) => cloudCredStore.loadTargetHash(b),
  saveTargetHash: (b, h) => cloudCredStore.saveTargetHash(b, h),
  autoPrefs: {
    get: () => cloudAutoPrefs,
    set: (p) => persistCloudAutoPrefs(p),
  },
  loadAutoStatus: async () => {
    try {
      // cloudAutoStatus 键原文 → 三态格式化纯函数（单测覆盖；审查 Minor-2 抽出）
      return formatAutoStatusText(await storageAdapter.get('cloudAutoStatus'))
    } catch {
      return null
    }
  },
}
</script>

<template>
  <LockScreen v-if="locked" :store="store" />
  <template v-else>
    <div v-if="loadError" class="error">{{ loadError }}</div>
    <!-- 同构五页:与桌面同一 Shell(无 railActions → 设置页不渲染桌面专属项;传 syncPlatform → 渲染扩展专属项) -->
    <NavigationShell v-else :store="store" :platform="backupPlatform" :security-platform="securityPlatform" :sync-platform="syncPlatform" :cloud-platform="cloudPlatform" :icons="icons" :schemes-api="schemesApi" @copy="copyToClipboard" />
  </template>
</template>

<style scoped>
body { font-family: system-ui, sans-serif; margin: 0; }
.error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); padding: 16px; }
</style>
