<script setup lang="ts">
import type { CloudCred } from '@totp/core'
import { DEFAULT_OBJECT_PATH, pushEnvelope, resolveObjectPath, syncMultipleTargets } from '@totp/core'
import { computed, onMounted, ref } from 'vue'
import { createCloudBackend } from './cloudPlatform'
import type { CloudAutoPrefs, CloudPlatform, CloudTarget } from './cloudPlatform'
import { parseVaultJson } from './parseVaultJson'
import MdButton from './md/MdButton.vue'
import MdCheckbox from './md/MdCheckbox.vue'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{
  /** 云同步平台实现；null 时整卡不渲染（popup 不受影响） */
  platform: CloudPlatform | null
  /** 会话备份口令（D1，即备份加密口令）；null 时同步禁用并提示先设置备份口令 */
  sessionSecret: string | null
}>()

const BACKENDS = ['webdav', 's3', 'gist', 'gdrive', 'onedrive'] as const
type BackendId = (typeof BACKENDS)[number]
const BACKEND_LABEL: Record<BackendId, string> = {
  webdav: 'WebDAV', s3: 'S3', gist: 'GitHub Gist', gdrive: 'Google Drive', onedrive: 'OneDrive',
}
/** 任意 backend 键的显示名（未知键原样返回；重置确认文案用） */
function backendLabel(b: string): string {
  return BACKEND_LABEL[b as BackendId] ?? b
}

/** 多目标列表（挂载时 loadCreds 回填；卡内编辑=内存副本，「保存凭据」才落盘） */
const targets = ref<CloudTarget[]>([])
/** 当前展开配置的目标索引（-1=全部收起；同时只展开一个） */
const expanded = ref(-1)

const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')

/** 各目标最近一次手动同步结果文本（键=backend） */
const statusMap = ref<Record<string, string>>({})
function statusFor(backend: string): string {
  return statusMap.value[backend] ?? ''
}

/** 已解密待确认覆盖的远端 vault JSON（两步确认防误覆盖，沿用旧卡行内确认交互） */
const pendingAdopt = ref<string | null>(null)
/** 采纳目标待确认的基线 hash：「采用云端」确认成功后才落盘；取消则不写（下次同步重新下载提示） */
const pendingHashes = ref<Array<[string, string]>>([])

/** 同步报「口令不匹配」的目标 backend 键（换口令后云端为旧口令信封）：提供行内重置救济入口 */
const resettableBackends = ref<string[]>([])
/** 待确认重置的 backend 键（行内两步确认，同 pendingAdopt 模式；挂起期间同步按钮禁用） */
const pendingReset = ref<string | null>(null)

/** 自动触发偏好（卡内编辑副本，挂载时读初值；每次变更整体回写） */
const autoPrefs = ref<CloudAutoPrefs>({ onChange: false, onInterval: false, intervalMinutes: 60 })
/** 「上次自动同步」状态文本（宿主 loadAutoStatus 提供；缺省显示「暂无」） */
const autoStatus = ref<string | null>(null)

/** 尚未添加的目标后端（同后端仅一份凭据，已存在的不重复添加） */
const addableBackends = computed(() => BACKENDS.filter((b) => !targets.value.some((t) => t.cred.backend === b)))
const nextBackend = computed(() => addableBackends.value[0])

/** 空白凭据工厂：按 backend 给最小必选字段空串（可选字段不设键，与保存语义一致） */
function blankCred(b: BackendId): CloudCred {
  switch (b) {
    case 'webdav': return { backend: 'webdav', serverUrl: '', username: '', password: '' }
    case 's3': return { backend: 's3', region: '', bucket: '', accessKeyId: '', secretAccessKey: '' }
    case 'gist': return { backend: 'gist', token: '', gistId: '' }
    case 'gdrive': return { backend: 'gdrive', accessToken: '' }
    case 'onedrive': return { backend: 'onedrive', accessToken: '' }
  }
}

