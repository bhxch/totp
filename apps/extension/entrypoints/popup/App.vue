<script setup lang="ts">
import { buildOtpUri, getBuiltinIcons, toOtpDigits, type OtpEntry, type TagFilterMode } from '@totp/core'
import { BatchPastePanel, CLIPBOARD_CLEAR_DELAY_MS, createIconStore, EntryForm, iconView, LockScreen, MdCheckbox, MdIconButton, MdSegmentedButton, NAV_ICONS, normalizeExtOtpauth, OtpListItem, OtpQrDialog, parseUriToEntryData, resolvePopupVisible, SearchBar, TagFilterRow, useOtpCodes, useTheme, type EntryFormData } from '@totp/ui'
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PENDING_OTPAUTH_KEY } from '../../src/pendingOtpauth'
import { canOffscreen, ext } from '../../src/extApi'
import { createExtensionCloudRunner } from '../../src/cloudRunnerFactory'
import { createSyncScheduler } from '../../src/syncScheduler'
import { storageAdapter } from '../../src/store'
import {
  addEntryOp, addTagOp, commitSettings, initStore, locked, registerStorageSync, removeEntryOp, settings, store, updateEntryOp, vault,
} from '../../src/store'

const icons = createIconStore(storageAdapter)

// D2 抽串：popup 壳层文案走 i18n（popup.*）。i18n 插件由 main.ts 在 mount 前同步装入，useI18n 可用
const { t } = useI18n()

// ---------- 跟随拉取（跨端同步 T2）：popup 打开时/解锁时单次拉取云端更新，不轮询 ----------
// runner 工厂与 options 共用（cloudRunnerFactory），差异仅 i18n 注入（useI18n t 的包装同签名）。
// 锁定态零网络：syncScheduler gate（isUnlocked && autoFollowEnabled）+ runner 内部 isLocked 守护双保险
const cloudSync = createExtensionCloudRunner({ store, t: (key, params = {}) => t(key, params) })
const syncFollow = createSyncScheduler({
  isUnlocked: () => !locked.value,
  onUnlocked: (cb) => watch(locked, (v) => { if (!v) cb() }),
  // 跨端同步审查 C1：跟随走 pull-only 通道（下载后远端 hash 基线去重，零上传零副本）；
  // 旧实现走全量推拉 run()，本地零变化也每次打开重写云端（密文随机 IV 恒判本地较新）
  runPull: () => cloudSync.run('pull'),
  autoFollowEnabled: () => settings.syncPrefs.autoFollow !== false, // T3 开关（设置页通用卡）
  intervalMs: () => null, // popup 不轮询
  onError: (e) => console.warn('[syncFollow]', e),
  // T4：popup 无常驻 UI 通道，仅留痕（scheduler 内部已置位停动作资格）；options 经 SyncCard 渲染警示
  onAuthFailed: () => console.warn('[syncFollow] 云凭据失效（401/403），自动跟随已暂停'),
})
// 启动跟随（解锁边沿由 start 内钩子承接，仅覆盖「锁定态打开→用户输口令」的 true→false 翻转）。
// 首拉不放此处（终审修复）：mount 时刻 store 未 init，backupSecret 恒 null（仅 applyDekAndUnlock
// 装载）——立即 syncNow 必走 runner noSecret 早退写伪 cloudAutoStatus；且 session DEK 恢复路径
// locked 全程 false（initStore 直进解锁，无 true→false 边沿），watch(locked) 钩子捕获不到，
// 首拉在下方 async onMounted 的 initStore 完成后显式执行
onMounted(() => {
  syncFollow.start()
})
onScopeDispose(() => syncFollow.stop())

/** 设置深链:直达 options 的 /settings 页(hash 路由);openOptionsPage 不支持 hash 故用 tabs.create */
const SETTINGS_ICON_PATH = NAV_ICONS.settings
function openSettings(): void {
  void ext!.tabs.create({ url: ext!.runtime.getURL('options.html#/settings') })
}

const loaded = ref(false)
const error = ref('')
const query = ref('')
const tabUrl = ref<string | null>(null)

