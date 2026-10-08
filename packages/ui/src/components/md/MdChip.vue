<script setup lang="ts">
import { close } from '../iconPaths'
import MdIconButton from './MdIconButton.vue'
withDefaults(defineProps<{
  selected?: boolean
  label: string
  compact?: boolean
  /** trailing close 钮：选择与移除两动作分立（chip 自身 click 仍是选择） */
  removable?: boolean
  /** close 钮读屏文案（宿主翻译后传入，组件不内联 i18n，同 MdIconButton ariaLabel 模式） */
  removeLabel?: string
  disabled?: boolean
}>(), { selected: false, compact: false, removable: false, disabled: false })
const emit = defineEmits<{ click: [event: MouseEvent]; remove: [] }>()
</script>
<template>
  <button
    class="md-chip" :class="{ 'md-chip--selected': selected, 'md-chip--compact': compact }"
    type="button" :aria-pressed="selected" :disabled="disabled" @click="emit('click', $event)"
  >{{ label }}<MdIconButton
    v-if="removable" class="md-chip__remove" :aria-label="removeLabel"
    @click.stop="emit('remove')"
  >
    <svg :viewBox="close.viewBox" width="24" height="24" fill="currentColor" aria-hidden="true"><path :d="close.d" /></svg>
  </MdIconButton></button>
</template>
<style scoped>
.md-chip { border: none; cursor: pointer; border-radius: 8px; padding: 0 16px; height: 32px;
  background: transparent; color: var(--md-sys-color-on-surface); box-shadow: inset 0 0 0 1px var(--md-sys-color-outline);
  font: inherit; font-size: var(--md-sys-typescale-body-medium); font-weight: 500; display: inline-flex; align-items: center; gap: 8px;
  transition: box-shadow .15s; position: relative; }
.md-chip--selected { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); box-shadow: none; }
.md-chip:disabled { opacity: .38; cursor: default; }
/* compact 档（spec §2.5，mini/popup 快速窗）：28px 视觉（deviation 已裁：低于 48dp 触控目标，
 * 保留 ::after inset -8px 的 ≥32px 命中带） */
.md-chip--compact { height: 28px; padding: 0 12px; font-size: var(--md-sys-typescale-body-small); }
/* 命中层兼状态层(M3 状态层定义于触达区):inset -8px 使 32px 高 chip 达 MD3 48dp 触达目标
 * (相邻 chip gap 8 时命中带重叠,MD3 允许);不得设 pointer-events:none——否则命中扩展失效 */
.md-chip::after { content: ''; position: absolute; inset: -8px; border-radius: inherit; background: transparent; transition: background-color .15s; }
.md-chip:not(:disabled):hover::after { background: color-mix(in srgb, currentColor var(--md-sys-state-layer-hover), transparent); }
/* M3 状态层:pressed 12% / focus 12%(focus 同时保留 3px focus ring) */
.md-chip:not(:disabled):active::after,
.md-chip:not(:disabled):focus-visible::after { background: color-mix(in srgb, currentColor var(--md-sys-state-layer-pressed), transparent); }
.md-chip:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
/* removable close：24px 视觉（compact 28px 随 chip 身高），::after inset -8px → 标准 40 / compact 44 命中
 * （覆盖 Phase 1 .chip-remove ≥40 与 compact 叠加 ≥44 验收）；z-index 抬过 chip 命中层——chip::after
 * 为绝对定位末位子盒、绘制于在流子元素之上（同 Phase 1 packChips 命中截留机制），不抬则 close 点击被截走 */
.md-chip__remove { width: 24px; height: 24px; z-index: 1; }
/* 覆写 MdIconButton 基础 -4px，靠样式注入顺序取胜，勿重排 import（与 .md-icon-btn::after 同特异度，后注入者赢） */
.md-chip__remove::after { inset: -8px; }
.md-chip--compact .md-chip__remove { width: 28px; height: 28px; }
</style>
