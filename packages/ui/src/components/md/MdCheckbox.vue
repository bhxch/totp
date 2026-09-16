<script setup lang="ts">
import { ref, watch } from 'vue'
const props = withDefaults(defineProps<{ modelValue: boolean; label?: string; ariaLabel?: string }>(), { modelValue: false, label: '' })
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const checked = ref(props.modelValue)
watch(() => props.modelValue, v => { checked.value = v })
function onChange(e: Event) {
  checked.value = (e.target as HTMLInputElement).checked
  emit('update:modelValue', checked.value)
}
</script>
<template>
  <label class="md-checkbox" :class="{ 'md-checkbox--checked': checked }">
    <input type="checkbox" class="md-checkbox__input" :aria-label="ariaLabel" :checked="checked" @change="onChange" />
    <span class="md-checkbox__box" aria-hidden="true" />
    <span v-if="label" class="md-checkbox__label">{{ label }}</span>
  </label>
</template>
<style scoped>
.md-checkbox { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font: inherit;
  font-size: 14px; color: var(--md-sys-color-on-surface); vertical-align: middle; }
.md-checkbox__input { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.md-checkbox__box { position: relative; width: 18px; height: 18px; border-radius: 2px; box-sizing: border-box;
  background: transparent; box-shadow: inset 0 0 0 2px var(--md-sys-color-on-surface-variant);
  transition: background-color .15s, box-shadow .15s; flex: none; }
.md-checkbox--checked .md-checkbox__box { background: var(--md-sys-color-primary); box-shadow: none; }
.md-checkbox--checked .md-checkbox__box::after { content: ''; position: absolute; left: 5px; top: 1px;
  width: 5px; height: 10px; border-right: 2px solid var(--md-sys-color-on-primary);
  border-bottom: 2px solid var(--md-sys-color-on-primary); transform: rotate(45deg); }
.md-checkbox__input:focus-visible + .md-checkbox__box { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
