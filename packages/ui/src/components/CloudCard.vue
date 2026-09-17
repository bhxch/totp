<script setup lang="ts">
import type { BackupSource, CloudCred } from '@totp/core'
import {
  DEFAULT_OBJECT_PATH, enforceRemoteRetention, pushEnvelope, resolveObjectPath, resolveTimestampPath, syncMultipleTargets,
} from '@totp/core'
import { computed, onMounted, ref } from 'vue'
import { createCloudBackend } from './cloudPlatform'
import type { CloudAutoPrefs, CloudPlatform } from './cloudPlatform'
import { parseVaultJson } from './parseVaultJson'
import MdButton from './md/MdButton.vue'
import MdCheckbox from './md/MdCheckbox.vue'
import MdMenu from './md/MdMenu.vue'
import MdSegmentedButton from './md/MdSegmentedButton.vue'
import MdSelect from './md/MdSelect.vue'
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

/** 源列表（挂载时 loadSources 回填；卡内编辑=内存副本，「保存凭据」才落盘） */
const sources = ref<BackupSource[]>([])
/** 各源凭据编辑副本（键=sourceId；初始自 platform.creds 拷贝，无已存凭据的源为空白凭据） */
const credDrafts = ref<Record<string, CloudCred>>({})
/** 当前展开配置的源索引（-1=全部收起；同时只展开一个） */
const expanded = ref(-1)

const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')

/** 各源最近一次手动同步结果文本（键=sourceId） */
const statusMap = ref<Record<string, string>>({})
function statusFor(id: string): string {
  return statusMap.value[id] ?? ''
}

/** 已解密待确认覆盖的远端 vault JSON（两步确认防误覆盖，沿用旧卡行内确认交互） */
const pendingAdopt = ref<string | null>(null)
/** 采纳源待确认的基线 hash：「采用云端」确认成功后才落盘；取消则不写（下次同步重新下载提示） */
const pendingHashes = ref<Array<[string, string]>>([])

/** 同步报「口令不匹配」的源 id（换口令后云端为旧口令信封）：提供行内重置救济入口 */
const resettableBackends = ref<string[]>([])
/** 待确认重置的源 id（行内两步确认，同 pendingAdopt 模式；挂起期间同步按钮禁用） */
const pendingReset = ref<string | null>(null)
/** 待确认移除的源 id（行内两步确认，同 pendingReset 模式；挂起期间同步按钮禁用） */
const pendingRemove = ref<string | null>(null)

/** 确认行文案用的源名（按 id 解析；行内确认挂起期间该源仍在列表） */
function sourceName(id: string): string {
  return sources.value.find((x) => x.id === id)?.name ?? ''
}

/** 自动触发偏好（卡内编辑副本，挂载时读初值；每次变更整体回写） */
const autoPrefs = ref<CloudAutoPrefs>({ onChange: false, onInterval: false, intervalMinutes: 60 })
/** 「上次自动同步」状态文本（宿主 loadAutoStatus 提供；缺省显示「暂无」） */
const autoStatus = ref<string | null>(null)

/** 「添加源」菜单（plan16：同类型可多份，不再按已存在过滤，菜单恒列全部五种云后端） */
const addableBackends = BACKENDS

/** 「添加源」下拉菜单（MdMenu 负责定位/Esc 关闭；点选或 Esc 后收起） */
const addMenuOpen = ref(false)
const addMenuPos = ref({ x: 0, y: 0 })
/** 触发按钮元素：openAddMenu 时从 currentTarget 捕获（MdButton 透传原生事件，无需组件 ref 透传），
 *  传给 MdMenu 作 triggerEl 供 Esc 关闭回焦 */
const addMenuTrigger = ref<HTMLElement | null>(null)
function openAddMenu(e: MouseEvent): void {
  addMenuTrigger.value = (e.currentTarget as HTMLElement) ?? null
  addMenuPos.value = { x: e.clientX, y: e.clientY }
  addMenuOpen.value = true
}

