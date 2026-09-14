<script setup lang="ts">
import { entryMatchesUrl, getBuiltinIcons, type OtpEntry } from '@totp/core'
import { CLIPBOARD_CLEAR_DELAY_MS, createIconStore, EntryForm, iconView, LockScreen, normalizeExtOtpauth, OtpListItem, parseUriToEntryData, SearchBar, useOtpCodes, type EntryFormData } from '@totp/ui'
import { computed, onMounted, ref } from 'vue'
import { PENDING_OTPAUTH_KEY } from '../../src/pendingOtpauth'
import { storageAdapter } from '../../src/store'
import {
  addEntryOp, commitSettings, initStore, locked, registerStorageSync, removeEntryOp, settings, store, updateEntryOp, vault,
} from '../../src/store'

const icons = createIconStore(storageAdapter)

const loaded = ref(false)
const error = ref('')
const query = ref('')
const tabUrl = ref<string | null>(null)
const filterOn = computed(() => settings.urlFilterEnabled)

onMounted(async () => {
  try {
    await initStore()
    registerStorageSync()
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

const sorted = computed(() => [...vault.entries].sort((a, b) => a.order - b.order))
const { codes } = useOtpCodes(sorted)
/** EntryForm 图标数据源：builtin 全集 + store 内 stored/url dataUrl 映射 */
const entryIcons = computed(() => ({ builtin: getBuiltinIcons(), stored: icons.icons }))

const matched = computed(() => (tabUrl.value ? sorted.value.filter((e) => entryMatchesUrl(e, tabUrl.value!)) : []))
const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  const base = q
    ? sorted.value.filter((e) => `${e.issuer} ${e.label} ${e.note ?? ''}`.toLowerCase().includes(q))
    : sorted.value
  if (!filterOn.value || !tabUrl.value) return base
  return matched.value.length > 0 ? matched.value.filter((e) => base.includes(e)) : base
})
const filterFallback = computed(() => filterOn.value && !!tabUrl.value && matched.value.length === 0)
const toggleFilter = async () => {
  settings.urlFilterEnabled = !settings.urlFilterEnabled
  await commitSettings()
}

const editing = ref<OtpEntry | null>(null)
const creating = ref(false)
const confirmingDelete = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

// ---------- otpauth URI 导入预填（粘贴框 / 协议回调 / 右键菜单共用） ----------
const otpauthUri = ref('')
const importError = ref('')
/** 导入预填对象（OtpEntry 形状，uuid/order/createdAt 为哑值）；与 editing 并存时导入预填优先 */
const prefill = ref<OtpEntry | null>(null)
/** 每次导入自增，驱动 EntryForm 重挂载以刷新预填 */
const formKey = ref(0)

/** URI → 表单预填；成功返回 null（并清除既有错误提示），失败返回中文错误消息（供粘贴框与后台入口共用） */
function applyOtpauthPrefill(uri: string): string | null {
  const r = parseUriToEntryData(uri.trim())
  if ('error' in r) return r.error
  importError.value = ''
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
    // type 变更时重算 digits（steam→其他保持 5 会显示错位数）；type 未变则不带，保留原值
    const patch = { ...data } as EntryFormData & { digits?: number }
    if (data.type !== editing.value.type) patch.digits = data.type === 'steam' ? 5 : 6
    await updateEntryOp(editing.value.uuid, patch)
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
  closeTimer = setTimeout(() => window.close(), settings.popupCloseDelayMs ?? 2000)
}
</script>

<template>
  <LockScreen v-if="locked" :store="store" :allow-passkey="false" />
  <main v-else>
    <header>
      <h1>TOTP 验证码</h1>
      <button v-if="!creating && !editing" @click="startCreate">＋ 添加</button>
    </header>

    <div v-if="copied" class="copied-banner">已复制到剪贴板</div>
    <div v-if="error" class="error">{{ error }}</div>

    <SearchBar v-model="query" />

    <div class="filter-row" v-if="tabUrl">
      <label><input type="checkbox" :checked="filterOn" @change="toggleFilter" /> 按当前站点过滤</label>
      <span v-if="filterFallback" class="hint">当前站点无匹配，显示全部</span>
      <span v-else-if="filterOn" class="hint">匹配 {{ matched.length }} 条</span>
    </div>

    <details class="otpauth-import">
      <summary>粘贴 otpauth 链接导入</summary>
      <textarea v-model="otpauthUri" rows="2" placeholder="otpauth://totp/GitHub:me?secret=..." />
      <div class="import-row">
        <button type="button" @click="importOtpauth">导入</button>
      </div>
      <div v-if="importError" class="error">{{ importError }}</div>
    </details>

    <EntryForm v-if="creating || editing" :key="editing?.uuid ?? (prefill ? `prefill-${formKey}` : 'new')" :initial="editing ?? prefill" :groups="vault.groups" :icons="entryIcons" :icon-store="icons" @save="onSave" @cancel="closeForm" />

    <div v-if="loaded && sorted.length === 0" class="empty">暂无条目，点击右上角「＋ 添加」录入。</div>
    <div v-else-if="loaded && visible.length === 0" class="empty">无匹配结果</div>
    <div v-for="e in visible" :key="e.uuid" class="item-wrap">
      <OtpListItem :entry="e" :icon="iconView(e.icon, icons)" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="copy(e)" />
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
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 8px; }
main { display: flex; flex-direction: column; gap: 4px; }
header { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 8px; }
h1 { font-size: 16px; margin: 0; }
.error { color: #d9534f; font-size: 12px; }
.copied-banner { font-size: 12px; color: #2e7d32; background: #e8f5e9; border-radius: 6px; padding: 4px 8px; margin: 0 4px; }
.filter-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 0 4px; }
.otpauth-import { font-size: 13px; padding: 0 4px; }
.otpauth-import summary { cursor: pointer; opacity: .8; }
.otpauth-import textarea { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 6px 8px; font-family: inherit; resize: vertical; }
.otpauth-import .import-row { display: flex; justify-content: flex-end; margin-top: 4px; }
.hint { opacity: .6; }
.empty { text-align: center; opacity: .6; padding: 32px 0; }
.item-wrap { position: relative; }
.ops { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.item-wrap:hover .ops, .ops:focus-within { opacity: 1; }
.ops .icon { border: none; background: none; cursor: pointer; font-size: 14px; padding: 2px 4px; }
.ops .danger { border: none; background: none; cursor: pointer; color: #d9534f; font-size: 12px; font-weight: 600; }
</style>
