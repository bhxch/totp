<script setup lang="ts">
import { getBuiltinIcons, toOtpDigits, type OtpEntry, type TagFilterMode } from '@totp/core'
import { CLIPBOARD_CLEAR_DELAY_MS, createIconStore, EntryForm, iconView, LockScreen, MdCheckbox, MdIconButton, NAV_ICONS, normalizeExtOtpauth, OtpListItem, parseUriToEntryData, resolvePopupVisible, SearchBar, TagFilterRow, useOtpCodes, useTheme, type EntryFormData } from '@totp/ui'
import { computed, onMounted, ref, watch } from 'vue'
import { PENDING_OTPAUTH_KEY } from '../../src/pendingOtpauth'
import { storageAdapter } from '../../src/store'
import {
  addEntryOp, addTagOp, commitSettings, initStore, locked, registerStorageSync, removeEntryOp, settings, store, updateEntryOp, vault,
} from '../../src/store'

const icons = createIconStore(storageAdapter)

/** 设置深链:直达 options 的 /settings 页(hash 路由);openOptionsPage 不支持 hash 故用 tabs.create */
const SETTINGS_ICON_PATH = NAV_ICONS.settings
function openSettings(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/settings') })
}

const loaded = ref(false)
const error = ref('')
const query = ref('')
const tabUrl = ref<string | null>(null)