/** 源 id 工厂：优先 crypto.randomUUID（宿主安全上下文），jsdom 等缺失环境回落时间戳+随机段 */
function newSourceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 空白凭据工厂：字符串字段（含可选）一律空串，避免 undefined 传 MdTextField 触发 prop 警告；
 * 布尔可选字段不设键——isBlankCred 依赖「可选字段 undefined」判空白，置 false 会破坏空白直删语义。
 * 入参断言 BackendId：本卡仅渲染云源，宿主不会把 local 源传进 loadSources。 */
function blankCred(b: BackendId): CloudCred {
  switch (b) {
    case 'webdav': return { backend: 'webdav', serverUrl: '', username: '', password: '', objectPath: '' }
    case 's3': return { backend: 's3', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', endpoint: '', prefix: '', sessionToken: '', objectPath: '' }
    case 'gist': return { backend: 'gist', token: '', gistId: '', objectPath: '' }
    case 'gdrive': return { backend: 'gdrive', accessToken: '', objectPath: '' }
    case 'onedrive': return { backend: 'onedrive', accessToken: '', objectPath: '' }
  }
}

/** 添加源：生成 uuid 源（name 默认后端名、覆盖策略、enabled 开）+ 空白凭据副本，并展开其配置 */
function addTarget(b: BackendId): void {
  const id = newSourceId()
  sources.value.push({ id, kind: b, name: BACKEND_LABEL[b], retention: { type: 'overwrite' }, enabled: true })
  credDrafts.value[id] = blankCred(b)
  expanded.value = sources.value.length - 1
  addMenuOpen.value = false
}

/** 凭据是否空白（除 backend 外所有字段均为空串/undefined）：空白行从未持久化过 */
function isBlankCred(cred: CloudCred): boolean {
  return Object.entries(cred).every(([k, v]) => k === 'backend' || v === undefined || v === '')
}

/** 保留策略二选（MdSegmentedButton 选项） */
const RETENTION_OPTIONS = [
  { value: 'overwrite', label: '覆盖' },
  { value: 'keep', label: '保留最近' },
]
/** keep 份数输入 → 源 retention：空串/非数字回落 3（与本地源默认一致），数字钳下限 1 */
function onKeepN(s: BackupSource, v: string | number): void {
  const parsed = v === '' ? NaN : Number(v)
  s.retention = { type: 'keep', n: Number.isFinite(parsed) ? Math.max(1, Math.round(parsed)) : 3 }
}
function onRetentionType(s: BackupSource, v: string | number): void {
  s.retention = v === 'keep' ? { type: 'keep', n: 3 } : { type: 'overwrite' }
}

/**
 * 从 sources 移除该源并同步清理引用它的状态：
 * 可重置集合、采纳基线（挂起确认不再给已移除源写基线）、单源状态行、凭据编辑副本；
 * 展开索引按 id 重解析（删除会使后续索引前移）。
 */
function removeTarget(id: string): void {
  const expandedId = expanded.value >= 0 ? sources.value[expanded.value]?.id : null
  sources.value = sources.value.filter((x) => x.id !== id)
  resettableBackends.value = resettableBackends.value.filter((x) => x !== id)
  pendingHashes.value = pendingHashes.value.filter(([k]) => k !== id)
  delete statusMap.value[id]
  delete credDrafts.value[id]
  expanded.value = expandedId !== undefined && expandedId !== null
    ? sources.value.findIndex((x) => x.id === expandedId)
    : -1
}

/** 移除入口：空白凭据源直接删（凭据从未持久化过，不需要 removeCred）；非空走行内两步确认 */
function askRemove(id: string): void {
  const s = sources.value.find((x) => x.id === id)
  if (!s) return
  const draft = credDrafts.value[id]
  if (isBlankCred(draft ?? blankCred(s.kind as BackendId))) {
    removeTarget(id)
    return
  }
  pendingRemove.value = id
  pendingReset.value = null // 三态互斥：同时只有一个行内确认挂起
}

/** 取消移除：本地存储与列表均不动 */
function onCancelRemove(): void {
  pendingRemove.value = null
}

/**
 * 确认移除：源元数据=当前内存列表减去该项（与「保存凭据」持久化内存列表的既有语义一致）；
 * 凭据仅在平台凭据缓存中存在时调 removeCred（未保存过的空白源跳过——锁定态缓存为空也不误触
 * 未解锁 reject），云端对象不受影响。
 */
async function onConfirmRemove(): Promise<void> {
  const p = props.platform
  const id = pendingRemove.value
  if (!p || !id) {
    pendingRemove.value = null
    return
  }
  const hadSavedCred = !!p.creds[id]
  removeTarget(id)
  try {
    await p.saveSources(sources.value)
    if (hadSavedCred) await p.removeCred(id)
  } catch (e) {
    fail(e)
  }
  pendingRemove.value = null
}

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

onMounted(async () => {
  const p = props.platform
  if (!p) return
  try {
    sources.value = await p.loadSources()
  } catch {
    sources.value = [] // 回填失败按未存源处理
  }
  for (const s of sources.value) {
    const saved = p.creds[s.id]
    credDrafts.value[s.id] = saved ? { ...saved } : blankCred(s.kind as BackendId)
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

/**
 * 保存凭据：源元数据整列表落盘 + 逐源把编辑副本写入保管区（含禁用源——凭据与启用态独立，
 * 跳过会造成编辑静默丢失；空白凭据跳过并提示——空白行从未配置过，写入只会污染保管区）。
 */
async function onSaveCreds(): Promise<void> {
  const p = props.platform
  if (!p) return
  try {
    await p.saveSources(sources.value)
    let skipped = 0
    for (const s of sources.value) {
      const draft = credDrafts.value[s.id]
      if (!draft || isBlankCred(draft)) {
        skipped++
        continue
      }
      await p.saveCred(s.id, draft)
    }
    msg.value = skipped > 0 ? `凭据已保存（${skipped} 个空白源凭据未保存）` : '凭据已保存'
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
 * 手动多源同步（复用 core syncMultipleTargets）：仅 enabled 源参与；凭据取编辑副本（无则已存凭据）。
 * 无凭据（锁定态缓存空/编辑副本空白）的启用源报错跳过：状态行「缺少凭据：解锁后保存凭据后再同步」，
 * 不阻塞其余源。keep 源 path=resolveTimestampPath（时间戳名），上传成功后远端滚动删除超额旧份。
 * 基线回写时机（沿用旧卡语义）：非采纳源立即回写（失败源 null=删基线，下轮全量重比）；
 * 下载/冲突采纳源的基线在「采用云端」确认成功后才写——取消则保持旧基线，下次同步仍会重新
 * 下载提示，不会出现「基线=云端但本地为旧数据」的静默僵持。
 */
async function onSync(): Promise<void> {
  const p = props.platform
  if (!p) return
  if (!props.sessionSecret) return fail(new Error('请先设置备份口令')) // 按钮已禁用，防御兜底
  const enabled = sources.value.filter((s) => s.enabled)
  if (enabled.length === 0) return fail(new Error('未启用任何云源'))
  busy.value = true
  msg.value = ''
  statusMap.value = {}
  try {
    const inputs: Array<{ key: string; backend: ReturnType<typeof createCloudBackend>; path: string; hash: string | null }> = []
    for (const s of enabled) {
      const cred = credDrafts.value[s.id] ?? p.creds[s.id]
      if (!cred || isBlankCred(cred)) {
        statusMap.value[s.id] = '缺少凭据：解锁后保存凭据后再同步' // 锁定态缓存为空同此口径
        continue
      }
      inputs.push({
        key: s.id,
        backend: createCloudBackend(cred, (next) => {
          // GDrive 首推自动建文件回存 fileId / 后端探测回写：按 sourceId 更新编辑副本（本会话继续可用）
          if (credDrafts.value[s.id]) credDrafts.value[s.id] = { ...next }
          // 持久化=单源保管区 op（未保存的其他行编辑不外溢落盘）
          void p.saveCred(s.id, next).catch((e) => console.warn('[CloudCard] 凭据回存失败:', e))
        }),
        path: s.retention.type === 'keep' ? resolveTimestampPath(cred, new Date()) : resolveObjectPath(cred),
        hash: await p.loadTargetHash(s.id),
      })
    }
    if (inputs.length === 0) return fail(new Error('启用源均缺少凭据，请先解锁并保存凭据'))
    const r = await syncMultipleTargets({
      targets: inputs,
      vaultJson: p.readVaultJson(),
      password: props.sessionSecret,
      onConflictBackup: (key, bytes) => p.saveConflictBackup?.(bytes, key),
      profile: p.kdfProfile?.(),
    })
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
        await p.saveTargetHash(res.key, null) // 失败源删基线，下轮全量重比
        continue
      }
      statusMap.value[res.key] = ACTION_LABEL[res.outcome.action] ?? res.outcome.action
      if (res.convergeError) statusMap.value[res.key] += `（收敛回推失败：${trunc(res.convergeError)}）`
      // keep 源上传成功（含收敛改写后的 uploaded）→ 远端滚动删除超额旧份，结果附到状态行：
      // deleted>0 显示清理份数；-1=后端不支持自动清理，提示累积风险与替代选项；0=未超额不刷屏。
      // per-source try/catch 隔离：listBackups/删除网络抛错不改写该源上传成功状态、
      // 不中断 results 循环后续（该源基线回写与其余源处理照常），失败仅提示下轮重试
      const src = sources.value.find((x) => x.id === res.key)
      if (src?.retention.type === 'keep' && res.outcome.action === 'uploaded') {
        const backend = inputs.find((x) => x.key === res.key)?.backend
        if (backend) {
          try {
            const deleted = await enforceRemoteRetention(backend, src.retention.n)
            if (deleted > 0) statusMap.value[res.key] += `（滚动清理 ${deleted} 份）`
            else if (deleted < 0) statusMap.value[res.key] += '（该后端不支持自动清理，历史备份会累积，可手动清理或改用覆盖模式）'
          } catch {
            statusMap.value[res.key] += '（滚动清理失败，下轮同步重试）'
          }
        }
      }
      if (res.outcome.action === 'downloaded' || res.outcome.action === 'conflict-resolved') {
        pendingHashes.value.push([res.key, r.hashes[res.key] ?? '']) // 采纳源基线延后至确认成功
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

/** 确认采用云端：整体替换本地存储（replaceAllOp 链路），成功后落采纳源基线 */
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
function askReset(id: string): void {
  pendingReset.value = id
  pendingRemove.value = null // 三态互斥：同时只有一个行内确认挂起
}

/** 取消重置：不触碰云端，仅退出确认行 */
function onCancelReset(): void {
  pendingReset.value = null
}

/**
 * 确认重置（§3.2 换口令救济）：以当前会话备份口令把本地 vault 重新加密覆盖云端该源对象
 * （keep 源按 retention 写新时间戳文件，overwrite 源覆盖固定对象），成功后以新信封 hash
 * 落基线并清出可重置集合；busy 期间防重入。
 */
async function onConfirmReset(): Promise<void> {
  const p = props.platform
  const id = pendingReset.value
  const s = sources.value.find((x) => x.id === id)
  const cred = s ? (credDrafts.value[s.id] ?? p.creds[s.id]) : undefined
  if (!p || !s || !cred || !props.sessionSecret) {
    pendingReset.value = null
    return
  }
  busy.value = true
  try {
    const r = await pushEnvelope({
      backend: createCloudBackend(cred),
      path: s.retention.type === 'keep' ? resolveTimestampPath(cred, new Date()) : resolveObjectPath(cred),
      vaultJson: p.readVaultJson(),
      password: props.sessionSecret,
    })
    await p.saveTargetHash(s.id, r.hash)
    statusMap.value[s.id] = '已重置'
    resettableBackends.value = resettableBackends.value.filter((x) => x !== s.id)
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
/** 定时同步间隔选项（value=分钟数，number 直传回写不再经字符串转换；F6 收口换 MdSelect） */
const INTERVAL_OPTIONS = [
  { value: 15, label: '15 分钟' },
  { value: 60, label: '1 小时' },
  { value: 360, label: '6 小时' },
  { value: 1440, label: '每天' },
]
function onIntervalChange(v: string | number): void {
  autoPrefs.value = { ...autoPrefs.value, intervalMinutes: Number(v) }
  void syncAutoPrefs()
}
/** 源名称是否已自定义（同 kind 多份区分用；与默认后端名相同时不强提示） */
const hasCustomNames = computed(() => new Set(sources.value.map((s) => s.name)).size > 1)
</script>

<template>
  <section v-if="platform" class="card cloud">
    <h2>云同步</h2>
    <div v-for="(s, i) in sources" :key="s.id" class="target">
      <div class="target-head">
        <MdSwitch v-model="s.enabled" :aria-label="`${s.name}启用`" />
        <strong>{{ s.name }}</strong>
        <MdButton variant="text" class="target-toggle" @click="expanded = expanded === i ? -1 : i">{{ expanded === i ? '收起' : '配置' }}</MdButton>
        <MdButton variant="text" danger class="target-remove" :disabled="busy || pendingAdopt !== null" @click="askRemove(s.id)">移除</MdButton>
      </div>
      <template v-if="expanded === i">
        <div class="fields">
          <MdTextField v-model="s.name" label="名称" placeholder="源名称（同类型多份时区分用）" aria-label="源名称" autocomplete="off" />
          <div class="retention-row">
            <MdSegmentedButton
              :options="RETENTION_OPTIONS" :model-value="s.retention.type" aria-label="保留策略"
              @update:model-value="onRetentionType(s, $event)"
            />
            <MdTextField
              v-if="s.retention.type === 'keep'" class="keep-n"
              :model-value="String(s.retention.n)" type="number" label="保留份数" aria-label="保留份数"
              :disabled="busy" @update:model-value="onKeepN(s, $event)"
            />
          </div>
        </div>
        <div v-if="s.kind === 'webdav'" class="fields">
          <MdTextField v-model="credDrafts[s.id]!.serverUrl" label="服务器地址" placeholder="服务器地址（https://dav.example.com）" autocomplete="off" />
          <MdTextField v-model="credDrafts[s.id]!.username" label="用户名" placeholder="用户名" autocomplete="off" />
          <MdTextField v-model="credDrafts[s.id]!.password" type="password" label="应用密码" placeholder="应用密码" autocomplete="new-password" />
        </div>
        <div v-else-if="s.kind === 's3'" class="fields">
          <MdTextField v-model="credDrafts[s.id]!.region" label="Region" placeholder="Region（如 us-east-1）" autocomplete="off" />
          <MdTextField v-model="credDrafts[s.id]!.bucket" label="Bucket" placeholder="Bucket" autocomplete="off" />
          <MdTextField v-model="credDrafts[s.id]!.accessKeyId" label="AccessKeyId" placeholder="AccessKeyId" autocomplete="off" />
          <MdTextField v-model="credDrafts[s.id]!.secretAccessKey" type="password" label="SecretAccessKey" placeholder="SecretAccessKey" autocomplete="new-password" />
          <MdTextField v-model="credDrafts[s.id]!.sessionToken" type="password" label="STS SessionToken（可选）" placeholder="STS SessionToken（可选）" autocomplete="new-password" />
          <MdTextField v-model="credDrafts[s.id]!.endpoint" label="Endpoint" placeholder="Endpoint（可选，如 http://localhost:9000）" autocomplete="off" />
          <MdTextField v-model="credDrafts[s.id]!.prefix" label="Key 前缀（可选）" placeholder="Key 前缀（可选）" autocomplete="off" />
          <MdCheckbox
            :model-value="!!credDrafts[s.id]!.forcePathStyle" :disabled="busy" label="强制 path-style（兼容老 bucket / 自建 S3）"
            aria-label="强制 path-style（兼容老 bucket / 自建 S3）" @update:model-value="credDrafts[s.id]!.forcePathStyle = $event"
          />
        </div>
        <div v-else-if="s.kind === 'gist'" class="fields">
          <MdTextField v-model="credDrafts[s.id]!.token" type="password" label="GitHub Token" placeholder="GitHub Token" autocomplete="new-password" />
          <MdTextField v-model="credDrafts[s.id]!.gistId" label="Gist ID" placeholder="Gist ID" autocomplete="off" />
          <MdCheckbox
            :model-value="!!credDrafts[s.id]!.public" :disabled="busy" label="公开 gist（public）"
            aria-label="公开 gist（public）" @update:model-value="credDrafts[s.id]!.public = $event"
          />
          <p v-if="credDrafts[s.id]!.public" class="warn" role="alert">当前 gist 为 public，备份内容会暴露在公开页，建议改为 secret gist</p>
        </div>
        <div v-else-if="s.kind === 'gdrive'" class="fields">
          <MdTextField v-model="credDrafts[s.id]!.accessToken" type="password" label="Access Token（Google OAuth）" placeholder="Access Token（Google OAuth）" autocomplete="new-password" />
        </div>
        <div v-else class="fields">
          <MdTextField v-model="credDrafts[s.id]!.accessToken" type="password" label="Access Token（Microsoft Graph）" placeholder="Access Token（Microsoft Graph）" autocomplete="new-password" />
        </div>
        <MdTextField :model-value="credDrafts[s.id]!.objectPath ?? ''" label="目标文件路径" :placeholder="DEFAULT_OBJECT_PATH" aria-label="目标文件路径" :disabled="busy" @update:model-value="credDrafts[s.id]!.objectPath = $event.trim()" />
      </template>
      <span v-if="statusFor(s.id)" class="target-status">{{ statusFor(s.id) }}</span>
      <MdButton
        v-if="resettableBackends.includes(s.id)" variant="text" danger class="cloud-reset"
        :disabled="busy || pendingAdopt !== null" @click="askReset(s.id)"
      >用当前口令重置云端</MdButton>
    </div>
    <div class="actions">
      <MdButton variant="text" class="target-add" aria-haspopup="menu" :aria-expanded="addMenuOpen ? 'true' : 'false'" @click="openAddMenu">添加源</MdButton>
      <!-- MdMenu 只在 open 时渲染；定位/Esc 关闭由组件负责，点选收起在 addTarget 内；triggerEl 供 Esc 回焦 -->
      <MdMenu :x="addMenuPos.x" :y="addMenuPos.y" :open="addMenuOpen" :trigger-el="addMenuTrigger" @close="addMenuOpen = false">
        <MdButton v-for="b in addableBackends" :key="b" variant="text" class="menu-item" @click="addTarget(b)">{{ BACKEND_LABEL[b] }}</MdButton>
      </MdMenu>
      <MdButton class="creds-save" :disabled="busy" @click="onSaveCreds">保存凭据</MdButton>
      <MdButton class="cloud-sync" :disabled="busy || !sessionSecret || pendingAdopt !== null || pendingReset !== null || pendingRemove !== null" @click="onSync">立即同步</MdButton>
    </div>
    <p v-if="!sessionSecret" class="hint">先在上方设置备份口令。</p>
    <p v-if="hasCustomNames" class="hint">同名源请用「名称」区分（同类型可添加多份）。</p>
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
          <MdSelect
            :model-value="autoPrefs.intervalMinutes" :options="INTERVAL_OPTIONS"
            label="间隔" aria-label="自动同步间隔" @update:model-value="onIntervalChange"
          />
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
      <span>将用当前备份口令重新加密并覆盖云端源「{{ sourceName(pendingReset) }}」的对象，云端旧数据将被替换。确认重置？</span>
      <MdButton danger :disabled="busy" @click="onConfirmReset">确认重置</MdButton>
      <MdButton variant="text" :disabled="busy" @click="onCancelReset">取消</MdButton>
    </div>
    <div v-if="pendingRemove" class="confirm-row remove-confirm-row">
      <span>移除源「{{ sourceName(pendingRemove) }}」？已保存的凭据将从本机删除，云端对象不受影响。</span>
      <MdButton danger :disabled="busy" @click="onConfirmRemove">确认移除</MdButton>
      <MdButton variant="text" :disabled="busy" @click="onCancelRemove">取消</MdButton>
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
.retention-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.keep-n { width: 120px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.auto-block { display: flex; flex-direction: column; gap: 4px; }
.auto-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.auto-item { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.auto-status { font-size: var(--md-sys-typescale-body-small); opacity: .65; }
.confirm-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); flex-wrap: wrap; }
/* 「添加源」菜单项（MdMenu 容器自带定位与外观；MdButton text 形收紧为菜单项排版，同 CodesPage ctx-item） */
.menu-item { display: block; width: 100%; height: 36px; justify-content: flex-start; border-radius: 0; font-size: var(--md-sys-typescale-body-medium); text-align: left; padding: 0 14px; }
.hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
.ok { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); }
.err { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
.warn { color: var(--md-sys-color-tertiary); font-size: var(--md-sys-typescale-body-medium); margin: 0; }
</style>
