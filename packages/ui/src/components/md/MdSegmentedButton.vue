<script setup lang="ts">
import { ref } from 'vue'
const props = defineProps<{ options: { value: string; label: string }[]; modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const rootRef = ref<HTMLElement | null>(null)
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
  const idx = props.options.findIndex(o => o.value === props.modelValue)
  const next = Math.min(props.options.length - 1, Math.max(0, idx + (e.key === 'ArrowRight' ? 1 : -1)))
  if (next === idx) return
  emit('update:modelValue', props.options[next]!.value)
  // 焦点跟随选中项(roving tabindex)
  rootRef.value?.querySelectorAll<HTMLButtonElement>('.md-seg__item')[next]?.focus()
}
</script>
<template>
  <div ref="rootRef" class="md-seg" role="radiogroup" @keydown="onKeydown">
    <button v-for="o in options" :key="o.value" type="button" class="md-seg__item" role="radio"
      :tabindex="o.value === modelValue ? 0 : -1" :aria-checked="o.value === modelValue"
      :class="{ 'md-seg__item--selected': o.value === modelValue }"
      @click="emit('update:modelValue', o.value)">
      <span v-if="o.value === modelValue" class="md-seg__check" aria-hidden="true" />{{ o.label }}
    </button>
  </div>
</template>
<style scoped>
.md-seg { display: inline-flex; font: inherit; vertical-align: middle; }
.md-seg__item { border: none; cursor: pointer; background: transparent; color: var(--md-sys-color-on-surface);
  height: 40px; padding: 0 16px; font: inherit; font-size: 14px; font-weight: 500;
  display: inline-flex; align-items: center; gap: 6px; position: relative;
  transition: background-color .15s; }
.md-seg__item + .md-seg__item { box-shadow: inset 1px 0 0 var(--md-sys-color-outline); }
.md-seg__item::after { content: ''; position: absolute; inset: 0; pointer-events: none;
  background: transparent; transition: background-color .15s; }
.md-seg__item:hover::after { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.md-seg__item:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
.md-seg__item--selected { background: var(--md-sys-color-secondary-container);
  color: var(--md-sys-color-on-secondary-container); box-shadow: none; }
.md-seg__item--selected + .md-seg__item { box-shadow: none; }
.md-seg__check { width: 12px; height: 7px; margin-left: -4px;
  border-left: 2px solid var(--md-sys-color-on-secondary-container);
  border-bottom: 2px solid var(--md-sys-color-on-secondary-container);
  transform: rotate(-45deg); flex: none; }
</style>