/** 添加目标：push 空白凭据（enabled 默认开）并展开其配置 */
function addTarget(b: BackendId): void {
  targets.value.push({ cred: blankCred(b), enabled: true })
  expanded.value = targets.value.length - 1
}

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

onMounted(async () => {
  const p = props.platform
  if (!p) return
  try {
    targets.value = await p.loadCreds()
  } catch {
    targets.value = [] // 回填失败按未存凭据处理
  }
  if (p.autoPrefs) {
    try {
      autoPrefs.value = { ...(await p.autoPrefs.get()) } // await 兼容同步返回（desktop）
    } catch { /* 读取失败保持默认 */ }
  }
  if (p.loadAutoStatus) {
    try {
      autoStatus.value = await p.loadAutoStatus()
    } catch {
      autoStatus.value = null
    }
  }
})

/** 保存凭据：整列表落盘；未保存的编辑仅存于卡内内存副本 */
async function onSaveCreds(): Promise<void> {
  const p = props.platform
  if (!p) return
  try {
    await p.saveCreds(targets.value)
    msg.value = '凭据已保存'
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  }
}

const ACTION_LABEL: Record<string, string> = {
  uploaded: '已上传', downloaded: '已下载', 'conflict-resolved': '冲突已解决', 'in-sync': '已是最新',
}
const trunc = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s)

/**
 * 手动多目标同步（复用 core syncMultipleTargets）：仅 enabled 目标参与；targets 未保存的编辑
 * 以内存值直接参与本轮（与旧单后端「未保存即同步用当前表单值」语义一致）。
 * 基线回写时机（沿用旧卡语义）：非采纳目标立即回写（失败目标 null=删基线，下轮全量重比）；
 * 下载/冲突采纳目标的基线在「采用云端」确认成功后才写——取消则保持旧基线，下次同步仍会重新
 * 下载提示，不会出现「基线=云端但本地为旧数据」的静默僵持。
 */
