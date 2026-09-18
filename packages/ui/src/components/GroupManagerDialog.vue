<script setup lang="ts">
import type { Group } from '@totp/core'
import { onBeforeUnmount, ref, watch } from 'vue'
import type { VueStore } from '../store'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'
import MdIconButton from './md/MdIconButton.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{
  open: boolean
  store: VueStore
}>()

const emit = defineEmits<{ close: [] }>()

// 自 旧单页「分组管理」卡逐字迁移：建组（回车/按钮）、计数、行内重命名（enter 保存/取消）、删除
const newGroupName = ref('')
const renaming = ref<string | null>(null)
const renameValue = ref('')
/** 审查 Minor：删除分组改两击确认（与 CodesPage askRemove 同款模式）——首击进入确认态
 *  3s 超时复位，再击才真删；删除会级联清条目 groupIds，误触代价高 */
const confirmingDelete = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

// 关闭即复位行内编辑与新建输入，避免重开后残留上次的编辑态（确认态与定时器同清）
watch(() => props.open, (open) => {
  if (!open) {
    renaming.value = null
    newGroupName.value = ''
    renameValue.value = ''
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = null
    confirmingDelete.value = null
  }
})

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
/** 两击删除：首击进入确认态（3s 超时自动复位），再击执行 removeGroupOp */
async function removeGroup(g: Group) {
  if (confirmingDelete.value === g.id) {
    confirmingDelete.value = null
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = null
    await props.store.removeGroupOp(g.id)
    return
  }
  confirmingDelete.value = g.id
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => (confirmingDelete.value = null), 3000)
}
// 卸载兜底清确认定时器（open watch 只覆盖关闭路径；组件销毁时挂起回调不再触发响应式写入）
onBeforeUnmount(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = null
})
</script>

<template>
  <MdDialog :open="open" headline="分组管理" @close="emit('close')">
    <form class="group-add" @submit.prevent="addGroup">
      <MdTextField v-model="newGroupName" class="grow" label="新分组名称" aria-label="新分组名称" />
      <MdButton type="submit">创建分组</MdButton>
    </form>
    <ul class="group-list">
      <li v-for="g in store.vault.groups" :key="g.id">
        <template v-if="renaming === g.id">
          <MdTextField v-model="renameValue" class="grow" label="分组名称" aria-label="分组名称" @keydown.enter="saveRename(g)" />
          <MdButton @click="saveRename(g)">保存</MdButton>
          <MdButton variant="text" @click="renaming = null">取消</MdButton>
        </template>
        <template v-else>
          <span class="gname">{{ g.name }}</span>
          <span class="gcount">{{ store.vault.entries.filter((e) => e.groupIds.includes(g.id)).length }} 条</span>
          <MdIconButton :title="'编辑分组 ' + g.name" :aria-label="'编辑分组 ' + g.name" @click="renaming = g.id; renameValue = g.name">编辑</MdIconButton>
          <!-- 确认态换 danger MdButton（error 色视觉警示，与 CodesPage 条目删除一致） -->
          <MdButton v-if="confirmingDelete === g.id" danger @click="removeGroup(g)">确认删除？</MdButton>
          <MdIconButton v-else :title="'删除分组 ' + g.name" :aria-label="'删除分组 ' + g.name" @click="removeGroup(g)">删除</MdIconButton>
        </template>
      </li>
      <li v-if="store.vault.groups.length === 0" class="empty">暂无分组</li>
    </ul>
  </MdDialog>
</template>

<style scoped>
.group-add { display: flex; gap: 8px; align-items: start; }
.grow { flex: 1; }
.group-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.group-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.gname { font-weight: 600; }
.gcount { opacity: .6; font-size: var(--md-sys-typescale-body-small); flex: 1; }
.empty { text-align: center; opacity: .6; padding: 8px 0; }
</style>
