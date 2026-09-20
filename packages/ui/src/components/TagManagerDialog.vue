<script setup lang="ts">
import type { Tag } from '@totp/core'
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { VueStore } from '../store'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'
import MdIconButton from './md/MdIconButton.vue'
import MdTextField from './md/MdTextField.vue'

const { t } = useI18n()

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
  <MdDialog :open="open" :headline="t('tagManagerDialog.headline')" @close="emit('close')">
    <form class="tag-add" @submit.prevent="addTag">
      <MdTextField v-model="newTagName" class="grow" :label="t('tagManagerDialog.newTagNameLabel')" :aria-label="t('tagManagerDialog.newTagNameLabel')" />
      <MdButton type="submit">{{ t('tagManagerDialog.createTag') }}</MdButton>
    </form>
    <ul class="tag-list">
      <li v-for="tg in store.vault.tags" :key="tg.id">
        <template v-if="renaming === tg.id">
          <MdTextField v-model="renameValue" class="grow" :label="t('tagManagerDialog.tagNameLabel')" :aria-label="t('tagManagerDialog.tagNameLabel')" @keydown.enter="saveRename(tg)" />
          <MdButton @click="saveRename(tg)">{{ t('tagManagerDialog.save') }}</MdButton>
          <MdButton variant="text" @click="renaming = null">{{ t('tagManagerDialog.cancel') }}</MdButton>
        </template>
        <template v-else>
          <span class="tname">{{ tg.name }}</span>
          <span class="tcount">{{ t('tagManagerDialog.count', { count: store.vault.entries.filter((e) => e.tagIds.includes(tg.id)).length }) }}</span>
          <MdIconButton :title="t('tagManagerDialog.editTag', { name: tg.name })" :aria-label="t('tagManagerDialog.editTag', { name: tg.name })" @click="renaming = tg.id; renameValue = tg.name">{{ t('tagManagerDialog.edit') }}</MdIconButton>
          <!-- 确认态换 danger MdButton（error 色视觉警示，与 CodesPage 条目删除一致） -->
          <MdButton v-if="confirmingDelete === tg.id" danger @click="removeTag(tg)">{{ t('tagManagerDialog.confirmDelete') }}</MdButton>
          <MdIconButton v-else :title="t('tagManagerDialog.deleteTag', { name: tg.name })" :aria-label="t('tagManagerDialog.deleteTag', { name: tg.name })" @click="removeTag(tg)">{{ t('tagManagerDialog.delete') }}</MdIconButton>
        </template>
      </li>
      <li v-if="store.vault.tags.length === 0" class="empty">{{ t('tagManagerDialog.empty') }}</li>
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
