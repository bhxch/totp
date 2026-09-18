<script setup lang="ts">
withDefaults(defineProps<{ selected?: boolean; label: string }>(), { selected: false })
const emit = defineEmits<{ click: [event: MouseEvent] }>()
</script>
<template>
  <button class="md-chip" :class="{ 'md-chip--selected': selected }" type="button" :aria-pressed="selected" @click="emit('click', $event)">{{ label }}</button>
</template>
<style scoped>
.md-chip { border: none; cursor: pointer; border-radius: 8px; padding: 0 16px; height: 32px;
  background: transparent; color: var(--md-sys-color-on-surface); box-shadow: inset 0 0 0 1px var(--md-sys-color-outline);
  font: inherit; font-size: var(--md-sys-typescale-body-medium); font-weight: 500; display: inline-flex; align-items: center; gap: 8px;
  transition: box-shadow .15s; position: relative; }
.md-chip--selected { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); box-shadow: none; }
.md-chip::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: transparent; transition: background-color .15s; }
.md-chip:not(:disabled):hover::after { background: color-mix(in srgb, currentColor 8%, transparent); }
/* M3 状态层:pressed 12% / focus 12%(focus 同时保留 3px focus ring) */
.md-chip:not(:disabled):active::after,
.md-chip:not(:disabled):focus-visible::after { background: color-mix(in srgb, currentColor 12%, transparent); }
.md-chip:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
