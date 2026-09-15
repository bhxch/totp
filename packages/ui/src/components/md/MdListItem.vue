<script setup lang="ts">
withDefaults(defineProps<{ label: string; danger?: boolean }>(), { danger: false })
const emit = defineEmits<{ click: [event: MouseEvent] }>()
</script>
<template>
  <button class="md-list-item" :class="{ 'md-list-item--danger': danger }" type="button" @click="emit('click', $event)">{{ label }}</button>
</template>
<style scoped>
.md-list-item { display: flex; align-items: center; width: 100%; padding: 10px 16px; border: none;
  background: transparent; color: var(--md-sys-color-on-surface); font: inherit; font-size: 14px;
  text-align: left; cursor: pointer; position: relative; }
.md-list-item::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: transparent; transition: background-color .15s; }
.md-list-item:not(:disabled):hover::after { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.md-list-item:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
.md-list-item--danger { color: var(--md-sys-color-error); }
</style>
