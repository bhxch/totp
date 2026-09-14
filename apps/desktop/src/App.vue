<script setup lang="ts">
import { getCurrentWindow } from '@tauri-apps/api/window'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open, save } from '@tauri-apps/plugin-dialog'
import { backupFileName, createBackupEnvelope, openBackupEnvelope } from '@totp/core'
import { LockScreen, VaultManager, createClipboardClearer, createIconStore, createVueStore, type BackupMode, type BackupPlatform, type IconStore, type SecurityPlatform, type VueStore } from '@totp/ui'
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { createBackupToDir, listBackups, readBackupByName, readBackupFileOs, writeBackupFileOs } from './backupService'
import { decryptDpapiOs, readImportFileOs } from './importService'
import { createTauriFs } from './tauriFs'

const store = ref<VueStore | null>(null)
const icons = ref<IconStore | null>(null)
const loadError = ref('')
let unlistenFocus: (() => void) | null = null

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

/** envelope 文本 → 解密出明文 vault JSON（口令错误/文件损坏由 openBackupEnvelope 抛错，卡片统一展示） */
async function openBackupText(text: string, password: string): Promise<string> {
  return openBackupEnvelope(JSON.parse(text), password)
}

const BACKUP_FILE_FILTERS = [{ name: 'TOTP 备份', extensions: ['totpbackup'] }]
// 与 Rust 端 read_import_file_os 扩展名白名单一致（.json/.wauth/.xml/.txt/.aegis）
const IMPORT_FILE_FILTERS = [{ name: '导入文件', extensions: ['json', 'wauth', 'txt', 'aegis', 'xml'] }]

const backupPlatform: BackupPlatform = {
  get mode() { return backupMode.value },
  async setMode(m) {
    backupMode.value = m
    persistBackupMode(m)
  },
  createBackup: (vaultJson, password) => createBackupToDir(vaultJson, password, backupMode.value),
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
  listBackups: () => listBackups(),
  async restoreByName(name, password) {
    return { json: await openBackupText(await readBackupByName(name), password) }
  },
  async replaceAllOp(v) {
    const s = store.value
    if (!s) throw new Error('数据尚未就绪')
    await s.replaceAllOp(v)
  },
  async readImportFile() {
    const path = await open({ multiple: false, directory: false, filters: IMPORT_FILE_FILTERS })
    if (typeof path !== 'string') return null
    return { text: await readImportFileOs(path), name: path.split(/[\\/]/).pop() ?? path }
  },
  decryptDpapi: (b64) => decryptDpapiOs(b64),
}

/** 安全平台：security 闭包绑 store；剪贴板开关走 settings+commitSettings；desktop 无 popup，不提供 popupCloseDelayMs */
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
    },
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
    const s = createVueStore(adapter)
    await s.initStore()
    store.value = s
    const iconStore = createIconStore(adapter)
    await iconStore.init()
    icons.value = iconStore
  } catch (e) {
    loadError.value = '本地数据初始化失败：' + (e instanceof Error ? e.message : String(e))
  }
})

onScopeDispose(() => unlistenFocus?.())

/** 30s 清剪贴板：settings.clipboardClearEnabled 开启时复制后定时清空（重复复制重置计时；setup 作用域销毁自动 dispose；store 未就绪时读不到开关视为关闭） */
const clearer = createClipboardClearer(
  () => store.value?.settings.clipboardClearEnabled === true,
  () => writeText(''),
)

async function copyToClipboard(code: string) {
  await writeText(code)
  clearer.notifyCopied()
}

async function onBlurHideChange(e: Event) {
  const s = store.value
  if (!s) return
  s.settings.blurHideEnabled = (e.target as HTMLInputElement).checked
  await s.commitSettings()
}
</script>

<template>
  <main class="page">
    <header>
      <h1>TOTP 验证码工具</h1>
      <div class="header-ops">
        <label class="blur-hide"><input type="checkbox" :checked="store?.settings.blurHideEnabled" @change="onBlurHideChange" /> 失焦自动隐藏</label>
        <button @click="getCurrentWindow().hide()">隐藏到托盘</button>
      </div>
    </header>
    <div v-if="loadError && !store" class="error">{{ loadError }}</div>
    <LockScreen v-else-if="store && store.locked" :store="store" />
    <VaultManager v-else-if="store" :store="store" :platform="backupPlatform" :security-platform="securityPlatform" :icons="icons ?? undefined" enable-copy @copy="copyToClipboard" />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.page { max-width: 720px; margin: 0 auto; padding: 16px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
h1 { font-size: 20px; margin: 0; }
.header-ops { display: flex; align-items: center; gap: 12px; }
.blur-hide { font-size: 13px; display: flex; align-items: center; gap: 4px; cursor: pointer; }
.error { color: #d9534f; }
</style>
