<script setup lang="ts">
import type { Tag, TagFilterMode } from '@totp/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MdChip from './md/MdChip.vue'
import MdIconButton from './md/MdIconButton.vue'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  tags: Tag[]
  selectedIds: string[]
  mode: TagFilterMode
  /** 宿主可整体禁用（预留）；选中 <2 时模式切换恒不生效（any/all 语义相同） */
  disabled?: boolean
  /** 管理标签入口开关（快速取码面板传 false）；open-manage 由宿主接线 TagManagerDialog */
  manageable?: boolean
}>(), { manageable: true })
const emit = defineEmits<{
  'update:selectedIds': [ids: string[]]
  'update:mode': [mode: TagFilterMode]
  'open-manage': []
}>()

/** tag 展示恒按名称字母序（模型无 order 字段，spec §1） */
const sorted = computed(() => [...props.tags].sort((a, b) => a.name.localeCompare(b.name, 'zh')))

function toggle(id: string) {
  emit('update:selectedIds', props.selectedIds.includes(id) ? props.selectedIds.filter((x) => x !== id) : [...props.selectedIds, id])
}

// ---------- any/all 模式单击切换：逻辑符号 ∧(all)/∨(any)，点击即翻转并弹出说明气泡，点击外部折叠 ----------
const MODE_SYMBOL: Record<TagFilterMode, string> = { all: '∧', any: '∨' }
const modeDisabled = computed(() => props.disabled || props.selectedIds.length < 2)
const modePopOpen = ref(false)
const modeWrap = ref<HTMLElement | null>(null)
function onDocPointerDown(e: Event) {
  if (modeWrap.value && !modeWrap.value.contains(e.target as Node)) modePopOpen.value = false
}
watch(modePopOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocPointerDown, true)
  else document.removeEventListener('pointerdown', onDocPointerDown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
})
function toggleMode() {
  if (modeDisabled.value) return
  // 单击 = 翻转模式；气泡随之展示新状态说明（说明文字只在点击时显示）
  emit('update:mode', props.mode === 'any' ? 'all' : 'any')
  modePopOpen.value = true
}
</script>
<template>
  <div class="tag-filter-row" role="group" :aria-label="t('tagFilterRow.groupAria')">
    <div ref="modeWrap" class="mode-wrap">
      <MdIconButton
        class="mode-toggle" :class="{ 'mode-toggle--disabled': modeDisabled }"
        :disabled="modeDisabled"
        :aria-label="mode === 'any' ? t('tagFilterRow.modeAriaAny') : t('tagFilterRow.modeAriaAll')"
        :aria-disabled="modeDisabled || undefined"
        @click="toggleMode"
      >{{ MODE_SYMBOL[mode] }}</MdIconButton>
      <div v-if="modePopOpen" class="mode-pop" role="tooltip">
        {{ mode === 'any' ? t('tagFilterRow.popAny') : t('tagFilterRow.popAll') }}
      </div>
    </div>
    <!-- chips 段（「全部」+ 各 tag）：空 tags 整段隐藏；mode 钮（空时天然 <2 禁用）与管理钮仍渲染——管理入口是创建首个标签的途径 -->
    <template v-if="sorted.length > 0">
      <MdChip :label="t('tagFilterRow.all')" :selected="selectedIds.length === 0" @click="emit('update:selectedIds', [])" />
      <MdChip
        v-for="t in sorted" :key="t.id" :label="t.name"
        :selected="selectedIds.includes(t.id)" @click="toggle(t.id)"
      />
    </template>
    <MdIconButton
      v-if="manageable" class="manage-btn"
      :title="t('codesPage.manageTags')" :aria-label="t('codesPage.manageTags')"
      @click="emit('open-manage')"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>
    </MdIconButton>
  </div>
</template>
<style scoped>
.tag-filter-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mode-wrap { position: relative; display: inline-flex; }
/* 模式钮紧凑化与 chips 同档（MdIconButton 默认 40px）；禁用语义靠 disabled prop，颜色降级补一层 */
.mode-toggle { width: 32px; height: 32px; font-size: 18px; line-height: 1; }
.mode-toggle--disabled { opacity: .4; }
/* 说明气泡：锚定按钮下方；点击外部即折叠（pointerdown capture） */
.mode-pop {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 10;
  max-width: 240px; padding: 6px 10px; border-radius: 8px;
  background: var(--md-sys-color-inverse-surface); color: var(--md-sys-color-inverse-on-surface);
  font-size: var(--md-sys-typescale-body-small); white-space: normal;
  box-shadow: 0 2px 8px rgb(0 0 0 / .25);
}
</style>
