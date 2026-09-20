<script setup lang="ts">
import type { KdfProfile, Vault } from '@totp/core'
import { exportAegisEncrypted, exportAegisPlaintext, exportOtpauthText } from '@totp/core'
import { computed, onMounted, ref } from 'vue'
import type { BackupAutoPrefs, BackupPlatform, LocalSourceView } from './backupPlatform'
import { parseVaultJson } from './parseVaultJson'
import MdButton from './md/MdButton.vue'
import MdCheckbox from './md/MdCheckbox.vue'
import MdSegmentedButton from './md/MdSegmentedButton.vue'
import MdSelect from './md/MdSelect.vue'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{
  /** 平台备份实现；null 时整卡不渲染（popup 不受影响） */
  platform: BackupPlatform | null
  /** 备份内容=调用方组装的 vault JSON 快照（saveVault 同款） */
  vaultJson: string
  /** 会话备份口令（D1）：备份加密/导出用；null 时备份导出禁用，恢复走一次性口令回退 */
  sessionSecret: string | null
}>()

/** remember-secret（批① §2.3）：Aegis 加密导出勾选「记住到保管区」时上抛口令，宿主接 store.setBackupSecret(pw, true) */
const emit = defineEmits<{ 'remember-secret': [pw: string] }>()

const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')
/** 聚合全部本地源的备份文件（sourceId 供恢复定位来源目录） */
const backups = ref<Array<{ sourceId: string; name: string }>>([])

/** 已解密待确认覆盖的 vault（两步确认防误覆盖） */
const pending = ref<Vault | null>(null)

/** 恢复回退态：会话口令不可用/解密失败 → 记住来源并展开一次性口令输入 */
const showFallback = ref(false)
const fallbackPw = ref('')
const restoreReq = ref<{ kind: 'picker' | 'name'; sourceId?: string; name?: string } | null>(null)

/** 自动备份偏好（D2）：卡内编辑副本，挂载时从平台读初值；每次变更整体回写 */
const autoPrefs = ref<BackupAutoPrefs>({ onChange: false, onInterval: false, intervalMinutes: 60 })
/** 「上次自动备份」状态文本（design §4.1）：挂载时读；读不到/为空显示「暂无」 */
const autoStatus = ref<string | null>(null)

/** 备份加密强度档位（plan16 T11.5）：null=未提供或初值未载入，载入前不渲染防闪烁（同 SecurityCard lockPrefs 模式） */
const backupProfile = ref<KdfProfile | null>(null)
/** 档位三档（文案与 SecurityCard KDF_OPTIONS 同口径） */
const BACKUP_PROFILE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'fast', label: '更快（低端机友好）' },
  { value: 'balanced', label: '平衡（默认）' },
  { value: 'paranoid', label: '更慢更耐暴力破解' },
]

/** 本地源列表（plan16 §3「目录=源」；platform.listLocalSources 提供才渲染源区，extension 零影响） */
const sources = ref<LocalSourceView[]>([])
const hasSources = ref(false)
/** 「添加目录」入口（platform.pickBackupDir 提供才渲染） */
const canAddDir = ref(false)
/** 当前展开配置的源 id（同时只展开一个；null=全部收起） */
const expanded = ref<string | null>(null)
/** 待确认移除的源 id（行内两步确认防误删，沿 CloudCard askRemove 模式） */
const pendingRemove = ref<string | null>(null)

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