onMounted(async () => {
  try {
    await initStore()
    // 打开即跟随一次（终审修复：首拉在 initStore 完成后——DEK/会话口令已就位，加密库解锁态
    // 可真实拉取；锁定/关开关被 syncScheduler gate 拦截（gate 先于 runner，零写盘），前者
    // 等解锁边沿钩子承接。initStore 失败走 catch 不拉取（store 未就绪无意义））
    void syncFollow.syncNow()
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(store)
    registerStorageSync()
    // 恢复持久化选中集合：按当前 tags 过滤，防止跨设备删除后盘上残留悬空 id 进入筛选
    // （all 模式误报空列表 / any 模式常驻并被持久化 watch 写回盘上）；initStore 已 await 完成，
    // vault.tags 此刻确定已装载，过滤是确定性的。仅在确有有效选中时赋值：空→空赋值也会触发持久化
    // watch，省去一次冗余 settings 落盘
    if (settings.rememberTagFilter) {
      const valid = new Set(vault.tags.map((t) => t.id))
      const restored = settings.lastTagFilterIds.filter((id) => valid.has(id))
      if (restored.length > 0) selectedTagIds.value = restored
    }
    await icons.init()
  } catch (e) {
    error.value = t('popup.readError', { message: e instanceof Error ? e.message : String(e) })
  } finally {
    loaded.value = true
  }
  // 协议回调（?uri=）/右键菜单（pendingOtpauth）导入预填，不阻塞后续标签页 URL 读取
  void consumePendingOtpauth()
  try {
    const [tab] = await ext!.tabs.query({ active: true, currentWindow: true })
    if (tab?.url?.startsWith('http')) tabUrl.value = tab.url
  } catch (e) {
    console.warn('[popup] 无法读取当前标签页 URL:', e)
    // 读不到标签页 URL（如非扩展环境）时 tabUrl 保持 null，不过滤
  }
})

const sorted = computed(() =>
  [...vault.entries].sort((a, b) => {
    // 置顶优先（右键菜单「置顶」生效位）；pinned 用 truthy 检查兼容无该字段的旧 vault
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return a.order - b.order
  }),
)
const { codes } = useOtpCodes(sorted)
/** EntryForm 图标数据源：builtin 全集 + store 内 stored/url dataUrl 映射 */
const entryIcons = computed(() => ({ builtin: getBuiltinIcons(), stored: icons.icons }))

const filterOn = computed(() => settings.urlFilterEnabled)
/** 标签筛选选中态：rememberTagFilter 开启时自 settings 恢复并回写（spec §3） */
const selectedTagIds = ref<string[]>(settings.rememberTagFilter ? [...settings.lastTagFilterIds] : [])
const tagMode = computed(() => settings.tagFilterMode)
async function setTagMode(m: TagFilterMode) {
  settings.tagFilterMode = m
  await commitSettings()
}
watch(selectedTagIds, (ids) => {
  if (!settings.rememberTagFilter) return
  settings.lastTagFilterIds = [...ids]
  void commitSettings()
})
// 悬空 tag 清理：tag 被删/同步变更后从选中集合剔除（联动持久化 watch 一并落盘）；
// immediate 兜底覆盖补偿恢复前 tags 已装载的首轮（恢复点过滤后通常 no-op）
watch(
  () => vault.tags.map((t) => t.id),
  (ids) => {
    const next = selectedTagIds.value.filter((id) => ids.includes(id))
    if (next.length !== selectedTagIds.value.length) selectedTagIds.value = next
  },
  { immediate: true },
)

/** 四级回退链（spec §3）：搜索 → tag → URL 分级放宽；tabUrl 仅 http(s)（onMounted 既有判定） */
const filterResult = computed(() => resolvePopupVisible({
  entries: sorted.value,
  query: query.value,
  selectedTagIds: new Set(selectedTagIds.value),
  tagMode: settings.tagFilterMode,
  urlFilterActive: filterOn.value && !!tabUrl.value,
  tabUrl: tabUrl.value,
}))
const visible = computed(() => filterResult.value.visible)
const toggleFilter = async () => {
  settings.urlFilterEnabled = !settings.urlFilterEnabled
  await commitSettings()
}

const editing = ref<OtpEntry | null>(null)
const creating = ref(false)
const confirmingDelete = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

