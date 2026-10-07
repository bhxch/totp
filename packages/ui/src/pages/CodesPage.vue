<script setup lang="ts">
import { buildOtpUri, defaultDigitsFor, filterByTags, getBuiltinIcons, type OtpDigits, type OtpEntry, type TagFilterMode } from '@totp/core'
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useOtpCodes } from '../composables/useOtpCodes'
import { useToast } from '../composables/useToast'
import { iconView, type IconStore } from '../iconStore'
import { fullIconsReady } from '../fullIcons'
import { searchEntries } from '../popupFilter'
import { moveToIndex, moveWithinPartition, sortEntries } from '../entriesSort'
import { createEdgeAutoScroll, findScrollHost, type ScrollHostLike } from '../edgeAutoScroll'
import type { VueStore } from '../store'
import EntryFormDialog from '../components/EntryFormDialog.vue'
import TagFilterRow from '../components/TagFilterRow.vue'
import TagManagerDialog from '../components/TagManagerDialog.vue'
import MdButton from '../components/md/MdButton.vue'
import MdCard from '../components/md/MdCard.vue'
import MdCheckbox from '../components/md/MdCheckbox.vue'
import MdFab from '../components/md/MdFab.vue'
import MdIconButton from '../components/md/MdIconButton.vue'
import MdMenu from '../components/md/MdMenu.vue'
import OtpListItem from '../components/OtpListItem.vue'
import OtpQrDialog from '../components/OtpQrDialog.vue'
import QrSheetDialog from '../components/QrSheetDialog.vue'
import SearchBar from '../components/SearchBar.vue'
import type { EntryFormData } from '../components/entryForm'

const props = withDefaults(defineProps<{
  /** 全局响应式 store（NavigationShell pageProps 按 /codes 分发） */
  store: VueStore
  /** 图标存储（stored/url dataUrl 源）；缺省时列表仅渲染 builtin 图标，EntryForm 不显示图标选择区 */
  icons?: IconStore | null
  /** [可选] 多选拼版「保存图片」实现（spec §2.5，仅 options 宿主经 NavigationShell 分发；
   *  popup 不用 CodesPage，不受影响）；未传时 Dialog 内隐藏保存按钮，仅展示 */
  saveImage?: (name: string, dataUrl: string) => Promise<boolean>
}>(), { icons: null, saveImage: undefined })

const emit = defineEmits<{ copy: [code: string]; 'open-tags': [] }>()

// D2 抽串：页面文案走 i18n（codesPage.*）
const { t } = useI18n()
// 全局 toast（P3）：模块级单例，ToastHost（宿主根组件挂载）直读同一状态渲染
const toast = useToast()

const query = ref('')
/** I49：搜 secret 开关（默认关闭，开启后过滤会包含 secret 串匹配；用户主动启用避免密钥常驻列表） */
const searchSecret = ref(false)
const editing = ref<OtpEntry | null>(null)
const creating = ref(false)
const confirmingDelete = ref<string | null>(null)
/** 标签筛选：多选集合 + any/all 模式（模式存 settings 全局共享；spec §3）。
 *  恢复持久化选中集合：按当前 tags 过滤，防止跨设备删除后盘上残留悬空 id 进入筛选（终审 Important） */
const selectedTagIds = ref<string[]>(
  props.store.settings.rememberTagFilter
    ? props.store.settings.lastTagFilterIds.filter((id) => props.store.vault.tags.some((t) => t.id === id))
    : [],
)
const tagMode = computed(() => props.store.settings.tagFilterMode)
async function setTagMode(m: TagFilterMode) {
  props.store.settings.tagFilterMode = m
  await props.store.commitSettings()
}
// rememberTagFilter 开启：选中集合持久化（popup 与管理页共享同一份）
watch(selectedTagIds, (ids) => {
  if (!props.store.settings.rememberTagFilter) return
  props.store.settings.lastTagFilterIds = [...ids]
  void props.store.commitSettings()
})
// options 端 store 初始化晚于本组件挂载，settings 首次装载后恢复持久化选中（与 popup 补偿行同型）
watch(
  () => props.store.settings.lastTagFilterIds,
  (ids) => {
    if (!props.store.settings.rememberTagFilter) return
    if (selectedTagIds.value.length > 0) return // 会话内已有选择不覆盖
    // 恢复点过滤：仅收当前 tags 存在的 id，悬空 id 不进选中集合（settings 晚装载轮）
    if (ids.length > 0) selectedTagIds.value = ids.filter((id) => props.store.vault.tags.some((t) => t.id === id))
  },
)
/** qr：单条目 otpauth 二维码（行内按钮 / 右键菜单「显示二维码」共用） */
const qrEntry = ref<OtpEntry | null>(null)
/** 标签管理弹层：chips「管理标签」触发（同时向宿主 emit open-tags 保留契约） */
const tagsOpen = ref(false)
/** 右键菜单：菜单位置、目标条目与右键所在元素（trigger 传 MdMenu 供 Esc 关闭回焦；.otp-item 有
 *  tabindex=0 可聚焦，回焦有效） */
