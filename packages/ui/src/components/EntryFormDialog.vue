<script setup lang="ts">
import { getBuiltinIcons, type BuiltinIcon, type Group, type OtpEntry } from '@totp/core'
import EntryForm from './EntryForm.vue'
import type { EntryFormData } from './entryForm'
import MdDialog from './md/MdDialog.vue'
import type { IconStore } from '../iconStore'

defineProps<{
  open: boolean
  /** 编辑目标；null = 新建。EntryForm 以 uuid 为 key，切换目标时表单重建回填 */
  editing: OtpEntry | null
  groups: Group[]
  /** EntryForm 图标数据源（builtin 全集 + stored dataUrl 映射） */
  icons: { builtin: Record<string, BuiltinIcon>; stored: Readonly<Record<string, string>> }
  /** 图标存储：上传/URL 拉取需要写能力；缺省时 EntryForm 隐藏上传与 URL 拉取 */
  iconStore?: IconStore
}>()

// save 只透传表单数据并由父组件关弹；新建默认值分支（algorithm/digits/period/counter/order/createdAt）留在父组件 onSave
const emit = defineEmits<{ save: [data: EntryFormData]; close: [] }>()
</script>

<template>
  <MdDialog :open="open" :headline="editing ? '编辑条目' : '新建条目'" @close="emit('close')">
    <EntryForm
      :key="editing?.uuid ?? 'new'"
      :initial="editing"
      :groups="groups"
      :icons="icons"
      :icon-store="iconStore"
      @save="(data) => emit('save', data)"
      @cancel="emit('close')"
    />
  </MdDialog>
</template>
