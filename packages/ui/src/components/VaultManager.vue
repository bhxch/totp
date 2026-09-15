<script setup lang="ts">
import { getBuiltinIcons, type OtpEntry } from '@totp/core'
import { computed, ref } from 'vue'
import { useOtpCodes } from '../composables/useOtpCodes'
import { iconView, type IconStore } from '../iconStore'
import type { VueStore } from '../store'
import BackupCard from './BackupCard.vue'
import CloudCard from './CloudCard.vue'
import EntryForm from './EntryForm.vue'
import ImportCard from './ImportCard.vue'
import OtpListItem from './OtpListItem.vue'
import SearchBar from './SearchBar.vue'
import SecurityCard from './SecurityCard.vue'
import SyncCard from './SyncCard.vue'
import type { BackupPlatform } from './backupPlatform'
import type { CloudPlatform } from './cloudPlatform'
import type { EntryFormData } from './entryForm'
import type { ImportPlatform, ImportSchemesApi } from './importPlatform'
import type { SecurityPlatform } from './securityPlatform'
import type { SyncPlatform } from './syncPlatform'

const props = withDefaults(defineProps<{
  store: VueStore
  /** 点击条目是否触发复制。true 时 emit('copy', code)，剪贴板写入由宿主决定；false 时仅展示 */
  enableCopy?: boolean
  /** 备份平台实现；null/缺省不渲染备份卡（popup 零影响） */
  platform?: BackupPlatform | null
  /** 安全平台实现（加密开关/换口令/剪贴板等通用设置）；null/缺省不渲染安全卡（popup 零影响） */
  securityPlatform?: SecurityPlatform | null
  /** 浏览器同步平台实现（开关/状态条）；null/缺省不渲染同步卡（desktop/popup 零影响） */
  syncPlatform?: SyncPlatform | null
  /** 云同步平台实现（五后端凭据/立即同步/冲突处理）；null/缺省不渲染云同步卡（popup 零影响） */
  cloudPlatform?: CloudPlatform | null
  /** 图标存储（stored/url dataUrl 源）；缺省时列表仅渲染 builtin 图标，EntryForm 不显示图标选择区 */
  icons?: IconStore | null
  /** 导入映射方案存取（直读写 storage SCHEMES_KEY）；缺省时 ImportCard 方案区不渲染 */
  schemesApi?: ImportSchemesApi | null
}>(), { enableCopy: false, platform: null, securityPlatform: null, syncPlatform: null, cloudPlatform: null, icons: null, schemesApi: null })

const emit = defineEmits<{ copy: [code: string] }>()

const query = ref('')
/** I49：搜 secret 开关（默认关闭，开启后过滤会包含 secret 串匹配；用户主动启用避免密钥常驻列表） */
const searchSecret = ref(false)
const editing = ref<OtpEntry | null>(null)
const creating = ref(false)
const confirmingDelete = ref<string | null>(null)
const newGroupName = ref('')
const renaming = ref<string | null>(null)
const renameValue = ref('')
/** reveal：列表点击「🔑」后弹模态显前 4 + 后 4（避免列表常驻明文） */
const revealing = ref<OtpEntry | null>(null)
/** 右键菜单：菜单位置与目标条目 */
const contextMenu = ref<{ x: number; y: number; entry: OtpEntry } | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

/** 排序：pinned 优先，然后按 order。
 *  pinned 用 truthy 检查（缺省 false），向后兼容无 pinned 字段的旧 vault */
const sorted = computed(() =>
  [...props.store.vault.entries].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return a.order - b.order
  }),
)
/** 备份内容快照（saveVault 同款 JSON）：序列化 reactive 代理以保持 computed 依赖追踪（toRaw 会丢失嵌套依赖导致快照过期） */
const vaultJson = computed(() => JSON.stringify(props.store.vault))
/** 导入平台：宿主 platform 提供了 readImportFile 才渲染导入卡（popup platform=null 零影响） */
const importPlatform = computed<ImportPlatform | null>(() => {
  const p = props.platform
  if (!p?.readImportFile) return null
  return { readImportFile: p.readImportFile, readImportFileBytes: p.readImportFileBytes, decryptDpapi: p.decryptDpapi, store: props.store }
})
const { codes } = useOtpCodes(sorted)
/** EntryForm 图标数据源：builtin 全集 + store 内 stored/url dataUrl 映射 */
const entryIcons = computed(() => ({ builtin: getBuiltinIcons(), stored: props.icons?.icons ?? {} }))
const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return sorted.value
  // I49：仅在用户主动开启时纳入 secret 匹配；secret 已规范为大写无空白，对输入串做同样归一化
  const qNorm = q.replace(/\s+/g, '')
  return sorted.value.filter((e) => {
    const base = `${e.issuer} ${e.label} ${e.note ?? ''}`.toLowerCase().includes(q)
    if (base) return true
    if (searchSecret.value) return e.secret.replace(/\s+/g, '').toLowerCase().includes(qNorm)
    return false
  })
})

