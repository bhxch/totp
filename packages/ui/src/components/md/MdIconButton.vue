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
.md-icon-btn::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: transparent; transition: background-color .15s; }
.md-icon-btn:not(:disabled):hover::after { background: color-mix(in srgb, currentColor 8%, transparent); }
.md-icon-btn--standard { background: transparent; color: var(--md-sys-color-primary); }
.md-icon-btn--filled { background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); }
.md-icon-btn--tonal { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.md-icon-btn--outlined { background: transparent; color: var(--md-sys-color-primary); box-shadow: inset 0 0 0 1px var(--md-sys-color-outline); }
.md-icon-btn:not(:disabled):focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