const contextMenu = ref<{ x: number; y: number; entry: OtpEntry; trigger: HTMLElement | null } | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

/** 批量入库成功提示（P3 迁移全局 toast）：EntryFormDialog batch-added 上抛实际落库条数
 *  （剪贴板批量与粘贴 Tab 共用同一通道），入队 useToast 由宿主 ToastHost 渲染（3s 自动过期） */
function onBatchAdded(count: number) {
  creating.value = false; editing.value = null
  toast.show(t('codesPage.batchImported', { n: count }))
}
onUnmounted(() => { if (batchConfirmTimer) clearTimeout(batchConfirmTimer) })

/** 展示排序走 entriesSort 单点（R14，与 desktop MiniApp 共用；pinned 优先 → order 升序） */
const sorted = computed(() => sortEntries(props.store.vault.entries))
const { codes } = useOtpCodes(sorted)
/** EntryForm 图标数据源：builtin 全集 + store 内 stored/url dataUrl 映射。纳入 fullIconsReady
 *  依赖（2026-10-05 full-icons）：全量注册进 core 单一注册表后触发重算，非精选 builtin 引用自动补渲染 */
const entryIcons = computed(() => {
  void fullIconsReady.value // 全量注册后重算：非精选 builtin path 就位
  return { builtin: getBuiltinIcons(), stored: props.icons?.icons ?? {} }
})
/** 可见列表：搜索过滤（issuer/label/note，I49 可选 secret；谓词走 popupFilter.searchEntries 单一来源）
 *  → 标签筛选（filterByTags，any/all 模式） */
const visible = computed(() => {
  const q = query.value.trim()
  const list = q ? searchEntries(sorted.value, q, { includeSecret: searchSecret.value }) : sorted.value
  return filterByTags(list, new Set(selectedTagIds.value), props.store.settings.tagFilterMode)
})
/** 兜底：tag 被删除（管理弹层/远端同步）后从选中集合剔除；immediate 覆盖 setup 时 tags 已装载的首轮
 *  （恢复点过滤后此轮通常 no-op，防宿主时序差异漏网） */
watch(
  () => props.store.vault.tags.map((t) => t.id),
  (ids) => {
    const next = selectedTagIds.value.filter((id) => ids.includes(id))
    if (next.length !== selectedTagIds.value.length) selectedTagIds.value = next
  },
  { immediate: true },
)