// ---------- 右键菜单（spec §10：编辑 / 复制 URI / 置顶） ----------
/** qr：单条目 otpauth 二维码（行内按钮 / 右键菜单「显示二维码」共用） */
const qrEntry = ref<OtpEntry | null>(null)
/** 右键菜单：菜单位置与目标条目 */
const contextMenu = ref<{ x: number; y: number; entry: OtpEntry } | null>(null)

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
async function contextCopyUri(entry: OtpEntry) {
  // I1d：经 core buildOtpUri 产出（yandex → yaotp host + pin；此前手拼 otpauth://yandex/ 且丢 pin，
  // parseOtpUri 白名单只认 yaotp——自产 URI 自己都拒收）
  try {
    await navigator.clipboard.writeText(buildOtpUri({
      type: entry.type, issuer: entry.issuer, label: entry.label,
      secret: entry.secret.replace(/\s+/g, ''), algorithm: entry.algorithm,
      digits: entry.digits, period: entry.period, counter: entry.counter, pin: entry.pin,
    }))
    scheduleClipboardClear()
    copied.value = true
  } catch {
    /* 剪贴板不可用时静默 */
  }
  closeContextMenu()
}
async function contextTogglePin(entry: OtpEntry) {
  await updateEntryOp(entry.uuid, { pinned: !entry.pinned })
  closeContextMenu()
}

// ---------- otpauth URI 导入预填（粘贴框 / 协议回调 / 右键菜单共用） ----------
const otpauthUri = ref('')
const importError = ref('')
/** 粘贴框开合经 open ref 绑定：@toggle 同步手动开合；导入成功自动收起 */
const importOpen = ref(false)
function onImportToggle(e: Event) {
  importOpen.value = (e.target as HTMLDetailsElement).open
}
/** 导入预填对象（OtpEntry 形状，uuid/order/createdAt 为哑值）；与 editing 并存时导入预填优先 */
const prefill = ref<OtpEntry | null>(null)
/** 每次导入自增，驱动 EntryForm 重挂载以刷新预填 */
const formKey = ref(0)

/** URI → 表单预填；成功返回 null（并清除既有错误提示、收起粘贴框），失败返回中文错误消息（供粘贴框与后台入口共用） */
function applyOtpauthPrefill(uri: string): string | null {
  const r = parseUriToEntryData(uri.trim())
  if ('error' in r) return r.error
  importError.value = ''
  importOpen.value = false
  editing.value = null
  prefill.value = r.data
  creating.value = true
  // creating 已 true 时下方 creating watch 不触发（粘贴 Tab 激活态点「导入」正是此场景）：
  // 显式切回手动，保证预填必然落在可见的 EntryForm 上而非被 BatchPastePanel 挡住
  formTab.value = 'manual'
  formKey.value++
  return null
}

function importOtpauth() {
  const err = applyOtpauthPrefill(otpauthUri.value)
  if (err) importError.value = err
  else otpauthUri.value = ''
}

/**
 * 后台导入入口：popup URL 带 ?uri=（Firefox ext+otpauth 协议回调）或 local `pendingOtpauth`
 * （Chrome 右键菜单写入，读取即清除）→ 预填；非法 URI 报错提示
 */
async function consumePendingOtpauth(): Promise<void> {
  let uri = ''
  try {
    uri = new URLSearchParams(window.location.search).get('uri')?.trim() ?? ''
  } catch { /* 无 location 场景忽略 */ }
  if (!uri) {
    try {
      const got = await ext!.storage.local.get(PENDING_OTPAUTH_KEY)
      uri = typeof got[PENDING_OTPAUTH_KEY] === 'string' ? got[PENDING_OTPAUTH_KEY].trim() : ''
      if (uri) await ext!.storage.local.remove(PENDING_OTPAUTH_KEY)
    } catch { /* 扩展上下文不可用（如纯浏览器调试）忽略 */ }
  }
  if (!uri) return
  const err = applyOtpauthPrefill(normalizeExtOtpauth(uri))
  if (err) importError.value = err
}

function startCreate() {
  editing.value = null
  prefill.value = null
  creating.value = true
}

function closeForm() {
  editing.value = null
  creating.value = false
  prefill.value = null
  importError.value = ''
}

/** 14c 新建表单双 Tab：manual=原内联 EntryForm（行为不动）/ paste=BatchPastePanel；仅 creating 显 Tab（编辑保持纯手动） */
const formTab = ref<'manual' | 'paste'>('manual')
// computed：locale 切换后 Tab 文案联动
const FORM_TAB_OPTIONS = computed(() => [
  { value: 'manual', label: t('popup.tabManual') },
  { value: 'paste', label: t('popup.tabPaste') },
])
// 进入新建（startCreate，creating false→true）回默认「手动填写」；applyOtpauthPrefill 路径
// （creating 已 true，watch 不触发）在其函数体内显式复位
watch(creating, (v) => { if (v) formTab.value = 'manual' })