onMounted(async () => {
  try {
    await initStore()
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(store)
    registerStorageSync()
    // rememberTagFilter 恢复补偿：setup 早于 initStore，上方 selectedTagIds 初始化读到的是默认值；
    // 盘上设置载入后（Object.assign 同一 reactive 对象）在此补读一次（与 options CodesPage 同语义）。
    // 仅在确有已存选中时赋值：空→空赋值也会触发持久化 watch，省去一次冗余 settings 落盘
    if (settings.rememberTagFilter && settings.lastTagFilterIds.length > 0) selectedTagIds.value = [...settings.lastTagFilterIds]
    await icons.init()
  } catch (e) {
    error.value = '本地数据读取失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    loaded.value = true
  }
  // 协议回调（?uri=）/右键菜单（pendingOtpauth）导入预填，不阻塞后续标签页 URL 读取
  void consumePendingOtpauth()
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
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
// 悬空 tag 清理：tag 被删/同步变更后从选中集合剔除（联动持久化 watch 一并落盘）
watch(
  () => vault.tags.map((t) => t.id),
  (ids) => {
    const next = selectedTagIds.value.filter((id) => ids.includes(id))
    if (next.length !== selectedTagIds.value.length) selectedTagIds.value = next
  },
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

// ---------- F1：secret 揭示 + 右键菜单（spec §10「右键菜单（编辑/复制 URI/置顶）」，与 旧单页 同语义） ----------
/** reveal：点「🔑」后弹模态显前 4 + 后 4（不在列表 DOM 常驻明文） */
const revealing = ref<OtpEntry | null>(null)
/** 右键菜单：菜单位置与目标条目 */
const contextMenu = ref<{ x: number; y: number; entry: OtpEntry } | null>(null)

function maskSecret(secret: string): string {
  const s = secret.replace(/\s+/g, '')
  if (s.length <= 8) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}
function onReveal(entry: OtpEntry) {
  revealing.value = entry
}
function closeReveal() {
  revealing.value = null
}
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
  const params = new URLSearchParams()
  params.set('secret', entry.secret.replace(/\s+/g, ''))
  if (entry.algorithm !== 'SHA1') params.set('algorithm', entry.algorithm)
  if (entry.digits !== 6) params.set('digits', String(entry.digits))
  if (entry.type !== 'totp' && entry.period !== 30) params.set('period', String(entry.period))
  if (entry.type === 'hotp' && typeof entry.counter === 'number') params.set('counter', String(entry.counter))
  if (entry.issuer) params.set('issuer', entry.issuer)
  const label = entry.issuer ? `${encodeURIComponent(entry.issuer)}:${encodeURIComponent(entry.label)}` : encodeURIComponent(entry.label)
  try {
    await navigator.clipboard.writeText(`otpauth://${entry.type}/${label}?${params.toString()}`)
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
      const got = await chrome.storage.local.get(PENDING_OTPAUTH_KEY)
      uri = typeof got[PENDING_OTPAUTH_KEY] === 'string' ? got[PENDING_OTPAUTH_KEY].trim() : ''
      if (uri) await chrome.storage.local.remove(PENDING_OTPAUTH_KEY)
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
      digits: carried?.digits ?? (data.type === 'steam' ? 5 : 6),
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
  if (typeof chrome === 'undefined' || !chrome.offscreen) return
  void chrome.runtime.sendMessage({ type: 'schedule-clipboard-clear', delayMs: CLIPBOARD_CLEAR_DELAY_MS }).catch(() => {})
}
const copied = ref(false) // 「已复制」横幅显隐
let closeTimer: ReturnType<typeof setTimeout> | null = null

async function copy(entry: OtpEntry) {
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  await navigator.clipboard.writeText(c)
  scheduleClipboardClear()
  // HOTP：复制的是旧 counter 的码（RFC 语义），复制完成后再递增
  if (entry.type === 'hotp') await updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 })
  // 「已复制」反馈：横幅提示后按 popupCloseDelayMs 延迟关闭（简单实现：不重置，到点关闭）
  copied.value = true
  if (closeTimer) clearTimeout(closeTimer)
  // M23：loadSettings 走 DEFAULT_SETTINGS 合并兜底（见 vaultStore.loadSettings M4），popupCloseDelayMs 必为 number
  closeTimer = setTimeout(() => window.close(), settings.popupCloseDelayMs)
}
</script>

<template>
  <LockScreen v-if="locked" :store="store" :allow-passkey="false" />
  <main v-else @click="closeContextMenu">
    <header>
      <h1>TOTP 验证码</h1>
      <div class="header-ops">
        <button v-if="!creating && !editing" @click="startCreate">＋ 添加</button>
        <MdIconButton title="设置" aria-label="打开设置" @click="openSettings">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path :d="SETTINGS_ICON_PATH" fill="currentColor" /></svg>
        </MdIconButton>
      </div>
    </header>

    <div v-if="copied" class="copied-banner">已复制到剪贴板</div>
    <div v-if="error" class="error">{{ error }}</div>

    <SearchBar v-model="query" />

    <TagFilterRow
      v-if="vault.tags.length > 0" class="tag-row"
      :tags="vault.tags" v-model:selected-ids="selectedTagIds"
      :mode="tagMode" @update:mode="setTagMode"
    />

    <div class="filter-row" v-if="tabUrl">
      <!-- M3 MdCheckbox(审查 X10):原 UA 原生 checkbox 深色 scheme 下未选中即深灰填充,即「复选框底色偏深」根因 -->
      <MdCheckbox :model-value="filterOn" label="按当前站点过滤" @update:model-value="toggleFilter" />
      <span v-if="filterResult.hint" class="hint">{{ filterResult.hint }}</span>
      <span v-else-if="filterOn && filterResult.urlMatchCount > 0" class="hint">匹配 {{ filterResult.urlMatchCount }} 条</span>
    </div>

    <!-- 错误提示置于 details 外常显：?uri= 回调报错时 details 默认折叠，放内部会静默不可见 -->
    <div v-if="importError" class="error">{{ importError }}</div>
    <details class="otpauth-import" :open="importOpen" @toggle="onImportToggle">
      <summary>粘贴 otpauth 链接导入</summary>
      <textarea v-model="otpauthUri" rows="2" placeholder="otpauth://totp/GitHub:me?secret=..." />
      <div class="import-row">
        <button type="button" @click="importOtpauth">导入</button>
      </div>
    </details>

    <EntryForm v-if="creating || editing" :key="editing?.uuid ?? (prefill ? `prefill-${formKey}` : 'new')" :initial="editing ?? prefill" :tags="vault.tags" :create-tag="addTagOp" :icons="entryIcons" :icon-store="icons" @save="onSave" @cancel="closeForm" />

    <div v-if="loaded && sorted.length === 0" class="empty">暂无条目，点击右上角「＋ 添加」录入。</div>
    <div v-else-if="loaded && visible.length === 0" class="empty">无匹配结果</div>
    <div v-for="e in visible" :key="e.uuid" class="item-wrap" @click="closeContextMenu">
      <OtpListItem :entry="e" :icon="iconView(e.icon, icons)" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="copy(e)" @reveal="onReveal(e)" @context="(ev) => onContextMenu(e, ev)" />
      <div class="ops">
        <template v-if="confirmingDelete === e.uuid">
          <button class="danger" @click.stop="askRemove(e.uuid)">确认删除？</button>
        </template>
        <template v-else>
          <button class="icon" @click.stop="editing = e">✎</button>
          <button class="icon" @click.stop="askRemove(e.uuid)">🗑</button>
        </template>
      </div>
    </div>

    <!-- F1：reveal 模态（与 旧单页 同语义：仅显前 4 + 后 4） -->
    <div v-if="revealing" class="reveal-mask" @click="closeReveal">
      <div class="reveal-card" @click.stop>
        <h3>{{ revealing.issuer }} — 密钥</h3>
        <code class="reveal-secret">{{ maskSecret(revealing.secret) }}</code>
        <p class="reveal-hint">出于安全考虑，仅显示密钥前后各 4 位；如需完整密钥请使用编辑功能。</p>
        <button class="reveal-close" @click="closeReveal">关闭</button>
      </div>
    </div>

    <!-- F1：右键菜单（编辑 / 复制 URI / 置顶，spec §10） -->
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
.filter-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-small); padding: 0 4px; }
.tag-row { padding: 0 4px; }
.otpauth-import { font-size: var(--md-sys-typescale-body-medium); padding: 0 4px; }
.otpauth-import summary { cursor: pointer; opacity: .8; }
.otpauth-import textarea { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 6px 8px; font-family: inherit; resize: vertical; }
.otpauth-import .import-row { display: flex; justify-content: flex-end; margin-top: 4px; }
.hint { opacity: .6; }
.empty { text-align: center; opacity: .6; padding: 32px 0; }
.item-wrap { position: relative; }
.ops { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.item-wrap:hover .ops, .ops:focus-within { opacity: 1; }
.ops .icon { border: none; background: none; cursor: pointer; font-size: var(--md-sys-typescale-body-medium); padding: 2px 4px; }
.ops .danger { border: none; background: none; cursor: pointer; color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); font-weight: 600; }
/* F1：reveal 模态 + 右键菜单（类名与样式同 旧单页，保证跨宿主一致观感） */
.reveal-mask { position: fixed; inset: 0; background: color-mix(in srgb, var(--md-sys-color-scrim) 55%, transparent); display: grid; place-items: center; z-index: 1000; }
.reveal-card { background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface); padding: 20px 24px; border-radius: 10px; max-width: 320px; width: 88%; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 4px 24px color-mix(in srgb, var(--md-sys-color-shadow) 25%, transparent); }
.reveal-card h3 { font-size: var(--md-sys-typescale-body-medium); margin: 0; }
.reveal-secret { font-family: ui-monospace, monospace; font-size: var(--md-sys-typescale-code-large); letter-spacing: 1px; background: var(--md-sys-color-surface-container-highest); padding: 10px; border-radius: 6px; text-align: center; word-break: break-all; }
.reveal-hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
.reveal-close { align-self: flex-end; }
.ctx-menu { position: fixed; z-index: 1001; list-style: none; margin: 0; padding: 4px 0; background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface); border: 1px solid var(--md-sys-color-outline-variant); border-radius: 6px; box-shadow: 0 2px 12px color-mix(in srgb, var(--md-sys-color-shadow) 18%, transparent); min-width: 120px; }
.ctx-menu li button { display: block; width: 100%; padding: 6px 14px; border: none; background: none; text-align: left; cursor: pointer; font-size: var(--md-sys-typescale-body-medium); }
.ctx-menu li button:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
</style>
