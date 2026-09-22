<script setup lang="ts">
import type { BackupSource, CloudCred, EntryConflict, GDriveCred, GistCred, OneDriveCred, S3Cred, SourceSyncState, WebdavCred } from '@totp/core'
import {
  contentHash, DEFAULT_OBJECT_PATH, enforceRemoteRetention, pushEnvelope, resolveObjectPath, resolveTimestampPath, syncMultipleTargets,
} from '@totp/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { VueStore } from '../store'
import { createCloudBackend, isPlaintextHttpUrl } from './cloudPlatform'
import type { CloudAutoPrefs, CloudPlatform } from './cloudPlatform'
import { pendingMergeConfirm, requestMergeConfirm, settleMergeConfirm, syncProgressState } from './cloudSyncBridge'
import MergeConflictList from './MergeConflictList.vue'
import MergePreviewDialog from './MergePreviewDialog.vue'
import { parseVaultJson } from './parseVaultJson'
import { displaySourceName } from './sourceDisplayNames'
import MdButton from './md/MdButton.vue'
import MdCheckbox from './md/MdCheckbox.vue'
import MdMenu from './md/MdMenu.vue'
import MdSegmentedButton from './md/MdSegmentedButton.vue'
import MdSelect from './md/MdSelect.vue'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

const props = withDefaults(defineProps<{
  /** 云同步平台实现；null 时整卡不渲染（popup 不受影响） */
  platform: CloudPlatform | null
  /** 会话备份口令（D1，即备份加密口令）；null 时同步禁用并提示先设置备份口令 */
  sessionSecret: string | null
  /** 全局响应式 store（T11 冲突裁决面：mergeConflicts/resolveMergeConflictOp）；缺省 null=不渲染冲突区块 */
  store?: VueStore | null
  /** [可选] 云凭据失效标志（跨端同步 T4，自 SyncCard 归位）：true 渲染重授权警示（消失途径：
   *  重新授权后手动同步成功 onManualSynced → 宿主复位镜像，或重启宿主页） */
  authFailed?: boolean
}>(), { store: null, authFailed: false })

const { t } = useI18n()

/** 同步动作 → 状态文案 key（i18n D2：卡内状态行经 t() 渲染；自动 runner 摘要经 deps.t 用 common.json cloudRunner.* 记录）。
 *  键 = rev 编排四出口（RevSyncAction；旧 conflict-resolved 标签随 T9 pull 通道改造删除） */
const ACTION_LABEL_KEY: Record<string, string> = {
  uploaded: 'cloudCard.actionUploaded',
  downloaded: 'cloudCard.actionDownloaded',
  merged: 'cloudCard.actionMerged',
  'in-sync': 'cloudCard.actionInSync',
}

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

// ---------- T11 冲突裁决面（spec §3/§4 冲突强提示）：条目冲突列表 + extension 冲突副本入口 ----------
/** 未裁决条目冲突（store.mergeConflicts 只读消费；锁定态 store 已清空 → 区块自然隐藏） */
const mergeConflicts = computed<EntryConflict[]>(() => props.store?.mergeConflicts.value ?? [])
const conflictCount = computed(() => props.store?.conflictCount.value ?? 0)
/** 裁决写回在途（期间全列表按钮禁用防重入；单条 op 含 commit 推进与落盘） */
const resolvingConflict = ref(false)
async function onResolveConflict(entryId: string, pick: 'ours' | 'theirs'): Promise<void> {
  const s = props.store
  if (!s || resolvingConflict.value) return
  resolvingConflict.value = true
  try {
    await s.resolveMergeConflictOp(entryId, pick)
    msg.value = t('cloudCard.conflictResolvedMsg')
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  } finally {
    resolvingConflict.value = false
  }
}

/** extension 冲突副本视图（platform.listConflictCopies 提供才启用；desktop 副本在备份恢复列表可见，不渲染此区） */
interface ConflictCopyView { name: string; at: number }
const conflictCopies = ref<ConflictCopyView[]>([])
async function refreshConflictCopies(): Promise<void> {
  const p = props.platform
  if (!p?.listConflictCopies) {
    conflictCopies.value = []
    return
  }
  try {
    conflictCopies.value = await p.listConflictCopies()
  } catch {
    conflictCopies.value = [] // 副本属救灾数据：读取失败按空呈现，不阻塞卡内其余功能
  }
}
/** 手动导出（spec §4：唯一下载出口=显式点击；无名=已被滚动清理，如实提示） */
async function onExportCopy(name: string): Promise<void> {
  if (!props.platform?.exportConflictCopy) return
  try {
    const ok = await props.platform.exportConflictCopy(name)
    if (!ok) fail(new Error(t('cloudCard.copyExportMissing')))
  } catch (e) {
    fail(e)
  }
}

