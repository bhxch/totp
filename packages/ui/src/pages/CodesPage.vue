<script setup lang="ts">
import { getBuiltinIcons, type OtpEntry } from '@totp/core'
import { computed, ref, watch } from 'vue'
import { useOtpCodes } from '../composables/useOtpCodes'
import { iconView, type IconStore } from '../iconStore'
import type { VueStore } from '../store'
import EntryFormDialog from '../components/EntryFormDialog.vue'
import GroupManagerDialog from '../components/GroupManagerDialog.vue'
import MdButton from '../components/md/MdButton.vue'
import MdChip from '../components/md/MdChip.vue'
import MdFab from '../components/md/MdFab.vue'
import MdIconButton from '../components/md/MdIconButton.vue'
import MdMenu from '../components/md/MdMenu.vue'
import OtpListItem from '../components/OtpListItem.vue'
import RevealDialog from '../components/RevealDialog.vue'
import SearchBar from '../components/SearchBar.vue'
import type { EntryFormData } from '../components/entryForm'

const props = withDefaults(defineProps<{
  /** 全局响应式 store（NavigationShell pageProps 按 /codes 分发） */
  store: VueStore
  /** 图标存储（stored/url dataUrl 源）；缺省时列表仅渲染 builtin 图标，EntryForm 不显示图标选择区 */
  icons?: IconStore | null
}>(), { icons: null })

const emit = defineEmits<{ copy: [code: string]; 'open-groups': [] }>()

const query = ref('')
/** I49：搜 secret 开关（默认关闭，开启后过滤会包含 secret 串匹配；用户主动启用避免密钥常驻列表） */
const searchSecret = ref(false)
const editing = ref<OtpEntry | null>(null)
const creating = ref(false)
const confirmingDelete = ref<string | null>(null)
/** 分组筛选：null=全部；指向已删分组的悬空 id 由 watch 兜底自动回 null */
const groupFilter = ref<string | null>(null)
/** reveal：列表点击「🔑」后弹 RevealDialog 显前 4 + 后 4（避免列表常驻明文） */
const revealing = ref<OtpEntry | null>(null)
/** 分组管理弹层：chips「管理分组」触发（同时向宿主 emit open-groups 保留 Task 9 契约） */
const groupsOpen = ref(false)
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
const { codes } = useOtpCodes(sorted)
/** EntryForm 图标数据源：builtin 全集 + store 内 stored/url dataUrl 映射 */
const entryIcons = computed(() => ({ builtin: getBuiltinIcons(), stored: props.icons?.icons ?? {} }))
/** 可见列表：搜索过滤（issuer/label/note，I49 可选 secret）→ 分组筛选（groupIds 包含判定） */
const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  let list = sorted.value
  if (q) {
    // I49：仅在用户主动开启时纳入 secret 匹配；secret 已规范为大写无空白，对输入串做同样归一化
    const qNorm = q.replace(/\s+/g, '')
    list = list.filter((e) => {
      const base = `${e.issuer} ${e.label} ${e.note ?? ''}`.toLowerCase().includes(q)
      if (base) return true
      if (searchSecret.value) return e.secret.replace(/\s+/g, '').toLowerCase().includes(qNorm)
      return false
    })
  }
  const gf = groupFilter.value
  if (gf !== null) list = list.filter((e) => e.groupIds.includes(gf))
  return list
})
/** 兜底：分组被删除（分组管理/远端同步）后 groupFilter 悬空 → 自动回「全部」 */
watch(
  () => props.store.vault.groups.map((g) => g.id),
  (ids) => { if (groupFilter.value !== null && !ids.includes(groupFilter.value)) groupFilter.value = null },
)

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
async function onCopy(entry: OtpEntry) {
  // CodesPage 无 enableCopy 门控：复制语义恒开启，剪贴板写入由宿主 @copy 决定
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  emit('copy', c)
  // HOTP：复制的是旧 counter 的码（RFC 语义），复制完成后再递增
  if (entry.type === 'hotp') await props.store.updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 })
}

