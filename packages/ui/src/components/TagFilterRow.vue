<script setup lang="ts">
import type { Tag, TagFilterMode } from '@totp/core'
import { computed } from 'vue'
import MdChip from './md/MdChip.vue'

const props = defineProps<{
  tags: Tag[]
  selectedIds: string[]
  mode: TagFilterMode
  /** 宿主可整体禁用（预留）；选中 <2 时模式切换恒禁用（any/all 语义相同） */
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
</script>
<template>
  <div class="tag-filter-row" role="group" aria-label="标签筛选">
    <button
      type="button" class="mode-toggle"
      :disabled="disabled || selectedIds.length < 2"
      :title="mode === 'any' ? '当前：命中任一选中标签；点击切换为需命中全部' : '当前：需命中全部选中标签；点击切换为任一命中'"
      @click="emit('update:mode', mode === 'any' ? 'all' : 'any')"
    >{{ mode === 'any' ? '任一' : '全部' }}</button>
    <MdChip label="全部" :selected="selectedIds.length === 0" @click="emit('update:selectedIds', [])" />
    <MdChip
      v-for="t in sorted" :key="t.id" :label="t.name"
      :selected="selectedIds.includes(t.id)" @click="toggle(t.id)"
    />
  </div>
</template>
<style scoped>
.tag-filter-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mode-toggle { border: 1px solid var(--md-sys-color-outline); background: transparent; color: var(--md-sys-color-on-surface);
  border-radius: 8px; height: 32px; padding: 0 10px; font: inherit; font-size: var(--md-sys-typescale-body-small); cursor: pointer; }
.mode-toggle:disabled { opacity: .4; cursor: default; }
.mode-toggle:not(:disabled):hover { background: color-mix(in srgb, currentColor 8%, transparent); }
</style>
