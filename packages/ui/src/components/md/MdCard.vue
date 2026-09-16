<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'outlined' | 'elevated'; padding?: 'compact' | 'normal' }>(), { variant: 'outlined', padding: 'normal' })
</script>
<template>
  <div class="md-card" :class="[`md-card--${variant}`, { 'md-card--compact': padding === 'compact' }]">
    <div v-if="$slots.header" class="md-card__header"><slot name="header" /></div>
    <slot />
  </div>
</template>
<style scoped>
.md-card { border-radius: 12px; padding: 16px; color: var(--md-sys-color-on-surface); font: inherit; }
.md-card--compact { padding: 8px; }
.md-card--outlined { background: var(--md-sys-color-surface); box-shadow: inset 0 0 0 1px var(--md-sys-color-outline); }
.md-card--elevated { background: var(--md-sys-color-surface-container-low); box-shadow: 0 1px 3px var(--md-sys-color-shadow); }
.md-card__header { font-size: var(--md-sys-typescale-body-medium); font-weight: 500; margin-bottom: 8px; }
</style>
