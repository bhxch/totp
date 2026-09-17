<script setup lang="ts">
import type { Vault } from '@totp/core'
import { onMounted, ref, watch } from 'vue'
import type { BackupAutoPrefs, BackupMode, BackupPlatform } from './backupPlatform'
import { parseVaultJson } from './parseVaultJson'
import MdButton from './md/MdButton.vue'
import MdSegmentedButton from './md/MdSegmentedButton.vue'
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

const busy = ref(false)
const msg = ref('')
const msgKind = ref<'ok' | 'err' | 'hint'>('ok')
const backups = ref<Array<{ name: string }>>([])

/** 已解密待确认覆盖的 vault（两步确认防误覆盖） */
const pending = ref<Vault | null>(null)

/** 恢复回退态：会话口令不可用/解密失败 → 记住来源并展开一次性口令输入 */
const showFallback = ref(false)
const fallbackPw = ref('')
const restoreReq = ref<{ kind: 'picker' | 'name'; name?: string } | null>(null)

/** 自动备份偏好（D2）：卡内编辑副本，挂载时从平台读初值；每次变更整体回写 */
const autoPrefs = ref<BackupAutoPrefs>({ onChange: false, onInterval: false, intervalMinutes: 60 })
/** 「上次自动备份」状态文本（design §4.1）：挂载时读；读不到/为空显示「暂无」 */
const autoStatus = ref<string | null>(null)
/** 当前备份目录；null=默认（应用数据目录） */
const backupDir = ref<string | null>(null)

function fail(e: unknown): void {
  msg.value = e instanceof Error ? e.message : String(e)
  msgKind.value = 'err'
}