async function onSave(data: EntryFormData) {
  if (editing.value) {
    // 表单已显式提交完整字段；不覆盖（用户在表单内可选的 digits/algorithm/period/counter 全部生效）
    await props.store.updateEntryOp(editing.value.uuid, data)
  } else {
    // 新建：表单未提供的字段用模型默认值；digits/algorithm/period 来自表单（type 切换时表单已自动重算）
    const { algorithm = 'SHA1', digits = data.type === 'steam' ? 5 : 6, period = 30, counter } = data
    await props.store.addEntryOp({
      ...data,
      uuid: crypto.randomUUID(),
      algorithm,
      digits,
      period,
      ...(data.type === 'hotp' && counter !== undefined ? { counter } : {}),
      order: 0,
      createdAt: Date.now(),
    })
  }
  editing.value = null; creating.value = false
}
function askRemove(uuid: string) {
  if (confirmingDelete.value === uuid) { void props.store.removeEntryOp(uuid); confirmingDelete.value = null; return }
  confirmingDelete.value = uuid
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => (confirmingDelete.value = null), 3000)
}
async function addGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  await props.store.addGroupOp(name)
  newGroupName.value = ''
}
async function onCopy(entry: OtpEntry) {
  if (!props.enableCopy) return
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  emit('copy', c)
  // HOTP：复制的是旧 counter 的码（RFC 语义），复制完成后再递增
  if (entry.type === 'hotp') await props.store.updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 })
}

/** reveal 模态：显前 4 + 后 4，中间遮蔽，避免整段密钥常驻在列表 DOM 内 */
function maskSecret(secret: string): string {
  const s = secret.replace(/\s+/g, '')
  if (s.length <= 8) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

/** 点击「🔑」：仅在 reveal 模态中显示密钥（不写入剪贴板、不在列表 DOM 留明文） */
function onReveal(entry: OtpEntry) {
  revealing.value = entry
}
function closeReveal() {
  revealing.value = null
}

/** 右键菜单：编辑 / 复制 URI / 置顶切换 */
function onContextMenu(entry: OtpEntry, e: MouseEvent) {
  contextMenu.value = { x: e.clientX, y: e.clientY, entry }
}
function closeContextMenu() {
  contextMenu.value = null
}
function contextEdit(entry: OtpEntry) {
  editing.value = entry
  creating.value = false
  closeContextMenu()
}
/** 复制 otpauth URI 到剪贴板（与应用导入路径兼容：base32 + 算法/位数/周期/counter 全保留） */
async function contextCopyUri(entry: OtpEntry) {
  const params = new URLSearchParams()
  params.set('secret', entry.secret.replace(/\s+/g, ''))
  if (entry.algorithm !== 'SHA1') params.set('algorithm', entry.algorithm)
  if (entry.digits !== 6) params.set('digits', String(entry.digits))
  if (entry.type !== 'totp' && entry.period !== 30) params.set('period', String(entry.period))
  if (entry.type === 'hotp' && typeof entry.counter === 'number') params.set('counter', String(entry.counter))
  if (entry.issuer) params.set('issuer', entry.issuer)
  const label = entry.issuer ? `${encodeURIComponent(entry.issuer)}:${encodeURIComponent(entry.label)}` : encodeURIComponent(entry.label)
  const uri = `otpauth://${entry.type}/${label}?${params.toString()}`
  try {
    await navigator.clipboard.writeText(uri)
  } catch {
    /* 剪贴板不可用时静默；用户可改用复制验证码路径 */
  }
  closeContextMenu()
}
async function contextTogglePin(entry: OtpEntry) {
  await props.store.updateEntryOp(entry.uuid, { pinned: !entry.pinned })
  closeContextMenu()
}
</script>

<template>
  <section class="card">
    <h2>分组管理</h2>
    <form class="group-add" @submit.prevent="addGroup">
      <input v-model="newGroupName" placeholder="新分组名称" />
      <button type="submit">创建分组</button>
    </form>
    <ul class="group-list">
      <li v-for="g in store.vault.groups" :key="g.id">
        <template v-if="renaming === g.id">
          <input v-model="renameValue" @keydown.enter="store.renameGroupOp(g.id, renameValue.trim() || g.name); renaming = null" />
          <button @click="store.renameGroupOp(g.id, renameValue.trim() || g.name); renaming = null">保存</button>
          <button @click="renaming = null">取消</button>
        </template>
        <template v-else>
          <span class="gname">{{ g.name }}</span>
          <span class="gcount">{{ store.vault.entries.filter((e) => e.groupIds.includes(g.id)).length }} 条</span>
          <button class="icon" :title="'编辑分组 ' + g.name" :aria-label="'编辑分组 ' + g.name" @click="renaming = g.id; renameValue = g.name">编辑</button>
          <button class="icon" :title="'删除分组 ' + g.name" :aria-label="'删除分组 ' + g.name" @click="store.removeGroupOp(g.id)">删除</button>
        </template>
      </li>
      <li v-if="store.vault.groups.length === 0" class="empty">暂无分组</li>
    </ul>
  </section>

  <section class="card">
    <h2>
      条目（{{ store.vault.entries.length }}）
      <button @click="creating = true; editing = null">＋ 添加</button>
    </h2>
    <SearchBar v-model="query" v-model:search-secret="searchSecret" />
    <EntryForm v-if="creating || editing" :key="editing?.uuid ?? 'new'" :initial="editing" :groups="store.vault.groups" :icons="entryIcons" :icon-store="icons ?? undefined" @save="onSave" @cancel="creating = false; editing = null" />
    <div v-if="sorted.length === 0" class="empty">暂无条目，点击「＋ 添加」录入。</div>
    <div v-else-if="visible.length === 0" class="empty">无匹配条目</div>
    <div v-for="e in visible" :key="e.uuid" class="row" @click="closeContextMenu">
      <OtpListItem
        :entry="e"
        :icon="iconView(e.icon, icons ?? undefined)"
        v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }"
        @copy="onCopy(e)"
        @reveal="onReveal(e)"
        @context="(ev) => onContextMenu(e, ev)"
      />
      <div class="ops">
        <template v-if="confirmingDelete === e.uuid">
          <button class="danger" @click.stop="askRemove(e.uuid)">确认删除？</button>
        </template>
        <template v-else>
          <button class="icon" :title="'编辑 ' + e.label" :aria-label="'编辑 ' + e.label" @click.stop="editing = e; creating = false">编辑</button>
          <button class="icon" :title="'删除 ' + e.label" :aria-label="'删除 ' + e.label" @click.stop="askRemove(e.uuid)">删除</button>
        </template>
      </div>
    </div>
  </section>

  <SecurityCard :platform="securityPlatform" />
  <SyncCard :platform="syncPlatform" />
  <BackupCard :platform="platform" :vault-json="vaultJson" />
  <CloudCard :platform="cloudPlatform" />
  <ImportCard :platform="importPlatform" :schemes-api="schemesApi" />

  <!-- reveal 模态：仅在被请求时显前 4 + 后 4 形态的密钥；点击遮罩或关闭按钮关闭 -->
  <div v-if="revealing" class="reveal-mask" @click="closeReveal">
    <div class="reveal-card" @click.stop>
      <h3>{{ revealing.issuer }} — 密钥</h3>
      <code class="reveal-secret">{{ maskSecret(revealing.secret) }}</code>
      <p class="reveal-hint">出于安全考虑，仅显示密钥前后各 4 位；如需完整密钥请使用编辑功能。</p>
      <button class="reveal-close" @click="closeReveal">关闭</button>
    </div>
  </div>

  <!-- 右键菜单：固定定位到 (x, y)；点别处关闭（绑定在 .row @click） -->
  <ul
    v-if="contextMenu"
    class="ctx-menu"
    :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
    @click.stop
  >
    <li><button @click="contextEdit(contextMenu.entry)">编辑</button></li>
    <li><button @click="contextCopyUri(contextMenu.entry)">复制 URI</button></li>
    <li><button @click="contextTogglePin(contextMenu.entry)">{{ contextMenu.entry.pinned ? '取消置顶' : '置顶' }}</button></li>
  </ul>
