<script setup lang="ts">
import { getBuiltinIcons, type BuiltinIcon, type OtpEntry, type Tag } from '@totp/core'
import { ref } from 'vue'
import BatchPastePanel from './BatchPastePanel.vue'
import EntryForm from './EntryForm.vue'
import type { EntryFormData } from './entryForm'
import MdDialog from './md/MdDialog.vue'
import MdSegmentedButton from './md/MdSegmentedButton.vue'
import type { IconStore } from '../iconStore'
import type { VueStore } from '../store'

defineProps<{
  open: boolean
  /** 编辑目标；null = 新建。EntryForm 以 uuid 为 key，切换目标时表单重建回填 */
  editing: OtpEntry | null
  tags: Tag[]
  /** 内联快速建 tag 透传（CodesPage 接 store.addTagOp）；缺省时 EntryForm 不渲染内联建行 */
  createTag?: (name: string) => Promise<string>
  /** EntryForm 图标数据源（builtin 全集 + stored dataUrl 映射） */
  icons: { builtin: Record<string, BuiltinIcon>; stored: Readonly<Record<string, string>> }
  /** 图标存储：上传/URL 拉取需要写能力；缺省时 EntryForm 隐藏上传与 URL 拉取 */
  iconStore?: IconStore
  /** 智能粘贴 Tab 数据源（14b）：BatchPastePanel 解析落库直写 store */
  store: VueStore
}>()

// save 只透传表单数据并由父组件关弹；新建默认值分支（algorithm/digits/period/counter/order/createdAt）留在父组件 onSave。
// batch-added：粘贴 Tab 落库条数上抛，宿主收后关弹窗（同 close 口径）
const emit = defineEmits<{ save: [data: EntryFormData]; close: []; 'batch-added': [count: number] }>()

/** 双 Tab（14b）：manual 渲染原 EntryForm（现状不动），paste 渲染 BatchPastePanel。
 *  BatchPastePanel 外层 v-if：切走即卸载——Dialog 重开/切回时上次粘贴内容自动清空；
 *  EntryForm :key 保持 uuid 口径，切回手动时按 key 重建回填 */
const tab = ref<'manual' | 'paste'>('manual')
const TAB_OPTIONS = [
  { value: 'manual', label: '手动填写' },
  { value: 'paste', label: '智能粘贴' },
]
</script>

<template>
  <MdDialog :open="open" :headline="editing ? '编辑条目' : '新建条目'" @close="emit('close')">
    <MdSegmentedButton v-model="tab" :options="TAB_OPTIONS" aria-label="录入方式" class="entry-tabs" />
    <EntryForm
      v-if="tab === 'manual'"
      :key="editing?.uuid ?? 'new'"
      :initial="editing"
      :tags="tags"
      :create-tag="createTag"
      :icons="icons"
      :icon-store="iconStore"
      @save="(data) => emit('save', data)"
      @cancel="emit('close')"
    />
    <BatchPastePanel v-else :store="store" @added="(count) => emit('batch-added', count)" />
  </MdDialog>
</template>

<style scoped>
.entry-tabs { margin-bottom: 12px; }
</style>
