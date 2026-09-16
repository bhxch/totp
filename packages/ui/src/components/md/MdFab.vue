<script setup lang="ts">
defineProps<{ label?: string }>()
</script>
<template>
  <button class="md-fab" :class="{ 'md-fab--extended': !!label }" type="button">
    <slot />
    <span v-if="label" class="md-fab__label">{{ label }}</span>
  </button>
</template>
<style scoped>
.md-fab { border: none; cursor: pointer; border-radius: 16px; width: 56px; height: 56px; padding: 0;
  background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);
  font: inherit; font-size: var(--md-sys-typescale-body-medium); font-weight: 500; display: inline-flex; align-items: center; justify-content: center; gap: 12px;
  box-shadow: 0 4px 8px var(--md-sys-color-shadow); transition: box-shadow .15s; position: relative; }
.md-fab--extended { width: auto; padding: 0 20px; }
.md-fab__label { font-size: var(--md-sys-typescale-body-medium); font-weight: 500; }
.md-fab::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: transparent; transition: background-color .15s; }
.md-fab:hover::after { background: color-mix(in srgb, currentColor 8%, transparent); }
/* M3 状态层:pressed 12% / focus 12%(focus 同时保留 3px focus ring) */
.md-fab:active::after,
.md-fab:focus-visible::after { background: color-mix(in srgb, currentColor 12%, transparent); }
.md-fab:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