async function onSave(data: EntryFormData) {
  if (editing.value) {
    // 表单已显式提交完整字段；不覆盖（用户在表单内可选的 digits/algorithm/period/counter 全部生效）。
    // digits 缺省回落 defaultDigitsFor（查 core typeProfiles：steam=5、其余=6）；number→OtpDigits 为
    // 类型口径断言：表单提交校验（steam=5、其余 6/7/8）已保证合法值——R3 起 toOtpDigits 前置收口
    // 已移除（幂等），收口统一由边界承担（addEntry 落库 / parseOtpUri 解析）
    await props.store.updateEntryOp(editing.value.uuid, {
      ...data,
      digits: (data.digits ?? defaultDigitsFor(data.type)) as OtpDigits,
    })
  } else {
    // 新建：表单未提供的字段用模型默认值；digits/algorithm/period 来自表单（type 切换时表单已自动重算）
    const { algorithm = 'SHA1', digits = defaultDigitsFor(data.type), period = 30, counter } = data
    await props.store.addEntryOp({
      ...data,
      uuid: crypto.randomUUID(),
      algorithm,
      digits: digits as OtpDigits, // 表单校验保证 5/6/7/8；落库经 vault.addEntry 边界再收口（幂等兜底）
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
/** 行内复制（单击/Enter）：取码经 emit('copy') 上抛宿主写入剪贴板（CodesPage 无 enableCopy
 *  门控，复制语义恒开启；30s 清除链挂宿主 @copy）。R3-M3：secret 非法条目 code='INVALID'
 *  （truthy，会漏过 !code 守卫）——复制字面量 "INVALID" 无意义，跳过 emit（宿主不写剪贴板、
 *  HOTP 不递增）并 error toast 说明。R3-I1：复制成败反馈上移宿主（emit 无回执），本侧不再
 *  自弹成功提示 */
async function onCopy(entry: OtpEntry) {
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  if (c === 'INVALID') {
    toast.show(t('codesPage.copyInvalid'), 'error')
    return
  }
  emit('copy', c)
  // HOTP：复制的是旧 counter 的码（RFC 语义），复制完成后再递增
  if (entry.type === 'hotp') await props.store.updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 })
}

/** 右键菜单：复制验证码 / 编辑 / 复制 URI / 删除 / 置顶切换 */
function onContextMenu(entry: OtpEntry, e: MouseEvent) {
  // currentTarget = .otp-item 根（contextmenu 监听载体），仅事件派发期可读，此处同步存元素引用
  contextMenu.value = { x: e.clientX, y: e.clientY, entry, trigger: (e.currentTarget as HTMLElement) ?? null }
}
function closeContextMenu() {
  contextMenu.value = null
}
function contextEdit(entry: OtpEntry) {
  editing.value = entry
  creating.value = false
  closeContextMenu()
}
/** 右键「复制验证码」（P3）：取当前码走与行内复制同一 emit('copy') 通道（宿主写剪贴板+30s 清除），
 *  成败反馈由宿主按写入结果 toast（R3-I1：emit 无回执，本侧弹「已复制」会在宿主写入失败时
 *  矛盾双反馈）。R3-M3：INVALID 同 onCopy 口径——error toast 不 emit（菜单关闭，操作有响应）。
 *  码未就绪时不动作（菜单保持打开）。HOTP 与行内 onCopy 同口径：
 *  复制的是旧 counter 的码（RFC 语义），emit 在前、递增在后（审查修复：右键入口此前漏递增） */
async function contextCopyCode(entry: OtpEntry) {
  const code = codes.value.get(entry.uuid)?.code
  if (!code) return
  if (code === 'INVALID') {
    toast.show(t('codesPage.copyInvalid'), 'error')
    closeContextMenu()
    return
  }
  emit('copy', code)
  if (entry.type === 'hotp') await props.store.updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 })
  closeContextMenu()
}
/** 右键「删除」（P3）：关菜单并进入行内两击确认态——显式置 confirmingDelete 并武装 3s 超时
 *  （复用 askRemove 首击语义；不经 askRemove 委托，避免确认态已挂时二次入口直接误删） */
function contextDelete(entry: OtpEntry) {
  closeContextMenu()
  confirmingDelete.value = entry.uuid
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => (confirmingDelete.value = null), 3000)
}
/** 复制 otpauth URI（与应用导入路径兼容：base32 + 算法/位数/周期/counter 全保留）。
 *  审查 I14：URI 含完整 secret 明文，剪贴板写入必须上抛 emit('copy', uri) 由宿主执行
 *  （desktop clearer 链 / options scheduleClipboardClear 均 @copy 挂清除），不得直写
 *  navigator.clipboard 绕过 30s 自动清除；与验证码复制同通道，宿主对载荷统一写剪贴板+调度清除。
 *  I1d：经 core buildOtpUri 产出（yandex → yaotp host + pin；此前手拼 otpauth://yandex/ 且丢 pin，
 *  parseOtpUri 白名单只认 yaotp——自产 URI 自己都拒收） */
function contextCopyUri(entry: OtpEntry) {
  emit('copy', buildOtpUri({
    type: entry.type, issuer: entry.issuer, label: entry.label,
    secret: entry.secret.replace(/\s+/g, ''), algorithm: entry.algorithm,
    digits: entry.digits, period: entry.period, counter: entry.counter, pin: entry.pin,
  }))
  closeContextMenu()
}
async function contextTogglePin(entry: OtpEntry) {
  await props.store.updateEntryOp(entry.uuid, { pinned: !entry.pinned })
  closeContextMenu()
}

