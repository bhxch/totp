<script setup lang="ts">
/** 导航目的地(Rail/Tabs 共用结构);icon 为 24×24 SVG path。 */
defineProps<{ items: { name: string; label: string; icon: string; to: string }[]; active: string }>()
const emit = defineEmits<{ select: [name: string] }>()
</script>
<template>
  <nav class="md-rail">
    <div class="md-rail__items">
      <button v-for="it in items" :key="it.name" type="button" class="md-rail__item"
        :class="{ 'md-rail__item--active': it.name === active }"
        :aria-current="it.name === active ? 'page' : undefined"
        @click="emit('select', it.name)">
        <span class="md-rail__pill" aria-hidden="true">
          <svg class="md-rail__icon" viewBox="0 0 24 24" width="24" height="24">
            <path :d="it.icon" fill="currentColor" />
          </svg>
        </span>
        <span class="md-rail__label">{{ it.label }}</span>
      </button>
    </div>
    <div class="md-rail__actions">
      <slot name="actions" />
    </div>
  </nav>
</template>
<style scoped>
.md-rail { width: 80px; display: flex; flex-direction: column; padding: 12px 0; }
.md-rail__items { display: flex; flex-direction: column; gap: 4px; }
.md-rail__item { border: none; background: transparent; cursor: pointer; font: inherit;
  display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 0 12px;
  color: var(--md-sys-color-on-surface-variant); }
.md-rail__pill { width: 56px; height: 32px; border-radius: 16px; flex: none;
  display: flex; align-items: center; justify-content: center;
  transition: background-color .15s, color .15s; }
.md-rail__item:hover .md-rail__pill { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.md-rail__item:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
.md-rail__item--active { color: var(--md-sys-color-on-surface); }
.md-rail__item--active .md-rail__pill { background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container); }
.md-rail__label { font-size: 12px; line-height: 16px; }
.md-rail__actions { margin-top: auto; display: flex; flex-direction: column; align-items: center;
  gap: 4px; padding: 8px 12px 0; }
</style>
