<script setup lang="ts">
import type { CloudCred } from '@totp/core'
import { computed, onMounted, reactive, ref } from 'vue'
import { CLOUD_BACKUP_PATH, createCloudBackend } from './cloudPlatform'
import type { CloudPlatform } from './cloudPlatform'
import { parseVaultJson } from './parseVaultJson'
import { syncWithCloud } from '@totp/core'

const props = defineProps<{
  /** 云同步平台实现；null 时整卡不渲染（popup 不受影响） */
  platform: CloudPlatform | null
}>()

const backendSel = ref<CloudCred['backend']>('webdav')
/** 动态凭据字段（按 backendSel 取用；gdrive/onedrive 共用 accessToken 字段） */
const f = reactive({
  serverUrl: '', username: '', password: '',
  region: '', bucket: '', accessKeyId: '', secretAccessKey: '', endpoint: '', prefix: '', sessionToken: '',
  forcePathStyle: false,
  token: '', gistId: '',
  accessToken: '',
})
/** GDrive 首推自动建文件回存的 fileId（无表单字段，随凭据保存/重建） */
const gdriveFileId = ref('')

const password = ref('')
const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err'>('ok')

/** 已解密待确认覆盖的远端 vault JSON（两步确认防误覆盖，复用 BackupCard 恢复语义） */
const pending = ref<string | null>(null)
const pendingAction = ref<'downloaded' | 'conflict-resolved'>('downloaded')
const conflictName = ref('')
let lastHash = ''

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

const pendingText = computed(() => {
  const copy = conflictName.value ? `（本地冲突副本：${conflictName.value}）` : ''
  return `云端数据与本地不同，已保留本地冲突副本${copy}——确认后将采用云端数据覆盖当前全部条目`
})

/** 表单字段 → CloudCred；当前后端必填字段缺失时抛中文错误 */
function buildCred(): CloudCred {
  const req = (...vals: string[]) => {
    if (vals.some((v) => !v)) throw new Error('请完整填写当前后端的凭据字段')
  }
  switch (backendSel.value) {
    case 'webdav':
      req(f.serverUrl, f.username, f.password)
      return { backend: 'webdav', serverUrl: f.serverUrl, username: f.username, password: f.password }
    case 's3':
      req(f.region, f.bucket, f.accessKeyId, f.secretAccessKey)
      return {
        backend: 's3', region: f.region, bucket: f.bucket, accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey,
        ...(f.endpoint ? { endpoint: f.endpoint } : {}),
        ...(f.prefix ? { prefix: f.prefix } : {}),
        ...(f.sessionToken ? { sessionToken: f.sessionToken } : {}),
        ...(f.forcePathStyle ? { forcePathStyle: true } : {}),
      }
    case 'gist':
      req(f.token, f.gistId)
      return { backend: 'gist', token: f.token, gistId: f.gistId }
    case 'gdrive':
      req(f.accessToken)
      return { backend: 'gdrive', accessToken: f.accessToken, ...(gdriveFileId.value ? { fileId: gdriveFileId.value } : {}) }
    case 'onedrive':
      req(f.accessToken)
      return { backend: 'onedrive', accessToken: f.accessToken }
  }
}

/** 已存凭据 → 表单回填 */
function applyCred(c: CloudCred): void {
  backendSel.value = c.backend
  if (c.backend === 'webdav') {
    f.serverUrl = c.serverUrl; f.username = c.username; f.password = c.password
  } else if (c.backend === 's3') {
    f.region = c.region; f.bucket = c.bucket; f.accessKeyId = c.accessKeyId; f.secretAccessKey = c.secretAccessKey
    f.endpoint = c.endpoint ?? ''; f.prefix = c.prefix ?? ''
    f.sessionToken = c.sessionToken ?? ''
    f.forcePathStyle = !!c.forcePathStyle
  } else if (c.backend === 'gist') {
    f.token = c.token; f.gistId = c.gistId
  } else if (c.backend === 'gdrive') {
    f.accessToken = c.accessToken; gdriveFileId.value = c.fileId ?? ''
  } else {
    f.accessToken = c.accessToken
  }
}

onMounted(() => {
  props.platform?.loadCred().then((c) => { if (c) applyCred(c) }).catch(() => { /* 回填失败按未存凭据处理 */ })
})

async function onSaveCred(): Promise<void> {
  const p = props.platform
  if (!p) return
  let cred: CloudCred
  try {
    cred = buildCred()
  } catch (e) {
    return fail(e)
  }
  try {
    await p.saveCred(cred)
    msg.value = '凭据已保存'
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  }
}

/** cloudRev 持久化失败不影响本次同步结果 */
async function storeHash(hash: string): Promise<void> {
  try {
    await props.platform?.saveHash?.(hash)
  } catch { /* 忽略 */ }
}