/** 「立即备份」= 全部启用源（宿主遍历落盘）：展示宿主返回的中文摘要；空串兜底「未配置启用目录」 */
async function onBackup(): Promise<void> {
  if (!props.sessionSecret) return // 按钮已禁用，防御兜底
  busy.value = true
  msg.value = ''
  try {
    const r = await props.platform!.createBackup(props.vaultJson, props.sessionSecret)
    msg.value = r.trim() !== '' ? r : '未配置启用目录'
    msgKind.value = 'ok'
    if (props.platform?.listBackups) await refreshList()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function onExport(): Promise<void> {
  if (!props.sessionSecret) return
  busy.value = true
  msg.value = ''
  try {
    const saved = await props.platform!.exportToFile!(props.vaultJson, props.sessionSecret)
    if (saved === false) {
      msg.value = '已取消'
      msgKind.value = 'hint'
    } else {
      msg.value = '已导出到文件'
      msgKind.value = 'ok'
    }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

// ---------- 导出格式（批① §2.3：otpauth 文本 / Aegis 明文·加密，经 platform.saveTextFile 落盘）----------
/** 四格式：totp-backup=现状加密 .totpbackup（exportToFile）；其余为文本格式（saveTextFile，宿主提供才渲染本区） */
const fmt = ref('totp-backup')
const EXPORT_FORMAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'totp-backup', label: '应用备份（.totpbackup）' },
  { value: 'otpauth-text', label: 'otpauth 文本（.txt）' },
  { value: 'aegis-plain', label: 'Aegis 明文 JSON' },
  { value: 'aegis-encrypted', label: 'Aegis 加密 JSON' },
]
/** Aegis 加密导出的独立口令（与备份口令无关，仅作用于本次导出文件） */
const encPw = ref('')
/** 「记住到保管区」：导出成功后上抛 remember-secret（宿主 setBackupSecret 落保管区） */
const remember = ref(false)
/** 两步确认挂起态：仅明文两种（otpauth-text/aegis-plain）需二次确认；加密无明文泄密风险、totp-backup 走现状，均不经确认（评审 R1） */
const exportPending = ref(false)

/** 加密导出必须先有口令；totp-backup 复用会话口令与 exportToFile 能力，缺一即禁用（评审 R1 补守卫）；busy 防重入 */
const runDisabled = computed(
  () =>
    busy.value
    || (fmt.value === 'aegis-encrypted' && encPw.value === '')
    || (fmt.value === 'totp-backup' && (!props.sessionSecret || !props.platform?.exportToFile)),
)

/** 确认行文案（评审 R1：确认行仅服务明文两种，spec §2.3 固定警示；加密导出点「导出」直接执行） */
const EXPORT_CONFIRM_TEXT = '导出为明文，任何人读取该内容即可获取全部密钥，确认继续？'

/** 切格式收起上一格式挂起的确认行 */
function onFmtChange(v: string | number): void {
  fmt.value = v as string
  exportPending.value = false
}

/** 「导出」：totp-backup 走现状 exportToFile（onExport 不动）；明文两种先进两步确认；加密免确认直接执行（评审 R1，spec §2.3 仅要求明文二次确认） */
function onExportRun(): void {
  if (fmt.value === 'totp-backup') {
    void onExport()
    return
  }
  if (fmt.value === 'aegis-encrypted') {
    void runExport()
    return
  }
  exportPending.value = true
}

/** 确认导出：按格式生成内容并调 platform.saveTextFile（false=用户取消） */
async function runExport(): Promise<void> {
  const save = props.platform?.saveTextFile
  if (!save) {
    exportPending.value = false
    return
  }
  const v = JSON.parse(props.vaultJson) as Vault
  exportPending.value = false
  busy.value = true
  msg.value = ''
  try {
    if (fmt.value === 'otpauth-text') {
      const saved = await save('totp-export.txt', exportOtpauthText(v))
      msg.value = saved ? '已导出' : '已取消'
      msgKind.value = saved ? 'ok' : 'hint'
    } else if (fmt.value === 'aegis-plain') {
      const { json, report } = exportAegisPlaintext(v)
      okWithDropped(await save('aegis-export.json', json), report)
    } else {
      const { json, report } = await exportAegisEncrypted(v, encPw.value)
      const saved = await save('aegis-export.json', json)
      // 仅真落盘才记口令：取消/写失败时不把口令存入保管区（与导出事实一致）
      if (saved && remember.value) emit('remember-secret', encPw.value)
      okWithDropped(saved, report)
    }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 文本导出反馈：取消=hint；成功时多余标签（Aegis 条目仅支持单分组，spec §2.2）随文案提示 */
function okWithDropped(saved: boolean, report: { droppedTagCount: number }): void {
  msg.value = !saved
    ? '已取消'
    : '已导出' + (report.droppedTagCount > 0 ? `（${report.droppedTagCount} 个多余标签未导出：Aegis 条目仅支持单分组）` : '')
  msgKind.value = saved ? 'ok' : 'hint'
}

async function refreshList(): Promise<void> {
  try {
    backups.value = await props.platform!.listBackups!()
  } catch {
    backups.value = []
  }
}

async function refreshSources(): Promise<void> {
  const p = props.platform
  if (!p?.listLocalSources) return
  try {
    sources.value = await p.listLocalSources()
  } catch {
    sources.value = [] // 回填失败按未存源处理
  }
}

/** 源 id 工厂：优先 crypto.randomUUID（宿主安全上下文），jsdom 等缺失环境回落时间戳+随机段 */
function newSourceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 目录显示名：末段（兼容 \ 与 / 分隔）；解析不出回落「本地备份」 */
function dirLabelOf(dir: string): string {
  return dir.split(/[\\/]/).filter((s) => s !== '').pop() ?? '本地备份'
}

/** 「添加目录」：选目录 → 以目录末段为名建源（keep 3、enabled 开）落盘并刷新列表；取消不动 */
async function onAddDir(): Promise<void> {
  const p = props.platform
  if (!p?.pickBackupDir || !p.saveLocalSource) return
  try {
    const dir = await p.pickBackupDir()
    if (dir === null) return // 用户取消
    await p.saveLocalSource({ id: newSourceId(), name: dirLabelOf(dir), dir, retention: { type: 'keep', n: 3 }, enabled: true })
    await refreshSources()
  } catch (e) {
    fail(e)
  }
}

/** 单源编辑回写：整源落盘（名称/retention/启用态共用） */
async function persistSource(s: LocalSourceView): Promise<void> {
  const p = props.platform
  if (!p?.saveLocalSource) return
  try {
    await p.saveLocalSource({ ...s })
  } catch (e) {
    fail(e)
  }
}

/** 启用开关：先改内存再回写（回写失败内存保持用户所见，错误走 msg 通道） */
function onEnabled(s: LocalSourceView, v: boolean): void {
  s.enabled = v
  void persistSource(s)
}

/** 名称编辑：update:model-value 只更新内存（逐键不落盘），change（blur/回车）落盘一次 */
function onName(s: LocalSourceView, v: string): void {
  s.name = v
}
function onNameCommit(s: LocalSourceView): void {
  void persistSource(s)
}

/** 保留策略二选（MdSegmentedButton 选项，沿 T8 CloudCard 口径） */
const RETENTION_OPTIONS = [
  { value: 'overwrite', label: '覆盖' },
  { value: 'keep', label: '保留最近' },
]
function onRetentionType(s: LocalSourceView, v: string | number): void {
  s.retention = v === 'keep' ? { type: 'keep', n: 3 } : { type: 'overwrite' }
  void persistSource(s)
}
/** keep 份数输入 → 源 retention：空串/非数字回落 3（与本地源默认一致），数字钳下限 1。
 *  update:model-value 只更新内存（逐键不落盘，同 onName），change（blur/回车）才落盘（审查 Minor） */
function onKeepN(s: LocalSourceView, v: string | number): void {
  const parsed = v === '' ? NaN : Number(v)
  s.retention = { type: 'keep', n: Number.isFinite(parsed) ? Math.max(1, Math.round(parsed)) : 3 }
}
function onKeepNCommit(s: LocalSourceView): void {
  void persistSource(s)
}

function askRemove(id: string): void {
  pendingRemove.value = id
}

function onCancelRemove(): void {
  pendingRemove.value = null
}

/** 确认移除：平台删除该源并从卡内列表移除；失败保留列表并走错误通道 */
async function onConfirmRemove(): Promise<void> {
  const p = props.platform
  const id = pendingRemove.value
  if (!p?.removeLocalSource || !id) {
    pendingRemove.value = null
    return
  }
  try {
    await p.removeLocalSource(id)
    sources.value = sources.value.filter((x) => x.id !== id)
    if (expanded.value === id) expanded.value = null
  } catch (e) {
    fail(e)
  }
  pendingRemove.value = null
}

/** 确认行文案用的源名（按 id 解析；挂起期间该源仍在列表） */
function sourceName(id: string): string {
  return sources.value.find((x) => x.id === id)?.name ?? ''
}

onMounted(() => {
  const p = props.platform
  if (!p) return
  hasSources.value = typeof p.listLocalSources === 'function'
  canAddDir.value = typeof p.pickBackupDir === 'function'
  if (hasSources.value) void refreshSources()
  if (p.listBackups) void refreshList()
  // getAutoPrefs 可能同步返回：onMounted 直接读初值（无则保留默认）
  if (p.getAutoPrefs) {
    const v = p.getAutoPrefs()
    if (v) autoPrefs.value = { ...v }
  }
  if (p.getAutoStatus) void p.getAutoStatus().then((s) => { autoStatus.value = s }).catch(() => { autoStatus.value = null })
  // 备份档位异步读初值：载入完成前不渲染（防闪烁），失败按未提供处理（档位行不渲染）
  if (p.backupKdfProfile) {
    Promise.resolve(p.backupKdfProfile.get())
      .then((v) => { backupProfile.value = v })
      .catch(() => { /* 载入失败按未提供处理 */ })
  }
})

/** 恢复统一尝试：pw=会话口令（首发）或一次性回退口令（重试）。
 *  无口令可用或解密抛错 → 记住来源并展开回退区；用户取消（null）静默返回；
 *  解密成功但内容无效 → 显示错误不进回退（内容问题不该误导为口令问题） */
async function attemptRestore(req: { kind: 'picker' | 'name'; sourceId?: string; name?: string }, pw: string | null): Promise<void> {
  const p = props.platform
  if (!p) return
  busy.value = true
  msg.value = ''
  let r: { json: string } | null = null
  let needFallback = false
  try {
    if (pw) {
      r = req.kind === 'picker' ? await p.restoreFromPicker!(pw) : await p.restoreByName!(req.sourceId!, req.name!, pw)
    } else {
      needFallback = true
    }
  } catch {
    needFallback = true
  } finally {
    busy.value = false
  }
  if (needFallback) {
    // 重试失败（回退区已展开）给明确错误；首发失败静默展开回退区即可
    const isRetry = showFallback.value
    restoreReq.value = req
    showFallback.value = true
    if (isRetry) {
      msg.value = '口令不匹配，请重试'
      msgKind.value = 'err'
    } else {
      msg.value = ''
    }
    return
  }
  if (!r) return // 用户取消了文件选择
  try {
    pending.value = parseVaultJson(r.json)
  } catch (e) {
    return fail(e)
  }
  showFallback.value = false
  fallbackPw.value = ''
  restoreReq.value = null
}

function startRestore(kind: 'picker' | 'name', sourceId?: string, name?: string): void {
  void attemptRestore({ kind, sourceId, name }, props.sessionSecret)
}

/** 回退重试：用一次性输入的口令对同一来源再解一次 */
function retryRestore(): void {
  const req = restoreReq.value
  if (!req) {
    showFallback.value = false
    return
  }
  if (!fallbackPw.value) return fail(new Error('请输入口令'))
  void attemptRestore(req, fallbackPw.value)
}

/** 恢复第 2 步：确认覆盖 → replaceAllOp */
async function confirmRestore(): Promise<void> {
  const p = props.platform
  if (!p || !pending.value) return
  busy.value = true
  try {
    await p.replaceAllOp!(pending.value)
    pending.value = null
    msg.value = '恢复成功'
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 以卡内最新偏好整体回写平台（每次展开完整对象，连续切换不丢字段） */
async function syncAutoPrefs(): Promise<void> {
  await props.platform?.setAutoPrefs?.({ ...autoPrefs.value })
}
function onAutoOnChange(v: boolean): void {
  autoPrefs.value = { ...autoPrefs.value, onChange: v }
  void syncAutoPrefs()
}
function onAutoIntervalToggle(v: boolean): void {
  autoPrefs.value = { ...autoPrefs.value, onInterval: v }
  void syncAutoPrefs()
}
/** 定时备份间隔选项（value=分钟数，number 直传回写不再经字符串转换；F6 收口换 MdSelect） */
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

/** 备份档位变更：内存即时前进 + 回写平台（后续备份/云上传 envelope 按新档位生成）；回写失败走 msg 通道而非静默 */
function onBackupProfileChange(v: string | number): void {
  const next = v as KdfProfile
  backupProfile.value = next
  Promise.resolve(props.platform?.backupKdfProfile?.set(next)).catch(fail)
}
</script>

<template>
  <section v-if="platform" class="card backup">
    <h2>备份</h2>
    <div v-if="hasSources" class="sources-block">
      <div class="sources-head">
        <span class="sources-title">本地备份目录</span>
        <MdButton v-if="canAddDir" variant="tonal" class="dir-add" :disabled="busy" @click="onAddDir">添加目录…</MdButton>
      </div>
      <p v-if="sources.length === 0" class="hint">尚无备份目录，点「添加目录」选择一个文件夹（默认源为应用数据目录）。</p>
      <div v-for="s in sources" :key="s.id" class="source">
        <div class="source-head">
          <MdSwitch :model-value="s.enabled" :aria-label="`${s.name}启用`" @update:model-value="onEnabled(s, $event)" />
          <strong class="source-name">{{ s.name }}</strong>
          <span class="source-dir">{{ s.dir ?? '默认（应用数据目录）' }}</span>
          <MdButton variant="text" class="source-toggle" @click="expanded = expanded === s.id ? null : s.id">{{ expanded === s.id ? '收起' : '配置' }}</MdButton>
          <MdButton variant="text" danger class="source-remove" :disabled="busy" @click="askRemove(s.id)">移除</MdButton>
        </div>
        <div v-if="expanded === s.id" class="source-fields">
          <MdTextField
            :model-value="s.name" label="名称" aria-label="源名称" autocomplete="off"
            @update:model-value="onName(s, $event)" @change="onNameCommit(s)"
          />
          <div class="retention-row">
            <MdSegmentedButton
              :options="RETENTION_OPTIONS" :model-value="s.retention.type" aria-label="保留策略"
              @update:model-value="onRetentionType(s, $event)"
            />
            <MdTextField
              v-if="s.retention.type === 'keep'" class="keep-n"
              :model-value="String(s.retention.n)" type="number" label="保留份数" aria-label="保留份数"
              @update:model-value="onKeepN(s, $event)" @change="onKeepNCommit(s)"
            />
          </div>
        </div>
      </div>
      <div v-if="pendingRemove" class="confirm-row remove-confirm-row">
        <span>移除备份目录「{{ sourceName(pendingRemove) }}」？目录内已备份文件不受影响。</span>
        <MdButton danger :disabled="busy" @click="onConfirmRemove">确认移除</MdButton>
        <MdButton variant="text" :disabled="busy" @click="onCancelRemove">取消</MdButton>
      </div>
    </div>
    <div class="actions">
      <MdButton class="backup-now" :disabled="busy || !sessionSecret" @click="onBackup">立即备份</MdButton>
      <MdButton v-if="platform.exportToFile" variant="tonal" :disabled="busy || !sessionSecret" @click="onExport">导出到文件</MdButton>
      <MdButton v-if="platform.restoreFromPicker" variant="tonal" :disabled="busy" @click="startRestore('picker')">从文件恢复</MdButton>
    </div>
    <!-- 导出格式区（批① §2.3）：宿主提供 saveTextFile 才渲染；明文格式经两步确认后落盘（加密免确认，评审 R1） -->
    <div v-if="platform.saveTextFile" class="export-block">
      <MdSelect
        data-test="export-format" class="export-format"
        :model-value="fmt" :options="EXPORT_FORMAT_OPTIONS"
        label="导出格式" aria-label="导出格式" @update:model-value="onFmtChange"
      />
      <div v-if="fmt === 'aegis-encrypted'" class="export-pw-row">
        <MdTextField
          data-test="export-password" class="export-pw"
          v-model="encPw" type="password" label="Aegis 导出口令" aria-label="Aegis 导出口令" autocomplete="new-password"
        />
        <MdCheckbox
          data-test="export-remember"
          v-model="remember" label="记住到保管区" aria-label="记住导出口令"
        />
      </div>
      <div>
        <MdButton data-test="export-run" variant="tonal" :disabled="runDisabled" @click="onExportRun">导出</MdButton>
      </div>
      <div v-if="exportPending" class="confirm-row export-confirm-row">
        <span>{{ EXPORT_CONFIRM_TEXT }}</span>
        <MdButton data-test="export-confirm" :disabled="busy" @click="runExport">确认导出</MdButton>
        <MdButton variant="text" :disabled="busy" @click="exportPending = false">取消</MdButton>
      </div>
      <p v-if="fmt !== 'totp-backup'" class="hint">otpauth/Aegis 为独立格式（明文或独立口令），不替代加密的应用备份。</p>
    </div>
    <p v-if="!sessionSecret" class="hint">先在上方设置备份口令。</p>
    <div v-if="showFallback" class="fallback-row">
      <MdTextField v-model="fallbackPw" class="fallback-pw" type="password" label="恢复口令" placeholder="输入该备份的口令" autocomplete="off" />
      <MdButton :disabled="busy" @click="retryRestore">重试</MdButton>
    </div>
    <ul v-if="backups.length" class="backup-list">
      <li v-for="b in backups" :key="`${b.sourceId}/${b.name}`">
        <span class="bname">{{ b.name }}</span>
        <MdButton v-if="platform.restoreByName" variant="text" :disabled="busy" @click="startRestore('name', b.sourceId, b.name)">恢复</MdButton>
      </li>
    </ul>
    <div v-if="pending" class="confirm-row">
      <span>将用备份覆盖当前全部条目？</span>
      <MdButton danger :disabled="busy" @click="confirmRestore">确认覆盖</MdButton>
      <MdButton variant="text" :disabled="busy" @click="pending = null">取消</MdButton>
    </div>
    <div v-if="platform.backupKdfProfile && backupProfile" class="profile-row">
      <MdSelect
        class="profile-select"
        :model-value="backupProfile" :options="BACKUP_PROFILE_OPTIONS"
        label="备份加密强度" aria-label="备份加密强度" @update:model-value="onBackupProfileChange"
      />
      <p class="hint">用于本地备份文件与云端同步对象的加密参数（Argon2id 强度）</p>
    </div>
    <div v-if="platform.getAutoPrefs" class="auto-block">
      <p class="hint">自动执行前会与上次内容比对，无变化则跳过写入。</p>
      <div class="auto-row">
        <div class="auto-item">
          <MdSwitch :model-value="autoPrefs.onChange" aria-label="变更后自动备份" @update:model-value="onAutoOnChange" />
          <span>变更后自动备份</span>
        </div>
        <div class="auto-item">
          <MdSwitch :model-value="autoPrefs.onInterval" aria-label="定时自动备份" @update:model-value="onAutoIntervalToggle" />
          <span>定时自动备份</span>
        </div>
        <div class="auto-item">
          <MdSelect
            :model-value="autoPrefs.intervalMinutes" :options="INTERVAL_OPTIONS"
            label="间隔" aria-label="自动备份间隔" @update:model-value="onIntervalChange"
          />
        </div>
      </div>
      <span v-if="platform.getAutoStatus" class="auto-status">上次自动备份：{{ autoStatus ?? '暂无' }}</span>
    </div>
    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供(M3 双描边裁定,2026-09-16 审查 X1);本组件只负责内容排版 */
.card { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.sources-block { display: flex; flex-direction: column; gap: 6px; }
.sources-head { display: flex; align-items: center; gap: 8px; }
.sources-title { font-size: var(--md-sys-typescale-body-medium); opacity: .85; flex: 1; }
.source { display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid var(--md-sys-color-outline-variant); padding-bottom: 6px; }
.source-head { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); flex-wrap: wrap; }
.source-name { flex-shrink: 0; }
.source-dir { flex: 1; opacity: .7; font-size: var(--md-sys-typescale-body-small); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-fields { display: flex; flex-direction: column; gap: 6px; }
.retention-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.keep-n { width: 120px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.export-block { display: flex; flex-direction: column; gap: 8px; }
.export-format { max-width: 280px; }
.export-pw-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.export-pw { max-width: 240px; }
.fallback-row { display: flex; gap: 8px; align-items: center; }
.fallback-pw { flex: 1; max-width: 240px; }
.backup-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow: auto; }
.backup-list li { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.bname { flex: 1; opacity: .8; }
.confirm-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); flex-wrap: wrap; }
.auto-block { display: flex; flex-direction: column; gap: 4px; }
.auto-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.auto-item { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.auto-status { font-size: var(--md-sys-typescale-body-small); opacity: .65; }
.profile-row { display: flex; flex-direction: column; gap: 4px; }
.profile-select { max-width: 280px; }
.ok { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); }
.err { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
.hint { opacity: .65; font-size: var(--md-sys-typescale-body-medium); margin: 0; }
</style>