// ---------- 选择模式（spec §2.5 多选拼版，仅 options 宿主消费）----------
/** 选择模式开关：进入即清空上次选中（会话内不跨次残留） */
const selecting = ref(false)
const selected = ref<Set<string>>(new Set())
function toggleSelectMode() {
  selecting.value = !selecting.value
  selected.value = new Set()
}
function toggleSelected(uuid: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(uuid)
  else next.delete(uuid)
  selected.value = next
}
/** 取消（操作条）：清空选中并退出选择模式 */
function cancelSelection() {
  selecting.value = false
  selected.value = new Set()
}
/** ④B 批量删除两击确认（3s 超时与单条删除同款）：确认后单 commit 批量落盘并退出选择模式 */
const confirmingBatchDelete = ref(false)
let batchConfirmTimer: ReturnType<typeof setTimeout> | null = null
async function removeSelected() {
  if (!confirmingBatchDelete.value) {
    confirmingBatchDelete.value = true
    if (batchConfirmTimer) clearTimeout(batchConfirmTimer)
    batchConfirmTimer = setTimeout(() => (confirmingBatchDelete.value = false), 3000)
    return
  }
  confirmingBatchDelete.value = false
  await props.store.removeEntriesOp([...selected.value])
  cancelSelection()
}

// ---------- ④C 拖拽排序 + 序号定位移动（全序语义：仅「非选择模式 + 无搜索/标签过滤」开放） ----------
const dragEnabled = computed(() => !selecting.value && query.value.trim() === '' && selectedTagIds.value.length === 0)
/** 悬停指示：before=落点上缘（插其前），否则下缘 */
const dragOver = ref<{ uuid: string; before: boolean } | null>(null)
let dragUuid: string | null = null
const indexEditing = ref<string | null>(null)
/** 序号编辑器聚焦宿主（真机缺陷修复）：卡片组件实例挂 ref，startIndexEdit 经 $el 查询 .index-input 聚焦 */
const editorHost = ref<{ $el?: HTMLElement } | null>(null)

// ---------- ④C pointer 长按拖拽（2026-10-06 报批方案） ----------
// 背景：WebView2 自发起的 HTML5 DnD 于原生 dragstart 后立即 abort（Task 12/e2e 双实证，
// disable_drag_drop_handler ± SetAllowExternalDrop 均无效），改用 pointer 事件零依赖实现；
// pointer 事件在浏览器宿主（扩展 options 页）同样工作，故为唯一拖拽路径（HTML5 DnD 已移除）。
const DRAG_THRESHOLD = 6
let dragStartX = 0
let dragStartY = 0
let dragEngaged = false
// R2-M5：长列表边缘自动滚动——拖拽中指针贴滚动容器上/下缘（24px 带）rAF 匀速滚动，
// 离开边缘/drop 停。宿主 pointerdown 时从把手向上解析（无滚动祖先=面板不滚，恒 no-op）
let dragScrollHost: ScrollHostLike | null = null
const edgeAutoScroll = createEdgeAutoScroll(() => dragScrollHost)

