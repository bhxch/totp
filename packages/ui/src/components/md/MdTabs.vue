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
      <svg class="md-tabs__icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
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
  height: 64px; padding: 8px 8px 4px; color: var(--md-sys-color-on-surface-variant); /* M3 bottom nav 64dp（原 56） */
  transition: color .15s, background-color .15s; }
.md-tabs__item:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.md-tabs__item:active { background: color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent); }
.md-tabs__item:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: -1px; }
.md-tabs__item--active { color: var(--md-sys-color-primary); }
/* active indicator：居中 30px 胶囊（M3 规范 30×3/4dp 圆角），替代原 left/right 16 拉伸条 */
.md-tabs__item--active::after { content: ''; position: absolute; left: 50%; bottom: 0; width: 30px; height: 3px;
  transform: translateX(-50%); border-radius: 9999px; background: var(--md-sys-color-primary); }
.md-tabs__label { font-size: var(--md-sys-typescale-label-medium); line-height: 16px; font-weight: 500; }
</style>
