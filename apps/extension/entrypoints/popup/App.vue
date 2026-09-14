<script setup lang="ts">
import { entryMatchesUrl, getBuiltinIcons, type OtpEntry } from '@totp/core'
import { CLIPBOARD_CLEAR_DELAY_MS, createIconStore, EntryForm, iconView, LockScreen, OtpListItem, SearchBar, useOtpCodes, type EntryFormData } from '@totp/ui'
import { computed, onMounted, ref } from 'vue'
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

async function onSave(data: EntryFormData) {
  if (editing.value) {
    // type 变更时重算 digits（steam→其他保持 5 会显示错位数）；type 未变则不带，保留原值
    const patch = { ...data } as EntryFormData & { digits?: number }
    if (data.type !== editing.value.type) patch.digits = data.type === 'steam' ? 5 : 6
    await updateEntryOp(editing.value.uuid, patch)
  } else {
    await addEntryOp({ ...data, uuid: crypto.randomUUID(), algorithm: 'SHA1', digits: data.type === 'steam' ? 5 : 6, period: 30, order: 0, createdAt: Date.now() })
  }
  editing.value = null; creating.value = false
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
  <LockScreen v-if="locked" :store="store" />
  <main v-else>
    <header>
      <h1>TOTP 验证码</h1>
      <button v-if="!creating && !editing" @click="creating = true; editing = null">＋ 添加</button>
    </header>

    <div v-if="copied" class="copied-banner">已复制到剪贴板</div>
    <div v-if="error" class="error">{{ error }}</div>

    <SearchBar v-model="query" />

    <div class="filter-row" v-if="tabUrl">
      <label><input type="checkbox" :checked="filterOn" @change="toggleFilter" /> 按当前站点过滤</label>
      <span v-if="filterFallback" class="hint">当前站点无匹配，显示全部</span>
      <span v-else-if="filterOn" class="hint">匹配 {{ matched.length }} 条</span>
    </div>

    <EntryForm v-if="creating || editing" :key="editing?.uuid ?? 'new'" :initial="editing" :groups="vault.groups" :icons="entryIcons" :icon-store="icons" @save="onSave" @cancel="editing = null; creating = false" />

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
.hint { opacity: .6; }
.empty { text-align: center; opacity: .6; padding: 32px 0; }
.item-wrap { position: relative; }
.ops { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.item-wrap:hover .ops, .ops:focus-within { opacity: 1; }
.ops .icon { border: none; background: none; cursor: pointer; font-size: 14px; padding: 2px 4px; }
.ops .danger { border: none; background: none; cursor: pointer; color: #d9534f; font-size: 12px; font-weight: 600; }
</style>
