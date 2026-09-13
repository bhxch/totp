<script setup lang="ts">
import type { OtpEntry } from '@totp/core'
import { computed, ref } from 'vue'
import { useOtpCodes } from '../composables/useOtpCodes'
import type { VueStore } from '../store'
import EntryForm from './EntryForm.vue'
import OtpListItem from './OtpListItem.vue'
import SearchBar from './SearchBar.vue'
import type { EntryFormData } from './entryForm'

const props = withDefaults(defineProps<{
  store: VueStore
  /** 点击条目是否触发复制。true 时 emit('copy', code)，剪贴板写入由宿主决定；false 时仅展示 */
  enableCopy?: boolean
}>(), { enableCopy: false })

const emit = defineEmits<{ copy: [code: string] }>()

const query = ref('')
const editing = ref<OtpEntry | null>(null)
const creating = ref(false)
const confirmingDelete = ref<string | null>(null)
const newGroupName = ref('')
const renaming = ref<string | null>(null)
const renameValue = ref('')
let confirmTimer: ReturnType<typeof setTimeout> | null = null

const sorted = computed(() => [...props.store.vault.entries].sort((a, b) => a.order - b.order))
const { codes } = useOtpCodes(sorted)
const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return sorted.value
  return sorted.value.filter((e) => `${e.issuer} ${e.label} ${e.note ?? ''}`.toLowerCase().includes(q))
})

async function onSave(data: EntryFormData) {
  if (editing.value) {
    // type 变更时重算 digits（steam→其他保持 5 会显示错位数）；type 未变则不带，保留原值
    const patch = { ...data } as EntryFormData & { digits?: number }
    if (data.type !== editing.value.type) patch.digits = data.type === 'steam' ? 5 : 6
    await props.store.updateEntryOp(editing.value.uuid, patch)
  } else {
    await props.store.addEntryOp({ ...data, uuid: crypto.randomUUID(), algorithm: 'SHA1', digits: data.type === 'steam' ? 5 : 6, period: 30, order: 0, createdAt: Date.now() })
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
function onCopy(entry: OtpEntry) {
  if (!props.enableCopy) return
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  emit('copy', c)
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
          <button class="icon" @click="renaming = g.id; renameValue = g.name">✎</button>
          <button class="icon" @click="store.removeGroupOp(g.id)">🗑</button>
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
    <SearchBar v-model="query" />
    <EntryForm v-if="creating || editing" :key="editing?.uuid ?? 'new'" :initial="editing" :groups="store.vault.groups" @save="onSave" @cancel="creating = false; editing = null" />
    <div v-if="sorted.length === 0" class="empty">暂无条目，点击「＋ 添加」录入。</div>
    <div v-else-if="visible.length === 0" class="empty">无匹配条目</div>
    <div v-for="e in visible" :key="e.uuid" class="row">
      <OtpListItem :entry="e" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="onCopy(e)" />
      <div class="ops">
        <template v-if="confirmingDelete === e.uuid">
          <button class="danger" @click.stop="askRemove(e.uuid)">确认删除？</button>
        </template>
        <template v-else>
          <button class="icon" @click.stop="editing = e; creating = false">✎</button>
          <button class="icon" @click.stop="askRemove(e.uuid)">🗑</button>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
h2 { font-size: 15px; display: flex; justify-content: space-between; align-items: center; }
.card { border: 1px solid rgba(128,128,128,.4); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.group-add { display: flex; gap: 8px; }
.group-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.group-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.gname { font-weight: 600; } .gcount { opacity: .6; font-size: 12px; flex: 1; }
.row { position: relative; display: flex; align-items: center; }
.row :deep(.otp-item) { flex: 1; }
.ops { display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.row:hover .ops, .ops:focus-within { opacity: 1; }
.icon, .danger { border: none; background: none; cursor: pointer; padding: 4px; }
.danger { color: #d9534f; font-size: 12px; }
.empty { text-align: center; opacity: .6; padding: 16px 0; }
</style>