// ---------- T11 角色互斥（spec §2 活动目标单选，T6 遗留收口） ----------
/** 角色选项（MdSegmentedButton；短文案适配行内排版） */
const ROLE_OPTIONS = [
  { value: 'primary', label: t('cloudCard.rolePrimary') },
  { value: 'replica', label: t('cloudCard.roleReplica') },
]
/**
 * 角色选举：把该源选为 primary——其余源（含禁用）全部降 replica（启用源中恒恰一个 primary；
 * 已是 primary 或禁用源点击无效果——让位须选举另一启用源）。同时把该源移到列表首位：
 * loadSources 的 normalizeSourceRoles 按「首个 enabled=primary」归一，非首位保存的 primary
 * 会在下次装载被改写——置首使选择可持久化。仅内存编辑（与名称/保留/启用同通道），
 * 随「保存凭据」整体落盘；展开态按 id 重解析防索引漂移。
 */
function onRoleChange(s: BackupSource, v: string | number): void {
  if (v !== 'primary' || s.role === 'primary' || !s.enabled) return
  const expandedId = expanded.value >= 0 ? sources.value[expanded.value]?.id : null
  sources.value = [
    { ...s, role: 'primary' },
    ...sources.value.filter((x) => x.id !== s.id).map((x) => ({ ...x, role: 'replica' as const })),
  ]
  expanded.value = expandedId !== undefined && expandedId !== null
    ? sources.value.findIndex((x) => x.id === expandedId)
    : -1
}
/** 启用开关切换后的角色归一（对齐 loadSources 归一语义）：存在启用源但无 primary（如唯一 primary
 *  被关闭）→ 首个启用源升 primary，其余降 replica。v-model 先行赋值 s.enabled，此处读到的为 新值 */
function onEnabledToggled(): void {
  if (sources.value.some((x) => x.enabled && x.role === 'primary')) return
  const first = sources.value.find((x) => x.enabled)
  if (!first) return
  sources.value = sources.value.map((x) => ({ ...x, role: x.id === first.id ? ('primary' as const) : ('replica' as const) }))
}

// ---------- T11 合并预览/逐源进度桥（cloudSyncBridge）：宿主 runner 回调 → 卡内 UI ----------
/** 挂起的 manual 合并预览征询（非空=对话框打开）；组件卸载视同取消（runner 记跳过态） */
const pendingConfirm = pendingMergeConfirm()
const progress = syncProgressState()
onUnmounted(() => settleMergeConfirm(false))

/** 已解密待确认覆盖的远端 vault JSON（两步确认防误覆盖，沿用旧卡行内确认交互） */
const pendingAdopt = ref<string | null>(null)
/** 采纳源待确认的基线 hash：「采用云端」确认成功后才落盘；取消则不写（下次同步重新下载提示） */
/** 采纳源 rev 基线延后至「采用云端」确认成功才落盘（取消则不写，下次同步重新下载提示） */
const pendingStates = ref<Array<[string, SourceSyncState]>>([])

/** 同步报「口令不匹配」的源 id（换口令后云端为旧口令信封）：提供行内重置救济入口 */
const resettableBackends = ref<string[]>([])
/** 待确认重置的源 id（行内两步确认，同 pendingAdopt 模式；挂起期间同步按钮禁用） */
const pendingReset = ref<string | null>(null)
/** 待确认移除的源 id（行内两步确认，同 pendingReset 模式；挂起期间同步按钮禁用） */
const pendingRemove = ref<string | null>(null)

/** 确认行文案用的源名（按 id 解析；行内确认挂起期间该源仍在列表）；迁移默认名按当前语言回落 */
function sourceName(id: string): string {
  const s = sources.value.find((x) => x.id === id)
  return s !== undefined ? displaySourceName(s.name, t) : ''
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
  sources.value.push({ id, kind: b, name: BACKEND_LABEL[b], retention: { type: 'overwrite' }, enabled: true, role: 'replica' })
  credDrafts.value[id] = blankCred(b)
  expanded.value = sources.value.length - 1
  addMenuOpen.value = false
}

/** 凭据是否空白（除 backend 外所有字段均为空串/undefined）：空白行从未持久化过 */
function isBlankCred(cred: CloudCred): boolean {
  return Object.entries(cred).every(([k, v]) => k === 'backend' || v === undefined || v === '')
}

/** 按 backend 判别的凭据守卫：模板各类型字段区经局部变量 + 守卫窄化联合（草稿 kind 与源
 *  kind 恒一致——blankCred/addTarget/loadSources 均按源 kind 造副本），替代 v-if 对联合
 *  类型无法传递的 kind 判定（credDrafts[s.id] 每次索引独立求值，模板条件不参与窄化） */
function isWebdavDraft(d: CloudCred | undefined): d is WebdavCred {
  return d?.backend === 'webdav'
}
function isS3Draft(d: CloudCred | undefined): d is S3Cred {
  return d?.backend === 's3'
}
function isGistDraft(d: CloudCred | undefined): d is GistCred {
  return d?.backend === 'gist'
}
function isGDriveDraft(d: CloudCred | undefined): d is GDriveCred {
  return d?.backend === 'gdrive'
}
function isOneDriveDraft(d: CloudCred | undefined): d is OneDriveCred {
  return d?.backend === 'onedrive'
}

/** 保留策略二选（MdSegmentedButton 选项） */
const RETENTION_OPTIONS = [
  { value: 'overwrite', label: t('cloudCard.retentionOverwrite') },
  { value: 'keep', label: t('cloudCard.retentionKeep') },
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
  pendingStates.value = pendingStates.value.filter(([k]) => k !== id)
  delete statusMap.value[id]
  delete credDrafts.value[id]
  expanded.value = expandedId !== undefined && expandedId !== null
    ? sources.value.findIndex((x) => x.id === expandedId)
    : -1
}

