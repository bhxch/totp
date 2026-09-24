<script setup lang="ts">
import type { Tag, TagFilterMode } from '@totp/core'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import MdChip from './md/MdChip.vue'
import MdSegmentedButton from './md/MdSegmentedButton.vue'

const { t } = useI18n()

const props = defineProps<{
  tags: Tag[]
  selectedIds: string[]
  mode: TagFilterMode
  /** 宿主可整体禁用（预留）；选中 <2 时模式切换恒不生效（any/all 语义相同） */
  disabled?: boolean
}>()
const emit = defineEmits<{
  'update:selectedIds': [ids: string[]]
  'update:mode': [mode: TagFilterMode]
}>()

/** tag 展示恒按名称字母序（模型无 order 字段，spec §1） */
const sorted = computed(() => [...props.tags].sort((a, b) => a.name.localeCompare(b.name, 'zh')))

function toggle(id: string) {
  emit('update:selectedIds', props.selectedIds.includes(id) ? props.selectedIds.filter((x) => x !== id) : [...props.selectedIds, id])
}

// ---------- any/all 模式切换（MdSegmentedButton 两段替代原单一 .mode-toggle 翻转按钮）----------
/** 任一/全部两段各具常显文本（可读性优于原「点前隐后」翻转钮）；compact 化样式见底部 */
const MODE_OPTIONS = [
  { value: 'any', label: t('tagFilterRow.any') },
  { value: 'all', label: t('tagFilterRow.all') },
]
const modeDisabled = computed(() => props.disabled || props.selectedIds.length < 2)
/** 分段按钮 emit 泛化 string，收敛回 TagFilterMode；禁用态守卫同时覆盖点击与组件内方向键两条 emit 路径
 *  （MdSegmentedButton 无 disabled prop，视觉降级 opacity + aria-disabled 标注） */
function onModeSelect(v: string | number) {
  if (modeDisabled.value || v === props.mode) return
  emit('update:mode', v as TagFilterMode)
}
</script>
<template>
  <div class="tag-filter-row" role="group" :aria-label="t('tagFilterRow.groupAria')">
    <MdSegmentedButton
      class="mode-seg" :class="{ 'mode-seg--disabled': modeDisabled }"
      :model-value="mode" :options="MODE_OPTIONS"
      :title="mode === 'any' ? t('tagFilterRow.titleAny') : t('tagFilterRow.titleAll')"
      :aria-disabled="modeDisabled || undefined" @update:model-value="onModeSelect"
    />
    <MdChip :label="t('tagFilterRow.all')" :selected="selectedIds.length === 0" @click="emit('update:selectedIds', [])" />
    <MdChip
      v-for="t in sorted" :key="t.id" :label="t.name"
      :selected="selectedIds.includes(t.id)" @click="toggle(t.id)"
    />
  </div>
</template>
<style scoped>
.tag-filter-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
/* any/all 分段按钮紧凑化：与行内 chips 同档（组件默认 40px 高、body 字号在筛选行偏大） */
.mode-seg :deep(.md-seg__item) { height: 32px; padding: 0 12px; font-size: var(--md-sys-typescale-body-small); }
.mode-seg--disabled { opacity: .4; }
</style>
