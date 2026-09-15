<script setup lang="ts">
import type { Group } from '@totp/core'
import { ref } from 'vue'
import type { VueStore } from '../store'
import MdDialog from './md/MdDialog.vue'

const props = defineProps<{
  open: boolean
  store: VueStore
}>()

const emit = defineEmits<{ close: [] }>()

// 自 旧单页「分组管理」卡逐字迁移：建组（回车/按钮）、计数、行内重命名（enter 保存/取消）、删除
const newGroupName = ref('')
const renaming = ref<string | null>(null)
const renameValue = ref('')

async function addGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  await props.store.addGroupOp(name)
  newGroupName.value = ''
}
async function saveRename(g: Group) {
  await props.store.renameGroupOp(g.id, renameValue.value.trim() || g.name)
  renaming.value = null
}
</script>

<template>
  <MdDialog :open="open" headline="分组管理" @close="emit('close')">
    <form class="group-add" @submit.prevent="addGroup">
      <input v-model="newGroupName" placeholder="新分组名称" />
      <button type="submit">创建分组</button>
    </form>
    <ul class="group-list">
      <li v-for="g in store.vault.groups" :key="g.id">
        <template v-if="renaming === g.id">
          <input v-model="renameValue" @keydown.enter="saveRename(g)" />
          <button @click="saveRename(g)">保存</button>
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
  </MdDialog>
</template>

<style scoped>
.group-add { display: flex; gap: 8px; }
.group-add input { flex: 1; }
.group-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.group-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.group-list input { flex: 1; }
.gname { font-weight: 600; }
.gcount { opacity: .6; font-size: 12px; flex: 1; }
.icon { border: none; background: none; cursor: pointer; padding: 4px; }
.empty { text-align: center; opacity: .6; padding: 8px 0; }
</style>
