<script setup lang="ts">
import { backupFileName, conflictBackupFileName, createBackupEnvelope, openBackupEnvelope, normalizeSchemes, OVERWRITE_NAME, randomBytes, SCHEMES_KEY, type BackupEnvelopeV1, type CloudCred, type ImportScheme, type Vault } from '@totp/core'
import { CLIPBOARD_CLEAR_DELAY_MS, createIconStore, createPrfCredential, LockScreen, prfSupported, useTheme, VaultManager, type BackupMode, type BackupPlatform, type CloudPlatform, type ImportSchemesApi, type SecurityPlatform, type SyncPlatform } from '@totp/ui'
import { computed, onMounted, ref } from 'vue'
import { createExtensionStore, storageAdapter } from '../../src/store'
import { markSyncOff, SYNC_STATUS_KEY } from '../../src/syncEngine'

// spec §7 末尾：options 窗口独立解锁——windowId='options' 与 popup 隔离，各持各的 DEK
const store = createExtensionStore('options')
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
  } catch (e) {
    loadError.value = '本地数据读取失败：' + (e instanceof Error ? e.message : String(e))
  }
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
 * 云同步平台实现：凭据与 cloudRev 存 local 区（cloudCred/cloudRev 键，不进浏览器同步）；
 * 冲突副本与备份同通道 Blob 下载 conflict-{ts}.totpbackup；采用云端数据经 replaceAllOp 整体替换。
 */
const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_REV_KEY = 'cloudRev'

const cloudPlatform: CloudPlatform = {
  async loadCred() {
    try {
      const raw = await storageAdapter.get(CLOUD_CRED_KEY)
      return raw ? (JSON.parse(raw) as CloudCred) : null
    } catch {
      return null
    }
  },
  async saveCred(c) {
    await storageAdapter.set(CLOUD_CRED_KEY, JSON.stringify(c))
  },
  readVaultJson: () => JSON.stringify(store.vault),
  async persistDownloaded(json) {
    await replaceAllOp(JSON.parse(json) as Vault)
  },
  async saveConflictBackup(bytes) {
    const name = conflictBackupFileName(new Date())
    const blob = new Blob([bytes as BlobPart], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return name
  },
  async loadHash() {
    try {
      return await storageAdapter.get(CLOUD_REV_KEY)
    } catch {
      return null
    }
  },
  async saveHash(hash) {
    await storageAdapter.set(CLOUD_REV_KEY, hash)
  },
}
</script>

<template>
  <main class="page">
    <h1>TOTP 验证码工具</h1>
    <LockScreen v-if="locked" :store="store" />
    <template v-else>
      <div v-if="loadError" class="error">{{ loadError }}</div>
      <VaultManager v-else :store="store" :platform="backupPlatform" :security-platform="securityPlatform" :sync-platform="syncPlatform" :cloud-platform="cloudPlatform" :icons="icons" :schemes-api="schemesApi" enable-copy @copy="copyToClipboard" />
    </template>
  </main>
</template>

<style scoped>
body { font-family: system-ui, sans-serif; }
.page { max-width: 640px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
h1 { font-size: 20px; }
.error { color: #d9534f; font-size: 12px; }
</style>
