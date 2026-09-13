<script setup lang="ts">
import { backupFileName, createBackupEnvelope, openBackupEnvelope, OVERWRITE_NAME, type BackupEnvelopeV1 } from '@totp/core'
import { VaultManager, type BackupMode, type BackupPlatform } from '@totp/ui'
import { onMounted, ref } from 'vue'
import { initStore, registerStorageSync, replaceAllOp, store } from '../../src/store'

const loadError = ref('')

onMounted(async () => {
  try {
    await initStore()
    registerStorageSync()
  } catch (e) {
    loadError.value = '本地数据读取失败：' + (e instanceof Error ? e.message : String(e))
  }
})

async function copyToClipboard(code: string) {
  await navigator.clipboard.writeText(code)
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
 * 动态 input[type=file] 选择备份文件。
 * 取消：input cancel 事件（Chromium 113+）→ null；旧内核无 cancel 事件会永挂起 → 30s 超时 reject「文件选择超时」兜底
 * （选超时而非 window focus 监听：系统文件选择器的焦点恢复语义跨内核不一致，超时是无条件、最简可靠的兜底）。
 * input 挂到 body（部分内核 detached input 不触发文件框），结算后移除。
 */
function pickBackupFile(): Promise<File | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.totpbackup'
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
}
</script>

<template>
  <main class="page">
    <h1>TOTP 验证码工具</h1>
    <div v-if="loadError" class="error">{{ loadError }}</div>
    <VaultManager v-else :store="store" :platform="backupPlatform" enable-copy @copy="copyToClipboard" />
  </main>
</template>

<style scoped>
body { font-family: system-ui, sans-serif; }
.page { max-width: 640px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
h1 { font-size: 20px; }
.error { color: #d9534f; font-size: 12px; }
</style>