async function onBackup(): Promise<void> {
  if (!props.sessionSecret) return // 按钮已禁用，防御兜底
  busy.value = true
  msg.value = ''
  try {
    const r = await props.platform!.createBackup(props.vaultJson, props.sessionSecret)
    msg.value = r === 'overwritten' ? '备份成功（覆盖）' : '备份成功（新文件）'
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

async function setMode(m: BackupMode): Promise<void> {
  await props.platform?.setMode(m)
}

/** F5（审查挂账收口）：备份模式二选一以 MdSegmentedButton 呈现，替代原生 radio */
const MODE_OPTIONS = [
  { value: 'keep', label: '保留最近' },
  { value: 'overwrite', label: '覆盖单一文件' },
] as const

/** I70：本地 keepN 副本——keep 模式时与平台同步；切到 overwrite 后保留前值，再切回 keep 时恢复。
 *  避免 keep→overwrite→keep 时丢失用户已配的 N */
const keepN = ref<number>(
  props.platform?.mode.type === 'keep' ? props.platform.mode.n : 3,
)
/** 监听平台模式：keep 时把最新 n 同步进本地；overwrite 不动 */
watch(() => props.platform?.mode, (m) => {
  if (m?.type === 'keep') keepN.value = m.n
})

async function onNChange(value: string): Promise<void> {
  const n = Math.max(1, Math.floor(Number(value) || 1))
  await setMode({ type: 'keep', n })
}

/** 分段选择值 → BackupMode：keep 用本地 keepN（保留用户配置），overwrite 无参——与原 radio change 语义等价 */
async function onModeSelect(v: string): Promise<void> {
  await setMode(v === 'overwrite' ? { type: 'overwrite' } : { type: 'keep', n: keepN.value })
}

async function refreshList(): Promise<void> {
  try {
    backups.value = await props.platform!.listBackups!()
  } catch {
    backups.value = []
  }
}
onMounted(() => {
  const p = props.platform
  if (!p) return
  if (p.listBackups) void refreshList()
  // getAutoPrefs 可能同步返回：onMounted 直接读初值（无则保留默认）
  if (p.getAutoPrefs) {
    const v = p.getAutoPrefs()
    if (v) autoPrefs.value = { ...v }
  }
  if (p.getBackupDir) void p.getBackupDir().then((d) => { backupDir.value = d })
  if (p.getAutoStatus) void p.getAutoStatus().then((s) => { autoStatus.value = s }).catch(() => { autoStatus.value = null })
})

/** 恢复统一尝试：pw=会话口令（首发）或一次性回退口令（重试）。
 *  无口令可用或解密抛错 → 记住来源并展开回退区；用户取消（null）静默返回；
 *  解密成功但内容无效 → 显示错误不进回退（内容问题不该误导为口令问题） */
async function attemptRestore(req: { kind: 'picker' | 'name'; name?: string }, pw: string | null): Promise<void> {
  const p = props.platform
  if (!p) return
  busy.value = true
  msg.value = ''
  let r: { json: string } | null = null
  let needFallback = false
  try {
    if (pw) {
      r = req.kind === 'picker' ? await p.restoreFromPicker!(pw) : await p.restoreByName!(req.name!, pw)
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

function startRestore(kind: 'picker' | 'name', name?: string): void {
  void attemptRestore({ kind, name }, props.sessionSecret)
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
function onIntervalChange(e: Event): void {
  autoPrefs.value = { ...autoPrefs.value, intervalMinutes: Number((e.target as HTMLSelectElement).value) }
  void syncAutoPrefs()
}

async function onChangeDir(): Promise<void> {
  const p = props.platform
  if (!p?.pickBackupDir) return
  const dir = await p.pickBackupDir()
  if (dir === null) return // 用户取消
  await p.setBackupDir!(dir)
  backupDir.value = dir
}

async function onResetDir(): Promise<void> {
  const p = props.platform
  if (!p?.setBackupDir) return
  await p.setBackupDir(null)
  backupDir.value = null
}
</script>

<template>
  <section v-if="platform" class="card backup">
    <h2>备份</h2>
    <div class="modes">
      <MdSegmentedButton
        aria-label="备份模式"
        :model-value="platform.mode.type" :options="MODE_OPTIONS"
        @update:model-value="onModeSelect"
      />
      <MdTextField
        v-if="platform.mode.type === 'keep'" class="keep-n" type="number" label="份数" aria-label="保留份数"
        min="1" :model-value="String(platform.mode.n)" @update:model-value="onNChange"
      />
      <span v-if="platform.mode.type === 'keep'" class="unit">份</span>
    </div>
    <div class="actions">
      <MdButton class="backup-now" :disabled="busy || !sessionSecret" @click="onBackup">立即备份</MdButton>
      <MdButton v-if="platform.exportToFile" variant="tonal" :disabled="busy || !sessionSecret" @click="onExport">导出到文件</MdButton>
      <MdButton v-if="platform.restoreFromPicker" variant="tonal" :disabled="busy" @click="startRestore('picker')">从文件恢复</MdButton>
    </div>
    <p v-if="!sessionSecret" class="hint">先在上方设置备份口令。</p>
    <div v-if="showFallback" class="fallback-row">
      <MdTextField v-model="fallbackPw" class="fallback-pw" type="password" label="恢复口令" placeholder="输入该备份的口令" autocomplete="off" />
      <MdButton :disabled="busy" @click="retryRestore">重试</MdButton>
    </div>
    <ul v-if="backups.length" class="backup-list">
      <li v-for="b in backups" :key="b.name">
        <span class="bname">{{ b.name }}</span>
        <MdButton v-if="platform.restoreByName" variant="text" :disabled="busy" @click="startRestore('name', b.name)">恢复</MdButton>
      </li>
    </ul>
    <div v-if="pending" class="confirm-row">
      <span>将用备份覆盖当前全部条目？</span>
      <MdButton danger :disabled="busy" @click="confirmRestore">确认覆盖</MdButton>
      <MdButton variant="text" :disabled="busy" @click="pending = null">取消</MdButton>
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
          <span>间隔</span>
          <select
            class="interval" :value="autoPrefs.intervalMinutes" aria-label="自动备份间隔"
            @change="onIntervalChange"
          >
            <option :value="15">15 分钟</option>
            <option :value="60">1 小时</option>
            <option :value="360">6 小时</option>
            <option :value="1440">每天</option>
          </select>
        </div>
      </div>
      <span v-if="platform.getAutoStatus" class="auto-status">上次自动备份：{{ autoStatus ?? '暂无' }}</span>
    </div>
    <div v-if="platform.getBackupDir" class="dir-row">
      <span class="dir-value">备份目录：{{ backupDir ?? '默认（应用数据目录）' }}</span>
      <MdButton variant="tonal" :disabled="busy" @click="onChangeDir">更改…</MdButton>
      <MdButton variant="text" :disabled="busy" @click="onResetDir">恢复默认</MdButton>
    </div>
    <div v-if="msg" :class="msgKind" role="status">{{ msg }}</div>
  </section>
</template>

<style scoped>
/* 卡片边界由外层 MdCard outlined 统一提供(M3 双描边裁定,2026-09-16 审查 X1);本组件只负责内容排版 */
.card { display: flex; flex-direction: column; gap: 8px; }
h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.modes { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.keep-n { width: 90px; }
.unit { font-size: var(--md-sys-typescale-body-medium); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.fallback-row { display: flex; gap: 8px; align-items: center; }
.fallback-pw { flex: 1; max-width: 240px; }
.backup-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow: auto; }
.backup-list li { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.bname { flex: 1; opacity: .8; }
.confirm-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.auto-block { display: flex; flex-direction: column; gap: 4px; }
.auto-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.auto-item { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-medium); }
.auto-status { font-size: var(--md-sys-typescale-body-small); opacity: .65; }
.interval { height: 32px; border-radius: 8px; border: 1px solid var(--md-sys-color-outline); background: transparent; color: inherit; font: inherit; font-size: var(--md-sys-typescale-body-medium); padding: 0 6px; }
.dir-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dir-value { font-size: var(--md-sys-typescale-body-medium); opacity: .85; }
.ok { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); }
.err { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
.hint { opacity: .65; font-size: var(--md-sys-typescale-body-medium); margin: 0; }
</style>