/** 移除入口：空白凭据源直接删（凭据从未持久化过，不需要 removeCred）；非空走行内两步确认。
 * 锁定态例外：保管区密文不可解、creds 缓存为空，卡片无法区分「从未保存过」与「保存过但缓存空」，
 * 一律走两步确认（防误删已配置源），移除后的遗留凭据由解锁装载时的孤儿对账清理（见 reconcileOrphanCreds）。 */
function askRemove(id: string): void {
  const s = sources.value.find((x) => x.id === id)
  if (!s) return
  const draft = credDrafts.value[id]
  if (props.sessionSecret && isBlankCred(draft ?? blankCred(s.kind as BackendId))) {
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
 * 未解锁 reject，此时遗留凭据由解锁装载时的孤儿对账清理，见 reconcileOrphanCreds），云端对象不受影响。
 * 持久化先于内存变更：saveSources 成功才 removeTarget，失败则内存/磁盘天然一致
 * （不会出现「内存已删、盘上仍在」的失配导致重进页面该源复活），错误经既有 fail 通道提示。
 */
async function onConfirmRemove(): Promise<void> {
  const p = props.platform
  const id = pendingRemove.value
  if (!p || !id) {
    pendingRemove.value = null
    return
  }
  const hadSavedCred = !!p.creds[id]
  try {
    await p.saveSources(sources.value.filter((x) => x.id !== id))
    removeTarget(id)
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

/** 源列表是否已从平台装载成功：孤儿对账的前置条件（loadSources 失败按空列表回落时无权威可依，绝不对账） */
const sourcesLoaded = ref(false)

/**
 * 孤儿凭据对账（审查 I5-② 兜底）：以现存源列表为唯一权威，把 creds 缓存中「无对应源」的条目
 * 逐个 removeCred 清理——覆盖锁定态移除源后遗留的已存凭据、removeCred 失败残留等场景。
 * 误删防护：仅删「确认无对应源」的条目；添加流程中的草稿 id 必在源列表内（addTarget 先入列表），
 * 且凭据只在源存在于列表时才会写入 creds，天然不入孤儿集合；源列表装载失败时不对账。
 */
async function reconcileOrphanCreds(): Promise<void> {
  const p = props.platform
  if (!p || !sourcesLoaded.value) return
  for (const id of Object.keys(p.creds)) {
    if (sources.value.some((s) => s.id === id)) continue
    try {
      await p.removeCred(id)
    } catch { /* 单条失败不阻塞其余（锁定竞态等）；下次解锁装载重新对账 */ }
  }
}

onMounted(async () => {
  const p = props.platform
  if (!p) return
  try {
    sources.value = await p.loadSources()
    sourcesLoaded.value = true
  } catch {
    sources.value = [] // 回填失败按未存源处理
  }
  for (const s of sources.value) {
    const saved = p.creds[s.id]
    credDrafts.value[s.id] = saved ? { ...saved } : blankCred(s.kind as BackendId)
  }
  void reconcileOrphanCreds() // 挂载时已解锁（creds 已装载）即对账；锁定态 creds 为空自然跳过
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
  void refreshConflictCopies() // extension 冲突副本列表回填（desktop 无此平台能力 → 恒空不渲染）
})

// 挂载后解锁（或锁定清空）：宿主 creds 为 credsCache 只读视图（getter→ref），解锁装载换新引用即触发
// 对账——锁定态移除源遗留的凭据在此被清（creds 与源列表同以解锁后最新值判定，锁定态空缓存为 no-op）
watch(() => props.platform?.creds, () => { void reconcileOrphanCreds() })

/** 草稿是否含非本机 http 明文地址（WebDAV serverUrl / S3 endpoint，其余后端无自定服务地址）：
 *  输入时即显示行内警告（可见性），保存时作为拦截条件（F11） */
function hasPlaintextUrl(d: CloudCred): boolean {
  if (isWebdavDraft(d)) return isPlaintextHttpUrl(d.serverUrl)
  if (isS3Draft(d)) return isPlaintextHttpUrl(d.endpoint ?? '')
  return false
}

/** 任一源草稿存在非本机 http 明文地址：保存按钮旁显示确认勾选框并拦截未确认的保存 */
const needsPlaintextAck = computed(() => sources.value.some((s) => {
  const d = credDrafts.value[s.id]
  return !!d && hasPlaintextUrl(d)
}))
/** 明文传输显式确认（仅卡内内存，不持久化「永久确认」）：保存成功即复位——确认按保存会话独立，再次保存需重新勾选 */
const plaintextAck = ref(false)

/**
 * 保存凭据：源元数据整列表落盘 + 逐源把编辑副本写入保管区（含禁用源——凭据与启用态独立，
 * 跳过会造成编辑静默丢失；空白凭据跳过并提示——空白行从未配置过，写入只会污染保管区）。
 * F11：存在非本机 http 明文地址且未勾选确认 → 整体拦截（不落盘任何内容），提示改用 https 或显式确认。
 */
async function onSaveCreds(): Promise<void> {
  const p = props.platform
  if (!p) return
  if (needsPlaintextAck.value && !plaintextAck.value) {
    msg.value = t('cloudCard.plaintextAckWarn')
    msgKind.value = 'err'
    return
  }
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
    msg.value = skipped > 0 ? t('cloudCard.credsSavedWithSkipped', { count: skipped }) : t('cloudCard.credsSaved')
    msgKind.value = 'ok'
    plaintextAck.value = false // per-save-session：确认不复用，下次保存重新勾选
  } catch (e) {
    fail(e)
  }
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
  if (!props.sessionSecret) return fail(new Error(t('cloudCard.setPwFirst'))) // 按钮已禁用，防御兜底
  const enabled = sources.value.filter((s) => s.enabled)
  if (enabled.length === 0) return fail(new Error(t('cloudCard.noEnabledSources')))
  busy.value = true
  msg.value = ''
  statusMap.value = {}
  try {
    const inputs: Array<{ key: string; backend: ReturnType<typeof createCloudBackend>; path: string; source: BackupSource; state: SourceSyncState }> = []
    for (const s of enabled) {
      const cred = credDrafts.value[s.id] ?? p.creds[s.id]
      if (!cred || isBlankCred(cred)) {
        statusMap.value[s.id] = t('cloudCard.missingCreds') // 锁定态缓存为空同此口径
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
        source: s,
        state: await p.loadSourceState(s.id),
      })
    }
    if (inputs.length === 0) return fail(new Error(t('cloudCard.allCredsMissing')))
    // 手动合并预览（spec §3/§4，T11F 补齐直调路径合规缺口）：先 mode:'preview' 只读跑一轮（core
    // 预览零写云/零副本/零 state 推导），任一目标 merged 时经 cloudSyncBridge 的 requestMergeConfirm
    // 挂起征询——与宿主 runner 的 onManualConfirm 桥同槽互斥，复用卡内同一 MergePreviewDialog；
    // 确认=false 中止（预览只读两端零痕迹，提示已跳过），true 以同一 inputs 重跑 apply（keep 源
    // 时间戳路径两轮一致，预览即所见即所写）。无 merged 不弹窗直接 apply。代价：手动同步恒多一轮
    // 只读预览请求，与 runner manual 通道（runOnce 'manual' 先 preview 后 apply）同构同价
    const baseOpts = {
      targets: inputs,
      vaultJson: p.readVaultJson(),
      password: props.sessionSecret,
      deviceId: await p.deviceId(),
      onConflictBackup: (key: string, bytes: Uint8Array) => p.saveConflictBackup?.(bytes, key),
      profile: p.kdfProfile?.(),
    }
    const pv = await syncMultipleTargets({ ...baseOpts, mode: 'preview' })
    const mergedResults = pv.results.filter((x) => x.outcome?.action === 'merged')
    if (mergedResults.length > 0) {
      const ok = await requestMergeConfirm({
        conflicts: pv.conflicts,
        mergeDegraded: mergedResults.some((x) => x.outcome?.mergeDegraded === true),
        sourceName: mergedResults.map((x) => sourceName(x.key)).join('; '),
      })
      if (!ok) {
        msg.value = t('cloudRunner.manualSkipped') // 复用 runner 跳过态文案（common.json 同域键）
        msgKind.value = 'hint'
        return
      }
    }
    const r = await syncMultipleTargets({ ...baseOpts, mode: 'apply' })
    resettableBackends.value = []
    pendingStates.value = []
    for (const res of r.results) {
      if (!res.outcome) {
        const errMsg = res.error ?? ''
        if (errMsg.includes('口令不匹配')) {
          // 换口令后云端为旧口令信封：专用状态 + 行内重置救济入口
          statusMap.value[res.key] = t('cloudCard.failedPassphrase')
          resettableBackends.value.push(res.key)
        } else {
          statusMap.value[res.key] = t('cloudCard.failed', { message: trunc(errMsg) })
        }
        // 失败源 rev 基线不落盘（states=原样，回写幂等）——下轮按原基线重做
        continue
      }
      statusMap.value[res.key] = ACTION_LABEL_KEY[res.outcome.action] ? t(ACTION_LABEL_KEY[res.outcome.action]!) : res.outcome.action
      if (res.convergeError) statusMap.value[res.key] += t('cloudCard.convergeFailed', { message: trunc(res.convergeError) })
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
            if (deleted > 0) statusMap.value[res.key] += t('cloudCard.retentionCleaned', { count: deleted })
            else if (deleted < 0) statusMap.value[res.key] += t('cloudCard.retentionUnsupported')
          } catch {
            statusMap.value[res.key] += t('cloudCard.retentionFailed')
          }
        }
      }
      const st = r.states[res.key]
      if (res.outcome.action === 'downloaded' || res.outcome.action === 'merged') {
        if (st) pendingStates.value.push([res.key, st]) // 采纳源基线延后至确认成功
      } else if (st) {
        await p.saveSourceState(res.key, st)
      }
    }
    if (p.loadAutoStatus) {
      try {
        autoStatus.value = await p.loadAutoStatus() // 手动完成后刷新自动状态行
      } catch { /* 状态读取失败不影响同步 */ }
    }
    void refreshConflictCopies() // 手动同步可能新增冲突副本：刷新列表（extension）
    // 跨端同步审查 I1：全部目标成功（无目标级失败/收敛失败）才算「手动同步成功」——通知宿主
    // 复位云凭据失效警示并重启跟随轮询（重新授权闭环）；部分失败（如 401 仍在）不通知，警示保留
    if (r.results.every((res) => res.outcome !== null && !res.convergeError)) {
      try {
        p.onManualSynced?.()
      } catch { /* 宿主通知失败不影响同步结果呈现 */ }
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
    for (const [key, st] of pendingStates.value) await p.saveSourceState(key, st)
    pendingAdopt.value = null
    pendingStates.value = []
    msg.value = t('cloudCard.adopted')
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
  pendingStates.value = []
  msg.value = t('cloudCard.adoptCanceled')
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
 * 确认重置（§3.2 换口令救济，T9 后走新 rev 通道）：以当前会话备份口令把本地 vault 重新加密覆盖云端
 * 该源对象（keep 源按 retention 写新时间戳文件，overwrite 源覆盖固定对象），信封带 v3 sync 头——
 * rev 从该源 lastKnownRemoteRev+1 续起（时钟单调，不因重置回退/清零），base 声明与 core 编排
 * uploaded 分支同语义（baseRev=已知远端 rev、baseContentHash=基线快照 hash，无快照回落本地内容 hash）；
 * 成功后推进该源 rev 基线（baseSnapshot=本次上传内容）。对端下轮同步见 rev 变化 → 按合并/下载路径
 * 收敛，不走旧 v2 无头信封的保守降级。busy 期间防重入。
 */
async function onConfirmReset(): Promise<void> {
  const p = props.platform
  const id = pendingReset.value
  const s = sources.value.find((x) => x.id === id)
  // 空白草稿（用户清空后未保存）回落已存凭据：与 onSync 的 isBlankCred 守护同口径，
  // 防止用空白凭据构造 backend 发请求只换来网络错
  const draft = s ? credDrafts.value[s.id] : undefined
  // p 非空先行（类型层：p 可能为 null；运行时本卡 platform null 整卡不渲染，此处不触达）
  const cred = p && s ? (draft && !isBlankCred(draft) ? draft : p.creds[s.id]) : undefined
  if (!p || !s || !cred || !props.sessionSecret) {
    pendingReset.value = null
    return
  }
  busy.value = true
  try {
    const st = await p.loadSourceState(s.id)
    const knownRev = st.lastKnownRemoteRev ?? 0
    const vaultJson = p.readVaultJson()
    await pushEnvelope({
      backend: createCloudBackend(cred),
      path: s.retention.type === 'keep' ? resolveTimestampPath(cred, new Date()) : resolveObjectPath(cred),
      vaultJson,
      password: props.sessionSecret,
      profile: p.kdfProfile?.(),
      sync: { rev: knownRev + 1, deviceId: await p.deviceId(), baseRev: knownRev, baseContentHash: await contentHash(st.baseSnapshot ?? vaultJson) },
    })
    await p.saveSourceState(s.id, {
      ...st,
      lastKnownRemoteRev: knownRev + 1,
      baseSnapshot: vaultJson,
    })
    statusMap.value[s.id] = t('cloudCard.reset')
    resettableBackends.value = resettableBackends.value.filter((x) => x !== s.id)
    pendingReset.value = null
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 以卡内最新偏好整体回写平台（每次展开完整对象，连续切换不丢字段）；回写失败走 msg 通道而非静默+未处理 rejection */
async function syncAutoPrefs(): Promise<void> {
  try {
    await props.platform?.autoPrefs.set({ ...autoPrefs.value })
  } catch (e) {
    fail(e)
  }
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
  { value: 15, label: t('cloudCard.interval15m') },
  { value: 60, label: t('cloudCard.interval1h') },
  { value: 360, label: t('cloudCard.interval6h') },
  { value: 1440, label: t('cloudCard.intervalDaily') },
]
function onIntervalChange(v: string | number): void {
  autoPrefs.value = { ...autoPrefs.value, intervalMinutes: Number(v) }
  void syncAutoPrefs()
}
/** 同 (kind, name) 组内出现重复名称才提示（审查 Minor）：同名源无法凭名称区分需改名；
 *  不同 kind 同名/各源异名均无需提示（原判定「任两源不同名即提示」与文案语义相反） */
const hasDuplicateNames = computed(() => {
  const counts = new Map<string, number>()
  for (const s of sources.value) {
    const k = `${s.kind}\n${s.name}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.values()].some((n) => n > 1)
})
</script>

<template>
  <section v-if="platform" class="card cloud">
    <h2>{{ t('cloudCard.title') }}</h2>
    <!-- T4 云凭据失效警示（自 SyncCard 归位，spec §5 ⑤）：消失途径=重新授权后手动同步成功
         （platform.onManualSynced → 宿主复位镜像）或重启宿主页——本组件只读渲染，复位在宿主 -->
    <p v-if="authFailed" class="warn" role="alert">{{ t('cloudCard.authFailed') }}</p>
    <!-- 冲突强提示区块（spec §4，T11）：条目裁决列表置顶于源行之前；无 store（popup 等宿主）或
         锁定态（store 已清空）自然隐藏。副本列表仅 extension（listConflictCopies 平台能力）渲染 -->
    <div v-if="conflictCount > 0" class="conflict-block" role="alert">
      <p class="block-title">{{ t('cloudCard.conflictTitle') }}</p>
      <p class="conflict-banner">{{ t('cloudCard.conflictBanner', { count: conflictCount }) }}</p>
      <MergeConflictList :conflicts="mergeConflicts" :disabled="resolvingConflict" @resolve="onResolveConflict" />
    </div>
    <div v-if="conflictCopies.length > 0" class="copies-block">
      <p class="block-title">{{ t('cloudCard.copiesTitle') }}</p>
      <div v-for="c in conflictCopies" :key="c.name" class="copy-row">
        <span class="copy-name">{{ c.name }}</span>
        <MdButton variant="text" class="copy-export" :aria-label="t('cloudCard.copyExportAria', { name: c.name })" @click="onExportCopy(c.name)">{{ t('cloudCard.copyExport') }}</MdButton>
      </div>
    </div>
    <div v-for="(s, i) in sources" :key="s.id" class="target">
      <div class="target-head">
        <MdSwitch v-model="s.enabled" :aria-label="t('cloudCard.ariaEnabled', { name: displaySourceName(s.name, t) })" @update:model-value="onEnabledToggled" />
        <strong>{{ displaySourceName(s.name, t) }}</strong>
        <!-- 角色互斥展示/切换（spec §2 活动目标单选）：选举 primary 时原 primary 自动降 replica -->
        <MdSegmentedButton
          class="target-role" :options="ROLE_OPTIONS" :model-value="s.role"
          :aria-label="t('cloudCard.roleAria', { name: displaySourceName(s.name, t) })"
          @update:model-value="onRoleChange(s, $event)"
        />
        <MdButton variant="text" class="target-toggle" @click="expanded = expanded === i ? -1 : i">{{ expanded === i ? t('cloudCard.collapse') : t('cloudCard.configure') }}</MdButton>
        <MdButton variant="text" danger class="target-remove" :disabled="busy || pendingAdopt !== null" @click="askRemove(s.id)">{{ t('cloudCard.remove') }}</MdButton>
      </div>
      <template v-if="expanded === i">
        <div class="fields">
          <MdTextField v-model="s.name" :label="t('cloudCard.nameLabel')" :placeholder="t('cloudCard.namePlaceholder')" :aria-label="t('cloudCard.sourceNameAria')" autocomplete="off" />
          <div class="retention-row">
            <MdSegmentedButton
              :options="RETENTION_OPTIONS" :model-value="s.retention.type" :aria-label="t('cloudCard.retentionAria')"
              @update:model-value="onRetentionType(s, $event)"
            />
            <MdTextField
              v-if="s.retention.type === 'keep'" class="keep-n"
              :model-value="String(s.retention.n)" type="number" :label="t('cloudCard.keepCountLabel')" :aria-label="t('cloudCard.keepCountLabel')"
              :disabled="busy" @update:model-value="onKeepN(s, $event)"
            />
          </div>
        </div>
        <!-- 草稿经单元素 v-for 提取局部变量 d，各类型字段区用 backend 守卫窄化联合（见 script isXxxDraft） -->
        <template v-for="d in [credDrafts[s.id]]" :key="s.id">
          <div v-if="isWebdavDraft(d)" class="fields">
            <MdTextField v-model="d.serverUrl" :label="t('cloudCard.serverUrlLabel')" :placeholder="t('cloudCard.serverUrlPlaceholder')" autocomplete="off" />
            <!-- F11：非本机 http 明文地址输入即警告（文案对齐 gist public 警告样式），保存另需显式勾选确认 -->
            <p v-if="hasPlaintextUrl(d)" class="warn" role="alert">{{ t('cloudCard.webdavPlaintextWarn') }}</p>
            <MdTextField v-model="d.username" :label="t('cloudCard.usernameLabel')" :placeholder="t('cloudCard.usernamePlaceholder')" autocomplete="off" />
            <MdTextField v-model="d.password" type="password" :label="t('cloudCard.appPasswordLabel')" :placeholder="t('cloudCard.appPasswordPlaceholder')" autocomplete="new-password" />
          </div>
          <div v-else-if="isS3Draft(d)" class="fields">
            <MdTextField v-model="d.region" label="Region" :placeholder="t('cloudCard.regionPlaceholder')" autocomplete="off" />
            <MdTextField v-model="d.bucket" label="Bucket" placeholder="Bucket" autocomplete="off" />
            <MdTextField v-model="d.accessKeyId" label="AccessKeyId" placeholder="AccessKeyId" autocomplete="off" />
            <MdTextField v-model="d.secretAccessKey" type="password" label="SecretAccessKey" placeholder="SecretAccessKey" autocomplete="new-password" />
            <!-- sessionToken/endpoint/prefix 为可选字段：undefined 以空串传 MdTextField（modelValue 要求 string），
                 展示与空串/undefined 均显示 placeholder 一致；isBlankCred 对 '' 与 undefined 同判空白 -->
            <MdTextField :model-value="d.sessionToken ?? ''" type="password" :label="t('cloudCard.stsLabel')" :placeholder="t('cloudCard.stsLabel')" autocomplete="new-password" @update:model-value="d.sessionToken = $event" />
            <MdTextField :model-value="d.endpoint ?? ''" label="Endpoint" :placeholder="t('cloudCard.endpointPlaceholder')" autocomplete="off" @update:model-value="d.endpoint = $event" />
            <!-- F11：同 WebDAV，非本机 http endpoint 明文警告（缺省 endpoint 为 AWS https 域名，不触发） -->
            <p v-if="hasPlaintextUrl(d)" class="warn" role="alert">{{ t('cloudCard.s3PlaintextWarn') }}</p>
            <MdTextField :model-value="d.prefix ?? ''" :label="t('cloudCard.prefixLabel')" :placeholder="t('cloudCard.prefixLabel')" autocomplete="off" @update:model-value="d.prefix = $event" />
            <MdCheckbox
              :model-value="!!d.forcePathStyle" :disabled="busy" :label="t('cloudCard.forcePathStyleLabel')"
              :aria-label="t('cloudCard.forcePathStyleLabel')" @update:model-value="d.forcePathStyle = $event"
            />
          </div>
          <div v-else-if="isGistDraft(d)" class="fields">
            <MdTextField v-model="d.token" type="password" label="GitHub Token" placeholder="GitHub Token" autocomplete="new-password" />
            <MdTextField v-model="d.gistId" label="Gist ID" placeholder="Gist ID" autocomplete="off" />
            <MdCheckbox
              :model-value="!!d.public" :disabled="busy" :label="t('cloudCard.gistPublicLabel')"
              :aria-label="t('cloudCard.gistPublicLabel')" @update:model-value="d.public = $event"
            />
            <p v-if="d.public" class="warn" role="alert">{{ t('cloudCard.gistPublicWarn') }}</p>
          </div>
          <div v-else-if="isGDriveDraft(d)" class="fields">
            <MdTextField v-model="d.accessToken" type="password" :label="t('cloudCard.gdriveTokenLabel')" :placeholder="t('cloudCard.gdriveTokenLabel')" autocomplete="new-password" />
          </div>
          <div v-else-if="isOneDriveDraft(d)" class="fields">
            <MdTextField v-model="d.accessToken" type="password" :label="t('cloudCard.onedriveTokenLabel')" :placeholder="t('cloudCard.onedriveTokenLabel')" autocomplete="new-password" />
          </div>
          <!-- v-if="d" 兼作类型窄化：v-for 单元素 d 在守卫链外无 undefined 窄化，vue-tsc 会报 TS18048 -->
          <MdTextField v-if="d" :model-value="d.objectPath ?? ''" :label="t('cloudCard.objectPathLabel')" :placeholder="DEFAULT_OBJECT_PATH" :aria-label="t('cloudCard.objectPathLabel')" :disabled="busy" @update:model-value="d.objectPath = $event.trim()" />
        </template>
      </template>
      <span v-if="statusFor(s.id)" class="target-status">{{ statusFor(s.id) }}</span>
      <MdButton
        v-if="resettableBackends.includes(s.id)" variant="text" danger class="cloud-reset"
        :disabled="busy || pendingAdopt !== null" @click="askReset(s.id)"
      >{{ t('cloudCard.resetCloud') }}</MdButton>
    </div>
    <div class="actions">
      <MdButton variant="text" class="target-add" aria-haspopup="menu" :aria-expanded="addMenuOpen ? 'true' : 'false'" @click="openAddMenu">{{ t('cloudCard.addSource') }}</MdButton>
      <!-- MdMenu 只在 open 时渲染；定位/Esc 关闭由组件负责，点选收起在 addTarget 内；triggerEl 供 Esc 回焦 -->
      <MdMenu :x="addMenuPos.x" :y="addMenuPos.y" :open="addMenuOpen" :trigger-el="addMenuTrigger" @close="addMenuOpen = false">
        <MdButton v-for="b in addableBackends" :key="b" variant="text" class="menu-item" @click="addTarget(b)">{{ BACKEND_LABEL[b] }}</MdButton>
      </MdMenu>
      <!-- F11：存在非本机 http 明文地址时保存前要求显式确认（勾选随保存复位，复用需重新勾选） -->
      <MdCheckbox
        v-if="needsPlaintextAck" :model-value="plaintextAck" :disabled="busy"
        :label="t('cloudCard.plaintextAckLabel')" :aria-label="t('cloudCard.plaintextAckLabel')" @update:model-value="plaintextAck = $event"
      />
      <MdButton class="creds-save" :disabled="busy" @click="onSaveCreds">{{ t('cloudCard.saveCreds') }}</MdButton>
      <MdButton class="cloud-sync" :disabled="busy || !sessionSecret || pendingAdopt !== null || pendingReset !== null || pendingRemove !== null" @click="onSync">{{ t('cloudCard.syncNow') }}</MdButton>
    </div>
    <!-- 逐源进度（spec §5 ⑥，T11）：宿主 runner onProgress 经 cloudSyncBridge 驱动；
         done<total 才显示（轮末 (total,total) 自动隐藏），自动/跟随轮与手动预览轮同样可见 -->
    <p v-if="progress !== null && progress.done < progress.total" class="sync-progress" role="status">
      <span class="spinner" aria-hidden="true" />{{ t('cloudCard.progressOf', { done: progress.done, total: progress.total }) }}
    </p>
    <p v-if="!sessionSecret" class="hint">{{ t('cloudCard.setPwHint') }}</p>
    <p v-if="hasDuplicateNames" class="hint">{{ t('cloudCard.duplicateNamesHint') }}</p>
    <div v-if="platform.autoPrefs" class="auto-block">
      <p class="hint">{{ t('cloudCard.autoHint') }}</p>
      <div class="auto-row">
        <div class="auto-item">
          <MdSwitch :model-value="autoPrefs.onChange" :aria-label="t('cloudCard.autoOnChange')" @update:model-value="onAutoOnChange" />
          <span>{{ t('cloudCard.autoOnChange') }}</span>
        </div>
        <div class="auto-item">
          <MdSwitch :model-value="autoPrefs.onInterval" :aria-label="t('cloudCard.autoInterval')" @update:model-value="onAutoIntervalToggle" />
          <span>{{ t('cloudCard.autoInterval') }}</span>
        </div>
        <div class="auto-item">
          <MdSelect
            :model-value="autoPrefs.intervalMinutes" :options="INTERVAL_OPTIONS"
            :label="t('cloudCard.intervalLabel')" :aria-label="t('cloudCard.intervalAria')" @update:model-value="onIntervalChange"
          />
        </div>
      </div>
      <span v-if="platform.loadAutoStatus" class="auto-status">{{ t('cloudCard.lastAuto', { status: autoStatus ?? t('cloudCard.none') }) }}</span>
    </div>
    <div v-if="pendingAdopt" class="confirm-row">
      <span>{{ t('cloudCard.adoptConfirm') }}</span>
      <MdButton danger :disabled="busy" @click="onConfirmAdopt">{{ t('cloudCard.adoptBtn') }}</MdButton>
      <MdButton variant="text" :disabled="busy" @click="onCancelAdopt">{{ t('cloudCard.cancel') }}</MdButton>
    </div>
    <div v-if="pendingReset" class="confirm-row reset-confirm-row">
      <span>{{ t('cloudCard.resetConfirm', { name: sourceName(pendingReset) }) }}</span>
      <MdButton danger :disabled="busy" @click="onConfirmReset">{{ t('cloudCard.confirmReset') }}</MdButton>
      <MdButton variant="text" :disabled="busy" @click="onCancelReset">{{ t('cloudCard.cancel') }}</MdButton>
    </div>
    <div v-if="pendingRemove" class="confirm-row remove-confirm-row">
      <!-- 锁定态无法立即删除保管区凭据（缓存为空不误触未解锁 reject）：如实提示改由解锁后对账清理 -->
      <span v-if="sessionSecret">{{ t('cloudCard.removeConfirmUnlocked', { name: sourceName(pendingRemove) }) }}</span>
      <span v-else>{{ t('cloudCard.removeConfirmLocked', { name: sourceName(pendingRemove) }) }}</span>
      <MdButton danger :disabled="busy" @click="onConfirmRemove">{{ t('cloudCard.confirmRemove') }}</MdButton>
      <MdButton variant="text" :disabled="busy" @click="onCancelRemove">{{ t('cloudCard.cancel') }}</MdButton>
    </div>
    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
    <!-- manual 合并预览对话框（spec §4）：槽位驱动（cloudSyncBridge 挂起征询非空即打开）；
         确认=runner 重跑 apply，取消/卸载=runner 记跳过态（预览只读，两端零痕迹） -->
    <MergePreviewDialog :open="pendingConfirm !== null" :preview="pendingConfirm?.preview ?? null" @confirm="settleMergeConfirm(true)" @cancel="settleMergeConfirm(false)" />
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
/* 冲突强提示区块（spec §4）：error 容器底色 + 顶部置位，弱感知小字升级为显眼块 */
.conflict-block { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 12px;
  background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container); }
.block-title { margin: 0; font-size: var(--md-sys-typescale-title-small); font-weight: 500; }
.conflict-banner { margin: 0; font-size: var(--md-sys-typescale-body-medium); }
.copies-block { display: flex; flex-direction: column; gap: 4px; }
.copy-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-small); }
.copy-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .8; }
/* 逐源进度行（spec §5 ⑥）：CSS spinner + 「x/y 源完成」 */
.sync-progress { display: flex; align-items: center; gap: 8px; margin: 0; font-size: var(--md-sys-typescale-body-medium); }
.spinner { width: 14px; height: 14px; border-radius: 50%; flex: none;
  border: 2px solid var(--md-sys-color-primary); border-top-color: transparent;
  animation: cloud-spin 1s linear infinite; }
@keyframes cloud-spin { to { transform: rotate(360deg); } }
</style>
