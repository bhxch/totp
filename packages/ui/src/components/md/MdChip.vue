<script setup lang="ts">
import { close } from '../iconPaths'
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
    v-if="!removable"
    class="md-chip" :class="{ 'md-chip--selected': selected, 'md-chip--compact': compact }"
    type="button" :aria-pressed="selected" :disabled="disabled" @click="emit('click', $event)"
  >{{ label }}</button>
  <span
    v-else
    class="md-chip md-chip--removable" :class="{ 'md-chip--selected': selected, 'md-chip--compact': compact }"
  >
    <!-- 非 removable：根 button 整体可点（单动作 chip，TagFilterRow 等消费点零影响）；
         removable：根改非交互 span（胶囊装饰），主/删两兄弟 button——交互元素不可嵌套
         （HTML 内容模型，Phase 2 审查 I-1）；兄弟结构无截留，remove 无需 .stop -->
    <button class="md-chip__main" type="button" :aria-pressed="selected" :disabled="disabled" @click="emit('click', $event)">{{ label }}</button>
    <button class="md-chip__remove" type="button" :aria-label="removeLabel" :disabled="disabled" @click="emit('remove')">
      <svg :viewBox="close.viewBox" width="24" height="24" fill="currentColor" aria-hidden="true"><path :d="close.d" /></svg>
    </button>
  </span>
</template>
<style scoped>
/* 胶囊装饰（两形态共用）：背景/圆角/边框/高度/字体单源在根 */
.md-chip { border: none; cursor: pointer; border-radius: 8px; padding: 0 16px; height: 32px;
  background: transparent; color: var(--md-sys-color-on-surface); box-shadow: inset 0 0 0 1px var(--md-sys-color-outline);
  font: inherit; font-size: var(--md-sys-typescale-body-medium); font-weight: 500; display: inline-flex; align-items: center;
  transition: box-shadow .15s; position: relative; }
.md-chip--selected { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); box-shadow: none; }
.md-chip:disabled { opacity: .38; cursor: default; }
/* compact 档（spec §2.5，mini/popup 快速窗）：28px 视觉（deviation 已裁：低于 48dp 触控目标，
 * 保留 ::after inset -8px 的 ≥32px 命中带） */
.md-chip--compact { height: 28px; padding: 0 12px; font-size: var(--md-sys-typescale-body-small); }
/* removable：根 span 只做胶囊，padding 让位两 button（主区左 16/右 8 与 close 以 padding 分界，
 * 根兜右 16px，总宽与旧版 16+文+8+icon+16 一致；compact 由下方覆盖恢复右 12px） */
.md-chip--removable { padding: 0 16px 0 0; cursor: default; }
/* 两 button 必须自身 relative：static 时其 absolute ::after 的包含块解析到根 span(relative)，
 * 命中层覆盖整胶囊且绘制于流内兄弟之上 → 真机点标签任意位置误触 remove（无头 Chromium 实证） */
.md-chip__main { border: none; background: transparent; color: inherit; font: inherit; font-size: inherit; font-weight: inherit;
  border-radius: inherit; padding: 0 8px 0 16px; align-self: stretch; display: inline-flex; align-items: center; cursor: pointer;
  position: relative; }
.md-chip--compact .md-chip__main { padding: 0 8px 0 12px; }
.md-chip__remove { border: none; background: transparent; color: inherit; font: inherit; border-radius: 100px; padding: 0;
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  position: relative; }
.md-chip--compact .md-chip__remove { width: 28px; height: 28px; }
/* compact 右兜恢复 12px：--removable 与 --compact 同特异度、序胜覆盖出 16px（胶囊宽 4px） */
.md-chip--compact.md-chip--removable { padding: 0 12px 0 0; }
/* disabled 两钮齐禁：胶囊随钮一起降到 38%（:has 兼容目标 Chrome ≥105，旧根 :disabled 语义等价） */
.md-chip--removable:has(:disabled) { opacity: .38; }
.md-chip__main:disabled, .md-chip__remove:disabled { cursor: default; }
/* 命中层兼状态层(M3 状态层定义于触达区)：非 removable 根与 removable 两 button 各自 inset -8px，
 * 使 32px 高 chip 达 MD3 48dp 触达目标(相邻 chip gap 8 时命中带重叠,MD3 允许)；
 * 不得设 pointer-events:none——否则命中扩展失效 */
.md-chip:not(.md-chip--removable)::after,
.md-chip__main::after,
.md-chip__remove::after { content: ''; position: absolute; inset: -8px; border-radius: inherit; background: transparent; transition: background-color .15s; }
.md-chip:not(.md-chip--removable):not(:disabled):hover::after,
.md-chip__main:not(:disabled):hover::after,
.md-chip__remove:not(:disabled):hover::after { background: color-mix(in srgb, currentColor var(--md-sys-state-layer-hover), transparent); }
/* M3 状态层:pressed 12% / focus 12%(focus 同时保留 3px focus ring) */
.md-chip:not(.md-chip--removable):not(:disabled):active::after,
.md-chip:not(.md-chip--removable):not(:disabled):focus-visible::after,
.md-chip__main:not(:disabled):active::after,
.md-chip__main:not(:disabled):focus-visible::after,
.md-chip__remove:not(:disabled):active::after,
.md-chip__remove:not(:disabled):focus-visible::after { background: color-mix(in srgb, currentColor var(--md-sys-state-layer-pressed), transparent); }
.md-chip:focus-visible, .md-chip__main:focus-visible, .md-chip__remove:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
/* removable close：24px 视觉（compact 28px 随 chip 身高），::after inset -8px → 标准 40 / compact 44 命中
 * （覆盖 Phase 1 .chip-remove ≥40 与 compact 叠加 ≥44 验收）；兄弟结构天然后绘制于主区之上，无截留 */
</style>
