<script setup lang="ts">
import { suggestIcons, type BuiltinIcon } from '@totp/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MdDialog from './md/MdDialog.vue'
import MdTextField from './md/MdTextField.vue'

const { t } = useI18n()

const props = defineProps<{
  open: boolean
  builtin: Record<string, BuiltinIcon>
  /** 当前服务商名称：打开时按模糊匹配生成推荐区，空/无候选则不显示 */
  issuer?: string
}>()
const emit = defineEmits<{ select: [icon: BuiltinIcon]; close: [] }>()

const query = ref('')
// 每次打开重置搜索词，避免上次的过滤残留
watch(
  () => props.open,
  (open) => {
    if (open) query.value = ''
  },
)

function svgHtml(path: string): string {
  return `<path d="${path}"></path>`
}

const searching = computed(() => query.value.trim() !== '')
/** 搜索复用 suggestIcons（别名参与 + 模糊纠错 + 相关度排序）；空查询展示全集 */
const results = computed<BuiltinIcon[]>(() => {
  if (!searching.value) return Object.values(props.builtin)
  return suggestIcons(query.value, Number.MAX_SAFE_INTEGER).filter((i) => props.builtin[i.id])
})
const recommended = computed<BuiltinIcon[]>(() => (props.open ? suggestIcons(props.issuer ?? '', 3) : []))
</script>

<template>
  <MdDialog :open="open" :headline="t('entryForm.iconPickerTitle')" @close="emit('close')">
    <MdTextField
      v-model="query" class="picker-search" :label="t('entryForm.searchIconsLabel')"
      :placeholder="t('entryForm.searchIcons')" :aria-label="t('entryForm.searchIconsLabel')"
    />
    <div v-if="!searching && recommended.length > 0" class="picker-recommended">
      <p class="picker-section-label">{{ t('entryForm.recommendedSection') }}</p>
      <div class="picker-grid">
        <button
          v-for="icon in recommended" :key="icon.id" type="button" class="picker-cell"
          :title="icon.title" :aria-label="icon.title" @click="emit('select', icon)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" v-html="svgHtml(icon.path)" />
        </button>
      </div>
    </div>
    <p class="picker-section-label">{{ searching ? t('entryForm.searchResultsSection') : t('entryForm.allIconsSection') }}</p>
    <div class="picker-grid picker-grid--all">
      <button
        v-for="icon in results" :key="icon.id" type="button" class="picker-cell"
        :title="icon.title" :aria-label="icon.title" @click="emit('select', icon)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" v-html="svgHtml(icon.path)" />
      </button>
    </div>
    <p v-if="searching && results.length === 0" class="picker-empty">{{ t('entryForm.iconPickerNoResults') }}</p>
  </MdDialog>
</template>

<style scoped>
.picker-search { margin-bottom: 4px; }
.picker-section-label { font-size: var(--md-sys-typescale-label-medium); opacity: 0.65; margin: 8px 0 4px; }
.picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 4px; }
.picker-grid--all { max-height: 300px; overflow-y: auto; }
.picker-cell { display: grid; place-items: center; aspect-ratio: 1; width: 100%; padding: 0; border: none; border-radius: 8px; background: transparent; color: var(--md-sys-color-on-surface-variant); cursor: pointer; }
.picker-cell:hover { background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent); color: var(--md-sys-color-on-surface); }
.picker-cell svg { width: 24px; height: 24px; fill: currentColor; }
.picker-empty { font-size: var(--md-sys-typescale-body-small); opacity: 0.6; }
</style>
