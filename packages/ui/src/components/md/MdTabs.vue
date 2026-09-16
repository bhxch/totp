<script setup lang="ts">
/** 导航目的地(Rail/Tabs 共用结构);icon 为 24×24 SVG path。 */
defineProps<{ items: { name: string; label: string; icon: string; to: string }[]; active: string }>()
const emit = defineEmits<{ select: [name: string] }>()
</script>
<template>
  <nav class="md-tabs">
    <button v-for="it in items" :key="it.name" type="button" class="md-tabs__item"
      :class="{ 'md-tabs__item--active': it.name === active }"
      :aria-current="it.name === active ? 'page' : undefined"
      @click="emit('select', it.name)">
      <svg class="md-tabs__icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path :d="it.icon" fill="currentColor" />
      </svg>
      <span class="md-tabs__label">{{ it.label }}</span>
    </button>
  </nav>
</template>
<style scoped>
.md-tabs { display: flex; }
.md-tabs__item { flex: 1; border: none; background: transparent; cursor: pointer; font: inherit;
  position: relative; display: flex; flex-direction: column; align-items: center; gap: 2px;
  height: 56px; padding: 8px 8px 4px; color: var(--md-sys-color-on-surface-variant);
  transition: color .15s, background-color .15s; }
.md-tabs__item:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.md-tabs__item:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: -1px; }
.md-tabs__item--active { color: var(--md-sys-color-primary); }
.md-tabs__item--active::after { content: ''; position: absolute; left: 16px; right: 16px; bottom: 0;
  height: 3px; border-radius: 3px 3px 0 0; background: var(--md-sys-color-primary); }
.md-tabs__label { font-size: var(--md-sys-typescale-body-small); line-height: 16px; font-weight: 500; }
</style>