/** 智能粘贴落库完成 → 关表单回列表（新增条目立即可见），语义同 options 弹窗 batch-added */
function onBatchAdded(): void {
  closeForm()
}

async function onSave(data: EntryFormData) {
  if (editing.value) {
    // type 变更时重算 digits（steam→其他保持 5 会显示错位数）；type 未变沿用表单值。
    // digits 经 toOtpDigits 收口 number→OtpDigits：表单提交校验（steam=5、其余 6/7/8）已保证
    // 合法值，此处恒等回传不改运行时行为；?? 默认仅兜 EntryFormData.digits 可选的类型口径
    // （运行时表单恒携带），替代此前 `{ ...data } as EntryFormData & { digits?: number }` 断言
    await updateEntryOp(editing.value.uuid, {
      ...data,
      digits: toOtpDigits(
        data.type !== editing.value.type ? (data.type === 'steam' ? 5 : 6) : (data.digits ?? 6),
        data.type,
      ),
    })
  } else {
    // URI 导入预填：表单内未改 type 时携带 URI 中的 algorithm/digits/period/counter
    const carried = prefill.value?.type === data.type ? prefill.value : null
    await addEntryOp({
      ...data,
      uuid: crypto.randomUUID(),
      algorithm: carried?.algorithm ?? 'SHA1',
      // digits 经 toOtpDigits 收口（与编辑路径同口径）：carried 来自 parseUriToEntryData 已收口可直传，
      // 纯手写路径以表单提交值收口——steam 恒 5、yandex 恒 8、其余 6/7/8。不得回退字面量 5/6：
      // 此前 `steam ? 5 : 6` 把表单提交的 yandex digits=8 覆写为 6，addEntry 写路径不校验直接落盘，
      // 下次 loadVault 经 validateVaultObject 整记录拒绝（'vault corrupted'）致整个 vault 不可用
      digits: carried?.digits ?? toOtpDigits(data.digits ?? 6, data.type),
      period: carried?.period ?? 30,
      ...(carried?.type === 'hotp' ? { counter: carried.counter ?? 0 } : {}),
      order: 0,
      createdAt: Date.now(),
    })
  }
  closeForm()
}
function askRemove(uuid: string) {
  if (confirmingDelete.value === uuid) { void removeEntryOp(uuid); confirmingDelete.value = null; return }
  confirmingDelete.value = uuid
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => (confirmingDelete.value = null), 3000)
}

/**
 * 30s 清剪贴板：popup 复制后即将关闭，本地定时器随窗口销毁不可靠——
 * Chromium（有 offscreen API）交由 background(alarms+offscreen) 承载；Firefox 无 offscreen 降级不调度
 */
function scheduleClipboardClear(): void {
  if (!settings.clipboardClearEnabled) return
  if (!canOffscreen()) return
  void ext!.runtime.sendMessage({ type: 'schedule-clipboard-clear', delayMs: CLIPBOARD_CLEAR_DELAY_MS }).catch(() => {})
}
const copied = ref(false) // 「已复制」横幅显隐
const copyFailed = ref(false) // 复制失败横幅（真机发现：剪贴板被第三方进程独占时 writeText 拒绝，原实现静默无提示）
let closeTimer: ReturnType<typeof setTimeout> | null = null
/** 双击揭示代次（审查 I-1 武装竞态守卫）：copy 开始快照、武装前比对 */
let revealGeneration = 0

async function copy(entry: OtpEntry) {
  // I-1：copy 开始即快照揭示代次——copy 是 async，若双击落在下方 await 期间，
  // cancelAutoClose 执行时 closeTimer 还是 null（取消落空），须靠代次失配在武装点跳过
  const generation = revealGeneration
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  try {
    await navigator.clipboard.writeText(c)
  } catch {
    // 复制失败：错误横幅替代「已复制」，不武装自动关窗（用户需要时间看到失败原因）
    copied.value = false
    copyFailed.value = true
    return
  }
  copyFailed.value = false
  scheduleClipboardClear()
  // HOTP：复制的是旧 counter 的码（RFC 语义），复制完成后再递增
  if (entry.type === 'hotp') await updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 })
  // 「已复制」反馈：横幅提示后按 popupCloseDelayMs 延迟关闭（简单实现：不重置，到点关闭）
  copied.value = true
  if (closeTimer) clearTimeout(closeTimer)
  // I-1 竞态守卫：await 期间发生过双击揭示 → 不武装，否则刚取消过的揭示又被本 timer 截断
  if (generation !== revealGeneration) return
  // M23：loadSettings 走 DEFAULT_SETTINGS 合并兜底（见 vaultStore.loadSettings M4），popupCloseDelayMs 必为 number
  closeTimer = setTimeout(() => window.close(), settings.popupCloseDelayMs)
}

