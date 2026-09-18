<script setup lang="ts">
import type { Tag } from '@totp/core'
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

// 自 旧单页「标签管理」卡逐字迁移：建标签（回车/按钮）、计数、行内重命名（enter 保存/取消）、删除
const newTagName = ref('')
const renaming = ref<string | null>(null)
const renameValue = ref('')
/** 审查 Minor：删除标签改两击确认（与 CodesPage askRemove 同款模式）——首击进入确认态
 *  3s 超时复位，再击才真删；删除会级联清条目 tagIds，误触代价高 */
const confirmingDelete = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

// 关闭即复位行内编辑与新建输入，避免重开后残留上次的编辑态（确认态与定时器同清）
watch(() => props.open, (open) => {
  if (!open) {
    renaming.value = null
    newTagName.value = ''
    renameValue.value = ''
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = null
    confirmingDelete.value = null
  }
})

async function addTag() {
  const name = newTagName.value.trim()
  if (!name) return
  await props.store.addTagOp(name)
  newTagName.value = ''
}
async function saveRename(t: Tag) {
  await props.store.renameTagOp(t.id, renameValue.value.trim() || t.name)
  renaming.value = null
}
/** 两击删除：首击进入确认态（3s 超时自动复位），再击执行 removeTagOp */
async function removeTag(t: Tag) {
  if (confirmingDelete.value === t.id) {
    confirmingDelete.value = null
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = null
    await props.store.removeTagOp(t.id)
    return
  }
  confirmingDelete.value = t.id
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
  <MdDialog :open="open" headline="标签管理" @close="emit('close')">
    <form class="tag-add" @submit.prevent="addTag">
      <MdTextField v-model="newTagName" class="grow" label="新标签名称" aria-label="新标签名称" />
      <MdButton type="submit">创建标签</MdButton>
    </form>
    <ul class="tag-list">
      <li v-for="t in store.vault.tags" :key="t.id">
        <template v-if="renaming === t.id">
          <MdTextField v-model="renameValue" class="grow" label="标签名称" aria-label="标签名称" @keydown.enter="saveRename(t)" />
          <MdButton @click="saveRename(t)">保存</MdButton>
          <MdButton variant="text" @click="renaming = null">取消</MdButton>
        </template>
        <template v-else>
          <span class="tname">{{ t.name }}</span>
          <span class="tcount">{{ store.vault.entries.filter((e) => e.tagIds.includes(t.id)).length }} 条</span>
          <MdIconButton :title="'编辑标签 ' + t.name" :aria-label="'编辑标签 ' + t.name" @click="renaming = t.id; renameValue = t.name">编辑</MdIconButton>
          <!-- 确认态换 danger MdButton（error 色视觉警示，与 CodesPage 条目删除一致） -->
          <MdButton v-if="confirmingDelete === t.id" danger @click="removeTag(t)">确认删除？</MdButton>
          <MdIconButton v-else :title="'删除标签 ' + t.name" :aria-label="'删除标签 ' + t.name" @click="removeTag(t)">删除</MdIconButton>
        </template>
      </li>
      <li v-if="store.vault.tags.length === 0" class="empty">暂无标签</li>
    </ul>
  </MdDialog>
</template>

<style scoped>
.tag-add { display: flex; gap: 8px; align-items: start; }
.grow { flex: 1; }
.tag-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.tag-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.tname { font-weight: 600; }
.tcount { opacity: .6; font-size: var(--md-sys-typescale-body-small); flex: 1; }
.empty { text-align: center; opacity: .6; padding: 8px 0; }
</style>