/** 点击「🔑」：仅在 RevealDialog 中显示密钥（不写入剪贴板、不在列表 DOM 留明文） */
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
  <section class="page">
    <section class="card">
      <h2>条目（{{ store.vault.entries.length }}）</h2>
      <SearchBar v-model="query" v-model:search-secret="searchSecret" />
      <!-- 分组筛选 chips：全部 / 各分组（按 vault.groups 顺序）/ 管理分组（打开 GroupManagerDialog 并 emit open-groups） -->
      <div class="chips-row" role="group" aria-label="分组筛选">
        <MdChip label="全部" :selected="groupFilter === null" @click="groupFilter = null" />
        <MdChip
          v-for="g in store.vault.groups"
          :key="g.id"
          :label="g.name"
          :selected="groupFilter === g.id"
          @click="groupFilter = groupFilter === g.id ? null : g.id"
        />
        <MdChip label="管理分组" @click="groupsOpen = true; emit('open-groups')" />
      </div>
      <div v-if="sorted.length === 0" class="empty">暂无条目，点击右下「添加」录入。</div>
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
            <MdButton danger @click.stop="askRemove(e.uuid)">确认删除？</MdButton>
          </template>
          <template v-else>
            <MdIconButton :title="'编辑 ' + e.label" :aria-label="'编辑 ' + e.label" @click.stop="editing = e; creating = false">编辑</MdIconButton>
            <MdIconButton :title="'删除 ' + e.label" :aria-label="'删除 ' + e.label" @click.stop="askRemove(e.uuid)">删除</MdIconButton>
          </template>
        </div>
      </div>
    </section>

    <!-- 新建入口：MdFab 替代原「＋ 添加」text button，触发同一 creating 态 -->
    <MdFab class="page-fab" aria-label="添加条目" title="添加条目" @click="creating = true; editing = null">＋</MdFab>

    <!-- 表单对话框：编辑/新建共用（onSave 新建默认值分支保留在本页） -->
    <EntryFormDialog
      :open="creating || editing !== null"
      :editing="editing"
      :groups="store.vault.groups"
      :icons="entryIcons"
      :icon-store="icons ?? undefined"
      @save="onSave"
      @close="creating = false; editing = null"
    />

    <!-- reveal 对话框：仅在被请求时显前 4 + 后 4 形态的密钥；Esc/遮罩/「关闭」按钮关闭 -->
    <RevealDialog :open="revealing !== null" :entry="revealing" @close="closeReveal" />

    <!-- 分组管理对话框：chips「管理分组」触发 -->
    <GroupManagerDialog :open="groupsOpen" :store="store" @close="groupsOpen = false" />

    <!-- 右键菜单：MdMenu 负责定位/越界钳制/Esc 关闭；点别处关闭（绑定在 .row @click） -->
    <MdMenu :x="contextMenu?.x ?? 0" :y="contextMenu?.y ?? 0" :open="contextMenu !== null" @close="closeContextMenu">
      <template v-if="contextMenu">
        <MdButton variant="text" class="ctx-item" @click="contextEdit(contextMenu.entry)">编辑</MdButton>
        <MdButton variant="text" class="ctx-item" @click="contextCopyUri(contextMenu.entry)">复制 URI</MdButton>
        <MdButton variant="text" class="ctx-item" @click="contextTogglePin(contextMenu.entry)">{{ contextMenu.entry.pinned ? '取消置顶' : '置顶' }}</MdButton>
      </template>
    </MdMenu>
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.card { border: 1px solid var(--md-sys-color-outline-variant); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
h2 { margin: 0; font-size: var(--md-sys-typescale-title-medium); }
.chips-row { display: flex; flex-wrap: wrap; gap: 8px; }
.row { position: relative; display: flex; align-items: center; }
.row :deep(.otp-item) { flex: 1; }
.ops { display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.row:hover .ops, .ops:focus-within { opacity: 1; }
.empty { text-align: center; opacity: .6; padding: 16px 0; }
/* 新建 FAB：悬浮于页面右下 */
.page-fab { position: fixed; right: 24px; bottom: 24px; }
/* 右键菜单项（MdMenu 容器自带定位与外观；MdButton text 形收紧为菜单项排版,槽内容归本组件作用域） */
.ctx-item { display: block; width: 100%; height: 36px; justify-content: flex-start; border-radius: 0; font-size: var(--md-sys-typescale-body-medium); text-align: left; padding: 0 14px; }
</style>