function onHandlePointerDown(e: PointerEvent, uuid: string) {
  if (!dragEnabled.value) return
  dragUuid = uuid
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragEngaged = false
  // R2-M5：解析滚动宿主（溢出的 overflow-y 祖先，NavigationShell 内容区）；jsdom 无布局 null
  dragScrollHost = findScrollHost(e.currentTarget as HTMLElement)
  // capture 失败（jsdom/旧环境无实现）降级为 window 监听，二者都注册以保证 pointermove/up 必达
  try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* 降级 */ }
  window.addEventListener('pointermove', onDragPointerMove)
  window.addEventListener('pointerup', onDragPointerUp)
  window.addEventListener('pointercancel', onDragPointerCancel)
}
function onDragPointerMove(e: PointerEvent) {
  if (dragUuid === null) return
  if (!dragEngaged && Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) < DRAG_THRESHOLD) return
  dragEngaged = true
  // R2-M5：先于落点判定更新边缘滚动（指针悬列表外但贴容器缘仍需滚动）
  edgeAutoScroll.update(e.clientY)
  const rowEl = document.elementFromPoint(e.clientX, e.clientY)?.closest('.row')
  if (!rowEl) {
    dragOver.value = null
    return
  }
  const overUuid = rowEl.getAttribute('data-uuid') || undefined
  if (!overUuid || overUuid === dragUuid) {
    dragOver.value = null
    return
  }
  const rect = rowEl.getBoundingClientRect()
  dragOver.value = { uuid: overUuid, before: e.clientY < rect.top + rect.height / 2 }
  e.preventDefault()
}
/** pointerup 落库：moveWithinPartition 求新全序（跨区返回 null 回弹不提交），单 commit reorderOp */
async function onDragPointerUp() {
  const src = dragUuid
  const over = dragOver.value
  const engaged = dragEngaged
  clearDrag()
  if (!src || !over || !engaged) return
  const entries = sorted.value
  const next = moveWithinPartition(
    entries.map((e2) => e2.uuid), src, over.uuid, over.before,
    new Set(entries.filter((e2) => e2.pinned).map((e2) => e2.uuid)),
  )
  if (next) {
    // h3 防御：落库失败（盘满/权限等）不抛断拖拽事件链，console.error 留痕（内存态已前进，宿主
    // R16⑤ 横幅接管「未保存」提示）；confirmIndexMove 同型
    try { await props.store.reorderOp(next) } catch (e) { console.error('[codes] reorder failed:', e) }
  }
}
function onDragPointerCancel() {
  clearDrag()
}
function clearDrag() {
  window.removeEventListener('pointermove', onDragPointerMove)
  window.removeEventListener('pointerup', onDragPointerUp)
  window.removeEventListener('pointercancel', onDragPointerCancel)
  edgeAutoScroll.stop() // R2-M5：drop/cancel 停边缘滚动
  dragScrollHost = null
  dragUuid = null
  dragEngaged = false
  dragOver.value = null
}
onUnmounted(clearDrag)
function startIndexEdit(uuid: string) {
  if (!dragEnabled.value) return
  indexEditing.value = uuid
  // 真机缺陷修复（2026-10-06 e2e 实测）：编辑器无聚焦逻辑——真实鼠标点击打开后焦点仍在
  // body，键入数字与 Enter 全部落空（jsdom setValue 直写掩盖）；聚焦并全选便于直接覆盖输入
  void nextTick(() => {
    const host = editorHost.value?.$el as HTMLElement | undefined
    const el = host?.querySelector<HTMLInputElement>('.index-input')
    el?.focus()
    el?.select()
  })
}
/** 序号定位移动：Enter/失焦确认（Esc 取消后的 blur 经 guard 跳过），moveToIndex 钳位后 reorderOp */
async function confirmIndexMove(uuid: string, ev: Event) {
  if (indexEditing.value !== uuid) return
  const parsed = Number.parseInt((ev.target as HTMLInputElement).value, 10)
  indexEditing.value = null
  if (!Number.isFinite(parsed)) return
  const entries = sorted.value
  const next = moveToIndex(
    entries.map((e2) => e2.uuid), uuid, parsed,
    new Set(entries.filter((e2) => e2.pinned).map((e2) => e2.uuid)),
  )
  if (next) {
    // h3 防御：同 onDrop——落库失败留痕不抛断（Enter/blur 事件链内拒绝会变成 unhandled rejection）
    try { await props.store.reorderOp(next) } catch (e) { console.error('[codes] reorder failed:', e) }
  }
}
/** 拼版 Dialog：条目取选中集合按展示顺序（pinned/order），不受当前搜索/标签过滤影响
 *  （勾选时行可见即入集合；过滤变化不隐式丢条目） */
const sheetOpen = ref(false)
const sheetEntries = computed(() => sorted.value.filter((e) => selected.value.has(e.uuid)))
function openSheet() {
  if (selected.value.size === 0) return
  sheetOpen.value = true
}
</script>

