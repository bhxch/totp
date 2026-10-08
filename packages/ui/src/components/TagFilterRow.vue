<script setup lang="ts">
import type { Tag, TagFilterMode } from '@totp/core'
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
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
  /** 紧凑档（QuickCodesPanel compact 透传）：行 gap 6px、chips 28px、mode 钮 28px（spec §2.5） */
  compact?: boolean
}>(), { manageable: true, compact: false })
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
// ∧/∨ 保留文本字符系 Phase 2 spec §2.3 D1 裁定：Material 无标准逻辑符号图标，系统字体渲染即正确表达
const MODE_SYMBOL: Record<TagFilterMode, string> = { all: '∧', any: '∨' }
const modeDisabled = computed(() => props.disabled || props.selectedIds.length < 2)
const modePopOpen = ref(false)
const modeWrap = ref<HTMLElement | null>(null)
// R3-M6：气泡 id 与按钮 aria-describedby 关联（开启时声明）；useId 保证同页多实例唯一
const modePopId = useId()
function onDocPointerDown(e: Event) {
  if (modeWrap.value && !modeWrap.value.contains(e.target as Node)) modePopOpen.value = false
}
watch(modePopOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocPointerDown, true)
  else document.removeEventListener('pointerdown', onDocPointerDown, true)
})
// R3-I2：切换标签选择致选中 <2（按钮转 disabled，any/all 语义等价、说明失效）→ 收起气泡，
// 防禁用态挂泡（设计 §1.1 三关闭条件之「切换标签选择」）
watch(() => props.selectedIds.length, (n) => {
  if (n < 2) modePopOpen.value = false
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

// ---------- 管理标签钮提示（R3-M5）：原生 :title 触屏不可用，改自绘 tooltip 气泡（组件库无
//  MdTooltip，形态与 mode-pop 同款）。pointerenter/focus 显示、leave/blur 收起——触屏 tap 会
//  派发 pointerenter 同样可见；点击（open-manage）即收起，注意力移交 TagManagerDialog
const managePopOpen = ref(false)
const managePopId = useId()
function openManage() {
  managePopOpen.value = false
  emit('open-manage')
}
</script>
<template>
  <div class="tag-filter-row" :class="{ 'tag-filter-row--compact': compact }" role="group" :aria-label="t('tagFilterRow.groupAria')">
    <div ref="modeWrap" class="mode-wrap">
      <MdIconButton
        class="mode-toggle" :class="{ 'mode-toggle--disabled': modeDisabled }"
        :disabled="modeDisabled"
        :aria-label="mode === 'any' ? t('tagFilterRow.modeAriaAny') : t('tagFilterRow.modeAriaAll')"
        :aria-disabled="modeDisabled || undefined"
        :aria-describedby="modePopOpen ? modePopId : undefined"
        @click="toggleMode"
      >{{ MODE_SYMBOL[mode] }}</MdIconButton>
      <div v-if="modePopOpen" :id="modePopId" class="mode-pop" role="tooltip">
        {{ mode === 'any' ? t('tagFilterRow.popAny') : t('tagFilterRow.popAll') }}
      </div>
    </div>
    <!-- chips 段（「全部」+ 各 tag）：空 tags 整段隐藏；mode 钮（空时天然 <2 禁用）与管理钮仍渲染——管理入口是创建首个标签的途径 -->
    <template v-if="sorted.length > 0">
      <MdChip :label="t('tagFilterRow.all')" :selected="selectedIds.length === 0" :compact="compact" @click="emit('update:selectedIds', [])" />
      <MdChip
        v-for="t in sorted" :key="t.id" :label="t.name"
        :selected="selectedIds.includes(t.id)" :compact="compact" @click="toggle(t.id)"
      />
    </template>
    <span v-if="manageable" class="manage-wrap">
      <MdIconButton
        class="manage-btn"
        :aria-label="t('codesPage.manageTags')"
        :aria-describedby="managePopOpen ? managePopId : undefined"
        @pointerenter="managePopOpen = true" @pointerleave="managePopOpen = false"
        @focus="managePopOpen = true" @blur="managePopOpen = false"
        @click="openManage"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M21.41 11.58l-9-9C12.05 2.22 11.55 2 11 2H4c-1.1 0-2 .9-2 2v7c0 .55.22 1.05.59 1.42l9 9c.36.36.86.58 1.41.58.55 0 1.05-.22 1.41-.59l7-7c.37-.36.59-.86.59-1.41 0-.55-.23-1.06-.59-1.42zM5.5 7C4.67 7 4 6.33 4 5.5S4.67 4 5.5 4 7 4.67 7 5.5 6.33 7 5.5 7z"/></svg>
      </MdIconButton>
      <!-- tooltip 气泡（R3-M5）：hover/聚焦/触屏 tap 可见；右对齐防行尾溢出 -->
      <div v-if="managePopOpen" :id="managePopId" class="mode-pop manage-pop" role="tooltip">
        {{ t('codesPage.manageTags') }}
      </div>
    </span>
  </div>
</template>
<style scoped>
.tag-filter-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
/* compact 档（spec §2.5）：行 gap 6px、mode 钮 28px 视觉 + ::after inset -2px（32px 命中，
 * 与 chips 28px 同档；deviation 已裁低于 48dp 触控目标） */
.tag-filter-row--compact { gap: 6px; }
.tag-filter-row--compact .mode-toggle { width: 28px; height: 28px; }
.tag-filter-row--compact .mode-toggle::after { inset: -2px; }
.mode-wrap { position: relative; display: inline-flex; }
/* 模式钮沿用 MdIconButton 默认 40px 视觉（spec §2.9：::after inset -4px → 48dp 命中达标；
 * 此前 CodesPage 场景曾覆写 32px 裁掉标准档，终审恢复 MD3 40dp）；禁用语义靠 disabled prop，颜色降级补一层 */
.mode-toggle { font-size: 18px; line-height: 1; }
.mode-toggle--disabled { opacity: .4; }
/* 说明气泡：锚定按钮下方；点击外部即折叠（pointerdown capture） */
.mode-pop {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 10;
  width: max-content;
  max-width: min(360px, calc(100vw - 16px));
  padding: 6px 10px; border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-inverse-surface); color: var(--md-sys-color-inverse-on-surface);
  font-size: var(--md-sys-typescale-body-small); white-space: normal;
  box-shadow: var(--md-sys-elevation-level2);
}
/* 管理标签 tooltip（R3-M5）：行尾按钮气泡右对齐防溢出视口 */
.manage-wrap { position: relative; display: inline-flex; }
.manage-pop { left: auto; right: 0; }
</style>