async function onSync(): Promise<void> {
  const p = props.platform
  if (!p) return
  if (!password.value) return fail(new Error('请输入口令'))
  let cred: CloudCred
  try {
    cred = buildCred()
  } catch (e) {
    return fail(e)
  }
  busy.value = true
  msg.value = ''
  try {
    const localHash = p.loadHash ? await p.loadHash() : null
    const backend = createCloudBackend(cred, (c) => {
      // GDrive 首推自动建文件：回存 fileId 到会话状态与持久凭据
      gdriveFileId.value = c.backend === 'gdrive' ? c.fileId ?? '' : ''
      void p.saveCred(c).catch((e) => console.warn('[CloudCard] 凭据回存失败（fileId 未持久化）:', e))
    })
    const out = await syncWithCloud({
      backend,
      path: CLOUD_BACKUP_PATH,
      vaultJson: p.readVaultJson(),
      password: password.value,
      localHash,
      onConflictBackup: p.saveConflictBackup ? (bytes) => p.saveConflictBackup!(bytes) : undefined,
    })
    lastHash = out.hash
    if (out.action === 'uploaded') {
      await storeHash(out.hash)
      msg.value = '已上传'
      msgKind.value = 'ok'
    } else if (out.action === 'in-sync') {
      msg.value = '云端已是最新'
      msgKind.value = 'ok'
    } else {
      // downloaded / conflict-resolved：envelopeJson 为远端 vault JSON（明文）
      parseVaultJson(out.envelopeJson!) // 远端内容先过恢复校验，不合格不进入确认流程
      pendingAction.value = out.action
      conflictName.value = out.conflictBackup ?? ''
      pending.value = out.envelopeJson!
    }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 确认覆盖：整体替换本地存储（replaceAllOp 链路），成功后记录 cloudRev */
async function onConfirmAdopt(): Promise<void> {
  const p = props.platform
  const json = pending.value
  if (!p || !json) return
  busy.value = true
  try {
    await p.persistDownloaded(json)
    await storeHash(lastHash)
    pending.value = null
    msg.value = pendingAction.value === 'conflict-resolved'
      ? (conflictName.value ? `检测到冲突：已保留本地副本并采用云端（副本：${conflictName.value}）` : '检测到冲突：已保留本地副本并采用云端')
      : '已应用云端备份'
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="platform" class="card cloud">
    <h2>云同步</h2>
    <select v-model="backendSel" class="cloud-backend" :disabled="busy">
      <option value="webdav">WebDAV</option>
      <option value="s3">S3</option>
      <option value="gdrive">Google Drive</option>
      <option value="onedrive">OneDrive</option>
      <option value="gist">GitHub Gist</option>
    </select>
    <div v-if="backendSel === 'webdav'" class="fields">
      <input v-model.trim="f.serverUrl" placeholder="服务器地址（https://dav.example.com）" autocomplete="off" />
      <input v-model.trim="f.username" placeholder="用户名" autocomplete="off" />
      <input v-model="f.password" type="password" placeholder="应用密码" autocomplete="new-password" />
    </div>
    <div v-else-if="backendSel === 's3'" class="fields">
      <input v-model.trim="f.region" placeholder="Region（如 us-east-1）" autocomplete="off" />
      <input v-model.trim="f.bucket" placeholder="Bucket" autocomplete="off" />
      <input v-model.trim="f.accessKeyId" placeholder="AccessKeyId" autocomplete="off" />
      <input v-model="f.secretAccessKey" type="password" placeholder="SecretAccessKey" autocomplete="new-password" />
      <input v-model="f.sessionToken" type="password" placeholder="STS SessionToken（可选）" autocomplete="new-password" />
      <input v-model.trim="f.endpoint" placeholder="Endpoint（可选，如 http://localhost:9000）" autocomplete="off" />
      <input v-model.trim="f.prefix" placeholder="Key 前缀（可选）" autocomplete="off" />
      <label class="opt"><input type="checkbox" v-model="f.forcePathStyle" :disabled="busy" /> 强制 path-style（兼容老 bucket / 自建 S3）</label>
    </div>
    <div v-else-if="backendSel === 'gdrive'" class="fields">
      <input v-model.trim="f.accessToken" type="password" placeholder="Access Token（Google OAuth）" autocomplete="new-password" />
    </div>
    <div v-else-if="backendSel === 'onedrive'" class="fields">
      <input v-model.trim="f.accessToken" type="password" placeholder="Access Token（Microsoft Graph）" autocomplete="new-password" />
    </div>
    <div v-else class="fields">
      <input v-model.trim="f.token" type="password" placeholder="GitHub Token" autocomplete="new-password" />
      <input v-model.trim="f.gistId" placeholder="Gist ID" autocomplete="off" />
    </div>
    <div class="actions">
      <button class="save-cred" :disabled="busy" @click="onSaveCred">保存凭据</button>
      <input v-model="password" type="password" class="cloud-pw" placeholder="同步口令" autocomplete="new-password" :disabled="busy" />
      <button class="sync-now" :disabled="busy || pending !== null" @click="onSync">立即同步</button>
    </div>
    <p class="hint">同步口令即备份加密口令，云端对象为加密 envelope；口令不保存。</p>
    <div v-if="pending" class="confirm-row">
      <span>{{ pendingText }}</span>
      <button class="danger" :disabled="busy" @click="onConfirmAdopt">确认覆盖</button>
      <button :disabled="busy" @click="pending = null">取消</button>
    </div>
    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
.card { border: 1px solid rgba(128,128,128,.4); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: 15px; margin: 0; }
.cloud-backend { align-self: flex-start; }
.fields { display: flex; flex-direction: column; gap: 6px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.cloud-pw { flex: 1; min-width: 120px; }
.confirm-row { display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
.danger { color: #d9534f; }
.hint { font-size: 12px; opacity: .65; margin: 0; }
.ok { color: #2e7d32; font-size: 13px; }
.err { color: #d9534f; font-size: 13px; }
</style>
