<script setup lang="ts">
withDefaults(defineProps<{ selected?: boolean; label: string; compact?: boolean }>(), { selected: false, compact: false })
const emit = defineEmits<{ click: [event: MouseEvent] }>()
</script>
<template>
  <button class="md-chip" :class="{ 'md-chip--selected': selected, 'md-chip--compact': compact }" type="button" :aria-pressed="selected" @click="emit('click', $event)">{{ label }}</button>
</template>
<style scoped>
.md-chip { border: none; cursor: pointer; border-radius: 8px; padding: 0 16px; height: 32px;
  background: transparent; color: var(--md-sys-color-on-surface); box-shadow: inset 0 0 0 1px var(--md-sys-color-outline);
  font: inherit; font-size: var(--md-sys-typescale-body-medium); font-weight: 500; display: inline-flex; align-items: center; gap: 8px;
  transition: box-shadow .15s; position: relative; }
.md-chip--selected { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); box-shadow: none; }
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
</style>
