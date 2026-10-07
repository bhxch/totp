<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'standard' | 'filled' | 'tonal' | 'outlined'; disabled?: boolean; title?: string; ariaLabel?: string }>(), { variant: 'standard', disabled: false })
</script>
<template>
  <button class="md-icon-btn" :class="`md-icon-btn--${variant}`" type="button" :disabled="disabled" :title="title" :aria-label="ariaLabel"><slot /></button>
</template>
<style scoped>
.md-icon-btn { border: none; cursor: pointer; border-radius: 100px; width: 40px; height: 40px; padding: 0;
  font: inherit; font-size: var(--md-sys-typescale-body-medium); font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  transition: box-shadow .15s; position: relative; }
.md-icon-btn:disabled { opacity: .38; cursor: default; }
/* 命中层兼状态层(M3 状态层定义于触达区):inset -4px 使 40px 视觉钮达 MD3 48dp 触达目标;
 * 不得设 pointer-events:none——否则框外环带点击穿透,命中扩展失效 */
.md-icon-btn::after { content: ''; position: absolute; inset: -4px; border-radius: inherit; background: transparent; transition: background-color .15s; }
.md-icon-btn:not(:disabled):hover::after { background: color-mix(in srgb, currentColor 8%, transparent); }
/* M3 状态层:pressed 12% / focus 12%(focus 同时保留 3px focus ring) */
.md-icon-btn:not(:disabled):active::after,
.md-icon-btn:not(:disabled):focus-visible::after { background: color-mix(in srgb, currentColor 12%, transparent); }
.md-icon-btn--standard { background: transparent; color: var(--md-sys-color-primary); }
.md-icon-btn--filled { background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); }
.md-icon-btn--tonal { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.md-icon-btn--outlined { background: transparent; color: var(--md-sys-color-primary); box-shadow: inset 0 0 0 1px var(--md-sys-color-outline); }
.md-icon-btn:not(:disabled):focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
