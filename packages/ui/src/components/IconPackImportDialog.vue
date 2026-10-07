<!-- packages/ui/src/components/IconPackImportDialog.vue -->
<script setup lang="ts">
import { normalizeIssuer } from '@totp/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{
  open: boolean
  /** 预填：zip 文件名去扩展名 */
  defaultName: string
  /** 既有包 normKey → { 显示名 }：快捷填入 + 覆盖提示的数据源 */
  existingPacks: Readonly<Record<string, { name: string }>>
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ confirm: [name: string]; close: [] }>()

const { t } = useI18n()
const name = ref('')
// 每次打开按最新 defaultName 重置（换 zip 重开不残留上次输入）；
// immediate 保证以 open=true 初始挂载时同样预填（测试直接 open:true 挂载）
watch(
  () => props.open,
  (open) => {
    if (open) name.value = props.defaultName
  },
  { immediate: true },
)

const trimmed = computed(() => name.value.trim())
/** 输入 normalize 后命中既有包 → 提示将覆盖（防近似重复包） */
const overrideTarget = computed(() => {
  const key = normalizeIssuer(trimmed.value)
  return key ? props.existingPacks[key]?.name : undefined
})
const canConfirm = computed(() => trimmed.value !== '' && !props.busy)
</script>

<template>
  <MdDialog :open="open" :headline="t('entryForm.iconPackImportTitle')" @close="emit('close')">
    <MdTextField
      v-model="name" :label="t('entryForm.iconPackNameLabel')"
      :placeholder="t('entryForm.iconPackNamePlaceholder')" :aria-label="t('entryForm.iconPackNameLabel')"
      :disabled="busy"
    />
    <p v-if="overrideTarget" class="override-hint">{{ t('entryForm.iconPackOverrideHint', { name: overrideTarget }) }}</p>
    <div v-if="Object.keys(existingPacks).length > 0" class="quick-fill">
      <p class="quick-label">{{ t('entryForm.iconPackQuickFill') }}</p>
      <div class="quick-chips">
        <button
          v-for="(p, key) in existingPacks" :key="key" type="button" class="quick-chip"
          :disabled="busy" @click="name = p.name"
        >{{ p.name }}</button>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <template #actions>
      <!-- 取消始终可点：busy 期间的逃生通道（审查 Important；防重复导入由确认键 canConfirm 守卫） -->
      <MdButton variant="text" @click="emit('close')">{{ t('entryForm.cancel') }}</MdButton>
      <MdButton variant="filled" :disabled="!canConfirm" @click="emit('confirm', trimmed)">
        {{ t('entryForm.iconPackImportConfirm') }}
      </MdButton>
    </template>
  </MdDialog>
</template>

<style scoped>
.override-hint { font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-tertiary); margin: 4px 0; }
.quick-label { font-size: var(--md-sys-typescale-label-medium); opacity: 0.65; margin: 8px 0 4px; }
.quick-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.quick-chip { border: 1px solid var(--md-sys-color-outline-variant); border-radius: 999px; background: transparent; color: var(--md-sys-color-on-surface); padding: 2px 10px; font-size: var(--md-sys-typescale-body-small); cursor: pointer; position: relative; }
/* 命中层:inset -6px 扩薄 chip 触达(视觉尺寸不变) */
.quick-chip::after { content: ''; position: absolute; inset: -6px; border-radius: inherit; }
.quick-chip:hover { background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent); }
.error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); }
</style>