/** 双击揭示（OtpListItem 内部 8s）时取消本次复制后自动关闭（终审 Important-1）：刚看过码的会话不再自动关，符合「刚交互过」直觉。
 *  审查 I-1：同时递增揭示代次——双击先于 copy 的 await 落地派发时（慢机器可复现），此处 closeTimer
 *  还是 null、clearTimeout 取消落空，在途 copy 靠代次失配在武装点跳过，揭示不被自动关闭截断 */
function cancelAutoClose(): void {
  revealGeneration++
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
}
</script>

<template>
  <LockScreen v-if="locked" :store="store" :allow-passkey="false" />
  <main v-else @click="closeContextMenu">
    <header>
      <h1>{{ t('popup.title') }}</h1>
      <div class="header-ops">
        <button v-if="!creating && !editing" @click="startCreate">{{ t('popup.add') }}</button>
        <MdIconButton :title="t('popup.settings')" :aria-label="t('popup.openSettings')" @click="openSettings">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path :d="SETTINGS_ICON_PATH" fill="currentColor" /></svg>
        </MdIconButton>
      </div>
    </header>

    <div v-if="copied" class="copied-banner">{{ t('popup.copiedBanner') }}</div>
    <div v-if="copyFailed" class="copied-banner copied-banner--error" role="alert">{{ t('popup.copyFailed') }}</div>
    <div v-if="error" class="error">{{ error }}</div>

    <SearchBar v-model="query" />

    <TagFilterRow
      v-if="vault.tags.length > 0" class="tag-row"
      :tags="vault.tags" v-model:selected-ids="selectedTagIds"
      :mode="tagMode" @update:mode="setTagMode"
    />

    <div class="filter-row" v-if="tabUrl">
      <!-- M3 MdCheckbox(审查 X10):原 UA 原生 checkbox 深色 scheme 下未选中即深灰填充,即「复选框底色偏深」根因 -->
      <MdCheckbox :model-value="filterOn" :label="t('popup.filterBySite')" @update:model-value="toggleFilter" />
      <span v-if="!filterResult.hint && filterOn && filterResult.urlMatchCount > 0" class="hint">{{ t('popup.matchCount', { count: filterResult.urlMatchCount }) }}</span>
    </div>
    <!-- hint 不受 tabUrl 门控：无标签页 URL（新标签页等）时放宽提示仍可达（spec §3 回退提示） -->
    <span v-if="filterResult.hint" class="hint hint-row">{{ filterResult.hint }}</span>

    <!-- 错误提示置于 details 外常显：?uri= 回调报错时 details 默认折叠，放内部会静默不可见 -->
    <div v-if="importError" class="error">{{ importError }}</div>
    <details class="otpauth-import" :open="importOpen" @toggle="onImportToggle">
      <summary>{{ t('popup.importSummary') }}</summary>
      <textarea v-model="otpauthUri" rows="2" placeholder="otpauth://totp/GitHub:me?secret=..." />
      <div class="import-row">
        <button type="button" @click="importOtpauth">{{ t('popup.importBtn') }}</button>
      </div>
    </details>

    <!-- 14c 新建表单双 Tab：仅 creating 显 Tab（editing 保持原纯手动表单）。manual 渲染原内联 EntryForm
         （:key 预填重挂载机制、onSave、cancel=closeForm 一字不动）；paste 渲染 BatchPastePanel，粘贴落库
         added → onBatchAdded 关表单回列表。v-if/v-else 切换即卸载，切回手动时 EntryForm 状态重置 -->
    <template v-if="creating || editing">
      <MdSegmentedButton v-if="creating" v-model="formTab" :options="FORM_TAB_OPTIONS" :aria-label="t('popup.inputMethod')" class="form-tabs" />
      <EntryForm v-if="formTab === 'manual' || editing" :key="editing?.uuid ?? (prefill ? `prefill-${formKey}` : 'new')" :initial="editing ?? prefill" :tags="vault.tags" :create-tag="addTagOp" :icons="entryIcons" :icon-store="icons" @save="onSave" @cancel="closeForm" />
      <BatchPastePanel v-else :store="store" @added="onBatchAdded" />
    </template>

    <div v-if="loaded && sorted.length === 0" class="empty">{{ t('popup.empty') }}</div>
    <div v-else-if="loaded && visible.length === 0" class="empty">{{ t('popup.noMatch') }}</div>
    <div v-for="e in visible" :key="e.uuid" class="item-wrap" @click="closeContextMenu">
      <!-- 终审 Important-1：@dblclick 经 attrs fallthrough 与组件内部揭示 onDblclick 合并共存——双击即揭示并取消自动关闭 -->
      <OtpListItem :entry="e" :icon="iconView(e.icon, icons)" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="copy(e)" @qr="qrEntry = e" @context="(ev) => onContextMenu(e, ev)" @dblclick="cancelAutoClose" />
      <div class="ops">
        <template v-if="confirmingDelete === e.uuid">
          <button class="danger" @click.stop="askRemove(e.uuid)">{{ t('popup.confirmDelete') }}</button>
        </template>
        <template v-else>
          <button class="icon" @click.stop="editing = e">✎</button>
          <button class="icon" @click.stop="askRemove(e.uuid)">🗑</button>
        </template>
      </div>
    </div>

    <!-- F1：右键菜单（编辑 / 复制 URI / 置顶，spec §10） -->
    <ul
      v-if="contextMenu"
      class="ctx-menu"
      :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
      @click.stop
    >
      <li><button @click="contextEdit(contextMenu.entry)">{{ t('popup.edit') }}</button></li>
      <li><button @click="qrEntry = contextMenu.entry; contextMenu = null">{{ t('popup.showQr') }}</button></li>
      <li><button @click="contextCopyUri(contextMenu.entry)">{{ t('popup.copyUri') }}</button></li>
      <li><button @click="contextTogglePin(contextMenu.entry)">{{ contextMenu.entry.pinned ? t('popup.unpin') : t('popup.pin') }}</button></li>
    </ul>

    <!-- 单条目 otpauth 二维码（Esc/遮罩/「关闭」按钮关闭） -->
    <OtpQrDialog :open="qrEntry !== null" :entry="qrEntry" @close="qrEntry = null" />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 8px; }