async function onSync(): Promise<void> {
  const p = props.platform
  if (!p) return
  if (!props.sessionSecret) return fail(new Error('请先设置备份口令')) // 按钮已禁用，防御兜底
  const enabled = targets.value.filter((t) => t.enabled)
  if (enabled.length === 0) return fail(new Error('未启用任何云目标'))
  busy.value = true
  msg.value = ''
  try {
    const inputs = await Promise.all(enabled.map(async (t) => ({
      key: t.cred.backend,
      backend: createCloudBackend(t.cred, (next) => {
        // GDrive 首推自动建文件回存 fileId / 后端探测回写：更新内存同 backend 项并持久化
        const idx = targets.value.findIndex((x) => x.cred.backend === next.backend)
        if (idx >= 0) targets.value[idx] = { ...targets.value[idx]!, cred: next }
        void p.saveCreds(targets.value).catch((e) => console.warn('[CloudCard] 凭据回存失败:', e))
      }),
      path: resolveObjectPath(t.cred),
      hash: await p.loadTargetHash(t.cred.backend),
    })))
    const r = await syncMultipleTargets({
      targets: inputs,
      vaultJson: p.readVaultJson(),
      password: props.sessionSecret,
      onConflictBackup: (key, bytes) => p.saveConflictBackup?.(bytes, key),
    })
    statusMap.value = {}
    resettableBackends.value = []
    pendingHashes.value = []
    for (const res of r.results) {
      if (!res.outcome) {
        const errMsg = res.error ?? ''
        if (errMsg.includes('口令不匹配')) {
          // 换口令后云端为旧口令信封：专用状态 + 行内重置救济入口
          statusMap.value[res.key] = '失败：口令不匹配'
          resettableBackends.value.push(res.key)
        } else {
          statusMap.value[res.key] = `失败：${trunc(errMsg)}`
        }
        await p.saveTargetHash(res.key, null) // 失败目标删基线，下轮全量重比
        continue
      }
      statusMap.value[res.key] = ACTION_LABEL[res.outcome.action] ?? res.outcome.action
      if (res.convergeError) statusMap.value[res.key] += `（收敛回推失败：${trunc(res.convergeError)}）`
      if (res.outcome.action === 'downloaded' || res.outcome.action === 'conflict-resolved') {
        pendingHashes.value.push([res.key, r.hashes[res.key] ?? '']) // 采纳目标基线延后至确认成功
      } else {
        await p.saveTargetHash(res.key, r.hashes[res.key] ?? null)
      }
    }
    if (p.loadAutoStatus) {
      try {
        autoStatus.value = await p.loadAutoStatus() // 手动完成后刷新自动状态行
      } catch { /* 状态读取失败不影响同步 */ }
    }
    if (r.adopted) {
      parseVaultJson(r.finalVaultJson) // 远端内容先过恢复校验，不合格不进入确认流程
      pendingAdopt.value = r.finalVaultJson
    }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 确认采用云端：整体替换本地存储（replaceAllOp 链路），成功后落采纳目标基线 */
async function onConfirmAdopt(): Promise<void> {
  const p = props.platform
  const json = pendingAdopt.value
  if (!p || !json) return
  busy.value = true
  try {
    await p.persistDownloaded(json)
    for (const [key, hash] of pendingHashes.value) await p.saveTargetHash(key, hash)
    pendingAdopt.value = null
    pendingHashes.value = []
    msg.value = '已采用云端数据覆盖本地'
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 取消采用：本地不动、采纳基线不写（下次同步仍会重新下载提示），提示冲突副本已保留 */
function onCancelAdopt(): void {
  pendingAdopt.value = null
  pendingHashes.value = []
  msg.value = '已保留冲突副本，未改动本地'
  msgKind.value = 'hint'
}

/** 口令不匹配救济第一步：进入行内两步确认（挂起期间同步/重置按钮禁用，同 pendingAdopt 模式） */
function askReset(backend: string): void {
  pendingReset.value = backend
}

/** 取消重置：不触碰云端，仅退出确认行 */
function onCancelReset(): void {
  pendingReset.value = null
}

/**
 * 确认重置（§3.2 换口令救济）：以当前会话备份口令把本地 vault 重新加密覆盖云端该目标对象
 * （云端旧口令信封被替换），成功后以新信封 hash 落基线并清出可重置集合；busy 期间防重入。
 */
async function onConfirmReset(): Promise<void> {
  const p = props.platform
  const b = pendingReset.value
  const t = targets.value.find((x) => x.cred.backend === b)
  if (!p || !b || !t || !props.sessionSecret) {
    pendingReset.value = null
    return
  }
  busy.value = true
  try {
    const r = await pushEnvelope({
      backend: createCloudBackend(t.cred),
      path: resolveObjectPath(t.cred),
      vaultJson: p.readVaultJson(),
      password: props.sessionSecret,
    })
    await p.saveTargetHash(b, r.hash)
    statusMap.value[b] = '已重置'
    resettableBackends.value = resettableBackends.value.filter((x) => x !== b)
    pendingReset.value = null
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 以卡内最新偏好整体回写平台（每次展开完整对象，连续切换不丢字段） */
async function syncAutoPrefs(): Promise<void> {
  await props.platform?.autoPrefs.set({ ...autoPrefs.value })
}
function onAutoOnChange(v: boolean): void {
  autoPrefs.value = { ...autoPrefs.value, onChange: v }
  void syncAutoPrefs()
}
function onAutoIntervalToggle(v: boolean): void {
  autoPrefs.value = { ...autoPrefs.value, onInterval: v }
  void syncAutoPrefs()
}
function onIntervalChange(e: Event): void {
  autoPrefs.value = { ...autoPrefs.value, intervalMinutes: Number((e.target as HTMLSelectElement).value) }
  void syncAutoPrefs()
}
</script>

<template>
  <section v-if="platform" class="card cloud">
    <h2>云同步</h2>
    <div v-for="(t, i) in targets" :key="t.cred.backend" class="target">
      <div class="target-head">
        <MdSwitch v-model="t.enabled" :aria-label="`${BACKEND_LABEL[t.cred.backend]}启用`" />
        <strong>{{ BACKEND_LABEL[t.cred.backend] }}</strong>
        <MdButton variant="text" class="target-toggle" @click="expanded = expanded === i ? -1 : i">{{ expanded === i ? '收起' : '配置' }}</MdButton>
      </div>
      <template v-if="expanded === i">
        <div v-if="t.cred.backend === 'webdav'" class="fields">
          <MdTextField v-model="t.cred.serverUrl" label="服务器地址" placeholder="服务器地址（https://dav.example.com）" autocomplete="off" />
          <MdTextField v-model="t.cred.username" label="用户名" placeholder="用户名" autocomplete="off" />
          <MdTextField v-model="t.cred.password" type="password" label="应用密码" placeholder="应用密码" autocomplete="new-password" />
        </div>
        <div v-else-if="t.cred.backend === 's3'" class="fields">
          <MdTextField v-model="t.cred.region" label="Region" placeholder="Region（如 us-east-1）" autocomplete="off" />
          <MdTextField v-model="t.cred.bucket" label="Bucket" placeholder="Bucket" autocomplete="off" />
          <MdTextField v-model="t.cred.accessKeyId" label="AccessKeyId" placeholder="AccessKeyId" autocomplete="off" />
          <MdTextField v-model="t.cred.secretAccessKey" type="password" label="SecretAccessKey" placeholder="SecretAccessKey" autocomplete="new-password" />
          <MdTextField v-model="t.cred.sessionToken" type="password" label="STS SessionToken（可选）" placeholder="STS SessionToken（可选）" autocomplete="new-password" />
          <MdTextField v-model="t.cred.endpoint" label="Endpoint" placeholder="Endpoint（可选，如 http://localhost:9000）" autocomplete="off" />
          <MdTextField v-model="t.cred.prefix" label="Key 前缀（可选）" placeholder="Key 前缀（可选）" autocomplete="off" />
          <MdCheckbox
            :model-value="!!t.cred.forcePathStyle" :disabled="busy" label="强制 path-style（兼容老 bucket / 自建 S3）"
            aria-label="强制 path-style（兼容老 bucket / 自建 S3）" @update:model-value="t.cred.forcePathStyle = $event"
          />
        </div>
        <div v-else-if="t.cred.backend === 'gist'" class="fields">
          <MdTextField v-model="t.cred.token" type="password" label="GitHub Token" placeholder="GitHub Token" autocomplete="new-password" />
          <MdTextField v-model="t.cred.gistId" label="Gist ID" placeholder="Gist ID" autocomplete="off" />
          <MdCheckbox
            :model-value="!!t.cred.public" :disabled="busy" label="公开 gist（public）"
            aria-label="公开 gist（public）" @update:model-value="t.cred.public = $event"
          />
          <p v-if="t.cred.public" class="warn" role="alert">当前 gist 为 public，备份内容会暴露在公开页，建议改为 secret gist</p>
        </div>
        <div v-else-if="t.cred.backend === 'gdrive'" class="fields">
          <MdTextField v-model="t.cred.accessToken" type="password" label="Access Token（Google OAuth）" placeholder="Access Token（Google OAuth）" autocomplete="new-password" />
        </div>
        <div v-else class="fields">
          <MdTextField v-model="t.cred.accessToken" type="password" label="Access Token（Microsoft Graph）" placeholder="Access Token（Microsoft Graph）" autocomplete="new-password" />
        </div>
        <MdTextField :model-value="t.cred.objectPath ?? ''" label="目标文件路径" :placeholder="DEFAULT_OBJECT_PATH" aria-label="目标文件路径" :disabled="busy" @update:model-value="t.cred.objectPath = $event.trim()" />
      </template>
      <span v-if="statusFor(t.cred.backend)" class="target-status">{{ statusFor(t.cred.backend) }}</span>
      <MdButton
        v-if="resettableBackends.includes(t.cred.backend)" variant="text" danger class="cloud-reset"
        :disabled="busy" @click="askReset(t.cred.backend)"
      >用当前口令重置云端</MdButton>
    </div>
    <div class="actions">
      <MdButton v-if="nextBackend" variant="text" class="target-add" @click="addTarget(nextBackend)">添加目标：{{ BACKEND_LABEL[nextBackend] }}</MdButton>
      <MdButton class="creds-save" :disabled="busy" @click="onSaveCreds">保存凭据</MdButton>
      <MdButton class="cloud-sync" :disabled="busy || !sessionSecret || pendingAdopt !== null || pendingReset !== null" @click="onSync">立即同步</MdButton>
    </div>
    <p v-if="!sessionSecret" class="hint">先在上方设置备份口令。</p>
    <div v-if="platform.autoPrefs" class="auto-block">
      <p class="hint">自动执行前会与上次内容比对，无变化则跳过写入。</p>
      <div class="auto-row">
        <div class="auto-item">
          <MdSwitch :model-value="autoPrefs.onChange" aria-label="变更后自动同步" @update:model-value="onAutoOnChange" />
          <span>变更后自动同步</span>
        </div>
        <div class="auto-item">
          <MdSwitch :model-value="autoPrefs.onInterval" aria-label="定时自动同步" @update:model-value="onAutoIntervalToggle" />
          <span>定时自动同步</span>
        </div>
        <div class="auto-item">
          <span>间隔</span>
          <select
            class="interval" :value="autoPrefs.intervalMinutes" aria-label="自动同步间隔"
            @change="onIntervalChange"
          >
            <option :value="15">15 分钟</option>
            <option :value="60">1 小时</option>
            <option :value="360">6 小时</option>
            <option :value="1440">每天</option>
          </select>
        </div>
      </div>
      <span v-if="platform.loadAutoStatus" class="auto-status">上次自动同步：{{ autoStatus ?? '暂无' }}</span>
    </div>
    <div v-if="pendingAdopt" class="confirm-row">
      <span>云端数据较新，已保留本地冲突副本，采用云端将覆盖本地。</span>
      <MdButton danger :disabled="busy" @click="onConfirmAdopt">采用云端</MdButton>
      <MdButton variant="text" :disabled="busy" @click="onCancelAdopt">取消</MdButton>
    </div>
    <div v-if="pendingReset" class="confirm-row reset-confirm-row">
      <span>将用当前备份口令重新加密并覆盖云端 {{ backendLabel(pendingReset) }} 对象，云端旧数据将被替换。确认重置？</span>
      <MdButton danger :disabled="busy" @click="onConfirmReset">确认重置</MdButton>
      <MdButton variant="text" :disabled="busy" @click="onCancelReset">取消</MdButton>
    </div>
    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供(M3 双描边裁定,2026-09-16 审查 X1);本组件只负责内容排版 */
.card { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.target { display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--md-sys-color-outline-variant); padding-bottom: 6px; }
.target-head { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.target-head strong { flex: 1; }
.target-status { font-size: var(--md-sys-typescale-body-small); opacity: .8; }
.fields { display: flex; flex-direction: column; gap: 6px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.auto-block { display: flex; flex-direction: column; gap: 4px; }
.auto-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.auto-item { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.interval { height: 32px; border-radius: 8px; border: 1px solid var(--md-sys-color-outline); background: transparent; color: inherit; font: inherit; font-size: var(--md-sys-typescale-body-medium); padding: 0 6px; }
.auto-status { font-size: var(--md-sys-typescale-body-small); opacity: .65; }
.confirm-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); flex-wrap: wrap; }
.hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
.ok { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); }
.err { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
.warn { color: var(--md-sys-color-tertiary); font-size: var(--md-sys-typescale-body-medium); margin: 0; }
</style>