</template>

<style scoped>
h2 { font-size: 15px; display: flex; justify-content: space-between; align-items: center; }
.card { border: 1px solid var(--md-sys-color-outline-variant); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.group-add { display: flex; gap: 8px; }
.group-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.group-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.gname { font-weight: 600; } .gcount { opacity: .6; font-size: 12px; flex: 1; }
.row { position: relative; display: flex; align-items: center; }
.row :deep(.otp-item) { flex: 1; }
.ops { display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.row:hover .ops, .ops:focus-within { opacity: 1; }
.icon, .danger { border: none; background: none; cursor: pointer; padding: 4px; }
.danger { color: var(--md-sys-color-error); font-size: 12px; }
.empty { text-align: center; opacity: .6; padding: 16px 0; }
/* reveal 模态遮罩 */
.reveal-mask { position: fixed; inset: 0; background: color-mix(in srgb, var(--md-sys-color-scrim) 55%, transparent); display: grid; place-items: center; z-index: 1000; }
.reveal-card { background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface); padding: 20px 24px; border-radius: 10px; max-width: 360px; width: 90%; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 4px 24px color-mix(in srgb, var(--md-sys-color-shadow) 25%, transparent); }
.reveal-secret { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: 1px; background: var(--md-sys-color-surface-container-highest); padding: 10px; border-radius: 6px; text-align: center; word-break: break-all; }
.reveal-hint { font-size: 12px; opacity: .65; margin: 0; }
.reveal-close { align-self: flex-end; }
/* 右键菜单 */
.ctx-menu { position: fixed; z-index: 1001; list-style: none; margin: 0; padding: 4px 0; background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 6px; box-shadow: 0 2px 12px color-mix(in srgb, var(--md-sys-color-shadow) 18%, transparent); min-width: 120px; }
.ctx-menu li button { display: block; width: 100%; padding: 6px 14px; border: none; background: none; text-align: left; cursor: pointer; font-size: 13px; }
.ctx-menu li button:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
</style>