<template>
  <section class="page">
    <!-- 条目卡走 MdCard outlined(审查 F3:独立 .card 的 outline-variant/10px 与 M3 标尺双标) -->
    <MdCard ref="editorHost" class="codes-card">
      <div class="card-head">
        <h2>{{ t('codesPage.entryCount', { count: store.vault.entries.length }) }}</h2>
        <MdButton v-if="sorted.length > 0" data-test="select-mode" variant="text" @click="toggleSelectMode">
          {{ selecting ? t('codesPage.cancelSelect') : t('codesPage.select') }}
        </MdButton>
      </div>
      <!-- 冻结容器（P3）：搜索行+标签筛选行 sticky 挂滚动祖先（NavigationShell 内容区），
           列表滚动时保持可见。背景取页面同色 surface；padding-bottom 隔开与列表的贴边 -->
      <div class="frozen">
        <SearchBar v-model="query" v-model:search-secret="searchSecret" />
        <!-- 标签筛选：多选 chips + 行首逻辑符号模式切换 + 管理标签 icon 钮（均由 TagFilterRow 提供）；零标签态行仍渲染（管理钮是创建首个标签的途径） -->
        <div class="chips-row">
          <TagFilterRow
            :tags="store.vault.tags" v-model:selected-ids="selectedTagIds"
            :mode="tagMode" @update:mode="setTagMode"
            @open-manage="tagsOpen = true; emit('open-tags')"
          />
        </div>
      </div>
      <div v-if="sorted.length === 0" class="empty">{{ t('codesPage.empty') }}</div>
      <div v-else-if="visible.length === 0" class="empty">{{ t('codesPage.noMatch') }}</div>
      <div
        v-for="(e, i) in visible" :key="e.uuid" class="row" :data-uuid="e.uuid"
        :class="{ 'drag-enabled': dragEnabled, 'drag-above': dragOver?.uuid === e.uuid && dragOver.before, 'drag-below': dragOver?.uuid === e.uuid && !dragOver.before }"
        @click="closeContextMenu"
      >
        <!-- 选择模式：行首勾选框（OtpListItem 之外，点击不触发条目复制） -->
        <MdCheckbox
          v-if="selecting" class="row-check" :model-value="selected.has(e.uuid)"
          :aria-label="t('codesPage.selectEntry', { issuer: e.issuer, label: e.label })"
          @update:model-value="(v) => toggleSelected(e.uuid, v)"
        />
        <OtpListItem
          :entry="e"
          :icon="iconView(e.icon, icons ?? undefined)"
          :index="i + 1"
          v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 1 }"
          @copy="onCopy(e)"
          @qr="qrEntry = e"
          @context="(ev) => onContextMenu(e, ev)"
        >
          <!-- ④C：行首序号列宿主形态——无过滤时拖拽把手与序号并列渲染（均可见），点击序号输入目标序号移动 -->
          <template #lead>
            <span
              v-if="dragEnabled" class="handle" :title="t('codesPage.dragHandleTitle')"
              :aria-label="t('codesPage.dragHandleTitle')" @click.stop
              @pointerdown.prevent="onHandlePointerDown($event, e.uuid)"
            >⠿</span>
            <input
              v-if="indexEditing === e.uuid" class="index-input" type="number" min="1" :value="i + 1"
              :aria-label="t('codesPage.indexEditAria', { label: e.label })" @click.stop
              @keydown.enter.prevent="confirmIndexMove(e.uuid, $event)" @keydown.esc.prevent="indexEditing = null"
              @blur="confirmIndexMove(e.uuid, $event)"
            />
            <!-- 杂-I3：序号定位键盘可达——仅 dragEnabled（可交互）时声明 button 语义，
                 Enter/Space 触发与 click 同一 handler；.stop 阻断冒泡（.otp-item 根的
                 keydown.enter 会触发条目复制）。过滤态无此入口（拖拽/序号移动全序语义均禁） -->
            <span
              v-else class="index-num" :class="{ clickable: dragEnabled }"
              :title="dragEnabled ? t('codesPage.indexEditTitle') : t('codesPage.sortDisabledHint')"
              :tabindex="dragEnabled ? 0 : undefined" :role="dragEnabled ? 'button' : undefined"
              :aria-label="dragEnabled ? t('codesPage.indexNumAria', { label: e.label }) : undefined"
              @click.stop="startIndexEdit(e.uuid)"
              @keydown.enter.stop.prevent="startIndexEdit(e.uuid)"
              @keydown.space.stop.prevent="startIndexEdit(e.uuid)"
            >{{ i + 1 }}</span>
          </template>
        </OtpListItem>
        <div class="ops">
          <template v-if="confirmingDelete === e.uuid">
            <MdButton danger @click.stop="askRemove(e.uuid)">{{ t('codesPage.confirmDelete') }}</MdButton>
          </template>
          <template v-else>
            <MdIconButton :title="t('codesPage.editEntry', { label: e.label })" :aria-label="t('codesPage.editEntry', { label: e.label })" @click.stop="editing = e; creating = false">{{ t('codesPage.edit') }}</MdIconButton>
            <MdIconButton :title="t('codesPage.deleteEntry', { label: e.label })" :aria-label="t('codesPage.deleteEntry', { label: e.label })" @click.stop="askRemove(e.uuid)">{{ t('codesPage.delete') }}</MdIconButton>
          </template>
        </div>
      </div>
    </MdCard>

    <!-- 新建入口：MdFab 替代原「＋ 添加」text button，触发同一 creating 态 -->
    <MdFab class="page-fab" :aria-label="t('codesPage.addEntry')" :title="t('codesPage.addEntry')" @click="creating = true; editing = null">＋</MdFab>

    <!-- 选择模式底部浮动操作条（spec §2.5）：有选中才出现；取消=清空并退出；④B 删除两击确认 -->
    <div v-if="selected.size > 0" class="select-bar" data-test="select-bar">
      <MdButton v-if="!confirmingBatchDelete" data-test="select-delete" danger @click="removeSelected">{{ t('codesPage.deleteSelected', { count: selected.size }) }}</MdButton>
      <MdButton v-else data-test="select-delete-confirm" danger @click="removeSelected">{{ t('codesPage.confirmDelete') }}</MdButton>
      <MdButton data-test="sheet-open" @click="openSheet">{{ t('codesPage.generateQr', { count: selected.size }) }}</MdButton>
      <MdButton data-test="select-cancel" variant="text" @click="cancelSelection">{{ t('codesPage.cancel') }}</MdButton>
    </div>

    <!-- 表单对话框：编辑/新建共用（onSave 新建默认值分支保留在本页）。
         store 供智能粘贴 Tab 落库（14b）；batch-added 后关弹窗，与 @close 同口径 -->
    <EntryFormDialog
      :open="creating || editing !== null"
      :editing="editing"
      :tags="store.vault.tags"
      :create-tag="(name) => store.addTagOp(name)"
      :icons="entryIcons"
      :icon-store="icons ?? undefined"
      :store="store"
      @save="onSave"
      @close="creating = false; editing = null"
      @batch-added="onBatchAdded"
    />

    <!-- 标签管理对话框：chips「管理标签」触发 -->
    <TagManagerDialog :open="tagsOpen" :store="store" @close="tagsOpen = false" />

    <!-- 单条目 otpauth 二维码（Esc/遮罩/「关闭」按钮关闭） -->
    <OtpQrDialog :open="qrEntry !== null" :entry="qrEntry" @close="qrEntry = null" />

    <!-- 多选拼版大图（spec §2.5）：默认仅 Dialog 内展示；宿主传 saveImage 时才有「保存图片」 -->
    <QrSheetDialog :open="sheetOpen" :entries="sheetEntries" :save-image="saveImage" @close="sheetOpen = false" />

    <!-- 右键菜单：MdMenu 负责定位/越界钳制/Esc 关闭；点别处关闭（绑定在 .row @click）。
         triggerEl=右键所在条目（tabindex=0 可聚焦），Esc 关闭后焦点回该条目 -->
    <MdMenu :x="contextMenu?.x ?? 0" :y="contextMenu?.y ?? 0" :open="contextMenu !== null" :trigger-el="contextMenu?.trigger ?? null" @close="closeContextMenu">
      <template v-if="contextMenu">
        <MdButton variant="text" class="ctx-item" @click="contextCopyCode(contextMenu.entry)">{{ t('codesPage.ctxCopyCode') }}</MdButton>
        <MdButton variant="text" class="ctx-item" @click="contextEdit(contextMenu.entry)">{{ t('codesPage.edit') }}</MdButton>
        <MdButton variant="text" class="ctx-item" @click="qrEntry = contextMenu.entry; closeContextMenu()">{{ t('codesPage.showQr') }}</MdButton>
        <MdButton variant="text" class="ctx-item" @click="contextCopyUri(contextMenu.entry)">{{ t('codesPage.copyUri') }}</MdButton>
        <MdButton variant="text" class="ctx-item" @click="contextDelete(contextMenu.entry)">{{ t('codesPage.ctxDelete') }}</MdButton>
        <MdButton variant="text" class="ctx-item" @click="contextTogglePin(contextMenu.entry)">{{ contextMenu.entry.pinned ? t('codesPage.unpin') : t('codesPage.pin') }}</MdButton>
      </template>
    </MdMenu>
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; /* R5-M6：MdCard padding 16px = .frozen 两侧缝隙宽（见下） */ --frozen-bleed: 16px; }
.codes-card { display: flex; flex-direction: column; gap: 8px; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.row-check { flex: none; margin-right: 4px; }
h2 { margin: 0; font-size: var(--md-sys-typescale-title-medium); }
.chips-row { display: flex; flex-wrap: wrap; gap: 8px; }
.row { position: relative; display: flex; align-items: center; }
.row :deep(.otp-item) { flex: 1; }
/* ④C：行首把手/序号并列布局（slot 内容属本组件作用域）；把手仅无过滤时渲染。
   R2-M5：touch-action:none 屏蔽触屏滚动手势抢事件（pointermove 被浏览器滚动打断成
   pointercancel，拖拽不可用）——把手是唯一拖拽发起区，禁默认触摸行为不影响行滚动 */
.handle { cursor: grab; opacity: .6; margin-right: 2px; touch-action: none; }
.row .handle { display: none; }
.row:hover .handle, .handle:active { display: inline; }
/* 杂-I2（Task 13 修订）：hover 把手与序号并列出现、序号保持可见可点——原「hover 隐藏序号」
   规则使把手物理顶替序号，鼠标点击序号位置实际命中把手，序号输入的鼠标路径不可达（Task 12
   诊断），已撤销。行 drag-enabled class 仍随 dragEnabled 挂卸，作把手渲染的挂载点 */
/* 杂-I3：键盘聚焦序号按钮时保持可见（兜底保留：未来若再引入任何序号隐藏规则，焦点元素不被隐没） */
.row.drag-enabled .index-num:focus-visible { display: inline; }
.index-num.clickable { cursor: pointer; }
/* h1（Task 13 评审补）：过滤态序号 title 已有禁用提示，光标同步 not-allowed 作视觉禁用反馈 */
.index-num:not(.clickable) { cursor: not-allowed; }
.index-input { width: 48px; text-align: center; font-size: var(--md-sys-typescale-body-small); border: 1px solid var(--md-sys-color-outline); border-radius: 4px; background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface); }
/* ④C：拖拽悬停插入指示线 */
.row.drag-above { box-shadow: inset 0 2px 0 var(--md-sys-color-primary); }
.row.drag-below { box-shadow: inset 0 -2px 0 var(--md-sys-color-primary); }
.ops { display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.row:hover .ops, .ops:focus-within { opacity: 1; }
.empty { text-align: center; opacity: .6; padding: 16px 0; }
/* 新建 FAB：悬浮于页面右下 */
.page-fab { position: fixed; right: 24px; bottom: 24px; }
/* 冻结容器（P3）：搜索行+标签筛选行 sticky 挂滚动祖先（NavigationShell 内容区），列表滚动时保持可见。
   背景与页面同色（卡片内不突兀）；TagFilterRow 说明气泡（.mode-pop absolute z-index 10）高于本层
   z-index 5，且本层无 overflow 裁剪，气泡正常浮出。R5-M6：负 margin+padding 自补偿盖住卡片
   padding（16px，见 .page --frozen-bleed）两侧缝隙，列表内容不再从冻结条两侧穿过 */
.frozen { position: sticky; top: 0; z-index: 5; background: var(--md-sys-color-surface); padding-bottom: 4px;
  margin-inline: calc(-1 * var(--frozen-bleed, 0px)); padding-inline: var(--frozen-bleed, 0px); }
/* 选择模式底部浮动操作条（悬浮于列表上方，FAB 左侧留位） */
.select-bar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 24px; z-index: 20;
  display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 100px;
  background: var(--md-sys-color-surface-container-high); box-shadow: 0 4px 12px var(--md-sys-color-shadow); }
/* 右键菜单项（MdMenu 容器自带定位与外观；MdButton text 形收紧为菜单项排版,槽内容归本组件作用域） */
.ctx-item { display: block; width: 100%; height: 36px; justify-content: flex-start; border-radius: 0; font-size: var(--md-sys-typescale-body-medium); text-align: left; padding: 0 14px; }
</style>
