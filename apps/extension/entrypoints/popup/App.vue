<script setup lang="ts">
import { entryMatchesUrl, type OtpEntry } from '@totp/core'
import { EntryForm, OtpListItem, SearchBar, useOtpCodes, type EntryFormData } from '@totp/ui'
import { computed, onMounted, ref } from 'vue'
import {
  addEntryOp, commitSettings, initStore, registerStorageSync, removeEntryOp, settings, updateEntryOp, vault,
} from '../../src/store'

const loaded = ref(false)
const error = ref('')
const query = ref('')
const tabUrl = ref<string | null>(null)
const filterOn = computed(() => settings.urlFilterEnabled)

onMounted(async () => {
  try {
    await initStore()
    registerStorageSync()
  } catch (e) {
    error.value = '本地数据读取失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    loaded.value = true
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.url?.startsWith('http')) tabUrl.value = tab.url
  } catch {
    // 读不到标签页 URL（如非扩展环境）时 tabUrl 保持 null，不过滤
  }
})

const sorted = computed(() => [...vault.entries].sort((a, b) => a.order - b.order))
const { codes } = useOtpCodes(sorted)

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
  if (editing.value) await updateEntryOp(editing.value.uuid, data)
  else await addEntryOp({ ...data, uuid: crypto.randomUUID(), algorithm: 'SHA1', digits: data.type === 'steam' ? 5 : 6, period: 30, order: 0, createdAt: Date.now() })
  editing.value = null; creating.value = false
}
function askRemove(uuid: string) {
  if (confirmingDelete.value === uuid) { void removeEntryOp(uuid); confirmingDelete.value = null; return }
  confirmingDelete.value = uuid
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => (confirmingDelete.value = null), 3000)
}

async function copy(entry: OtpEntry) {
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  await navigator.clipboard.writeText(c)
  window.close()
}
</script>

<template>
  <main>
    <header>
      <h1>TOTP 验证码</h1>
      <button v-if="!creating && !editing" @click="creating = true; editing = null">＋ 添加</button>
    </header>

    <div v-if="error" class="error">{{ error }}</div>

    <SearchBar v-model="query" />

    <div class="filter-row" v-if="tabUrl">
      <label><input type="checkbox" :checked="filterOn" @change="toggleFilter" /> 按当前站点过滤</label>
      <span v-if="filterFallback" class="hint">当前站点无匹配，显示全部</span>
      <span v-else-if="filterOn" class="hint">匹配 {{ matched.length }} 条</span>
    </div>

    <EntryForm v-if="creating || editing" :initial="editing" :groups="vault.groups" @save="onSave" @cancel="editing = null; creating = false" />

    <div v-if="loaded && sorted.length === 0" class="empty">暂无条目，点击右上角「＋ 添加」录入。</div>
    <div v-else-if="loaded && visible.length === 0" class="empty">无匹配结果</div>
    <div v-for="e in visible" :key="e.uuid" class="item-wrap">
      <OtpListItem :entry="e" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="copy(e)" />
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
.filter-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 0 4px; }
.hint { opacity: .6; }
.empty { text-align: center; opacity: .6; padding: 32px 0; }
.item-wrap { position: relative; }
.ops { position: absolute; top: 4px; right: 4px; display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.item-wrap:hover .ops, .otp-item:hover .ops, .ops:focus-within { opacity: 1; }
.ops .icon { border: none; background: none; cursor: pointer; font-size: 14px; padding: 2px 4px; }
.ops .danger { border: none; background: none; cursor: pointer; color: #d9534f; font-size: 12px; font-weight: 600; }
</style>