main { display: flex; flex-direction: column; gap: 4px; }
header { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 8px; }
.header-ops { display: flex; align-items: center; gap: 6px; }
h1 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); }
.copied-banner { font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-primary); background: var(--md-sys-color-primary-container); border-radius: 6px; padding: 4px 8px; margin: 0 4px; }
.copied-banner--error { color: var(--md-sys-color-error); background: var(--md-sys-color-error-container); }
.filter-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-small); padding: 0 4px; }
.tag-row { padding: 0 4px; }
.otpauth-import { font-size: var(--md-sys-typescale-body-medium); padding: 0 4px; }
/* 14c 新建表单双 Tab：与相邻行对齐 4px 边距（popup 宽 ~360px，两段按钮可容） */
.form-tabs { margin: 0 4px; align-self: flex-start; }
.otpauth-import summary { cursor: pointer; opacity: .8; }
.otpauth-import textarea { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 6px 8px; font-family: inherit; resize: vertical; }
.otpauth-import .import-row { display: flex; justify-content: flex-end; margin-top: 4px; }
.hint { opacity: .6; }
.hint-row { padding: 0 4px; }
.empty { text-align: center; opacity: .6; padding: 32px 0; }
.item-wrap { position: relative; }
.ops { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.item-wrap:hover .ops, .ops:focus-within { opacity: 1; }
.ops .icon { border: none; background: none; cursor: pointer; font-size: var(--md-sys-typescale-body-medium); padding: 2px 4px; }
.ops .danger { border: none; background: none; cursor: pointer; color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); font-weight: 600; }
/* 右键菜单（类名与样式同 旧单页，保证跨宿主一致观感） */
.ctx-menu { position: fixed; z-index: 1001; list-style: none; margin: 0; padding: 4px 0; background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 6px; box-shadow: 0 2px 12px color-mix(in srgb, var(--md-sys-color-shadow) 18%, transparent); min-width: 120px; }
.ctx-menu li button { display: block; width: 100%; padding: 6px 14px; border: none; background: none; text-align: left; cursor: pointer; font-size: var(--md-sys-typescale-body-medium); }
.ctx-menu li button:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
</style>
