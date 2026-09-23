<script setup lang="ts">
import { ref, watch } from 'vue'
const props = withDefaults(defineProps<{ modelValue: boolean; label?: string; ariaLabel?: string; disabled?: boolean }>(), { modelValue: false, label: '', disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const checked = ref(props.modelValue)
watch(() => props.modelValue, v => { checked.value = v })
function onChange(e: Event) {
  checked.value = (e.target as HTMLInputElement).checked
  emit('update:modelValue', checked.value)
}
</script>
<template>
  <label class="md-checkbox" :class="{ 'md-checkbox--checked': checked, 'md-checkbox--disabled': disabled }">
    <input type="checkbox" class="md-checkbox__input" :aria-label="ariaLabel" :checked="checked" :disabled="disabled" @change="onChange" />
    <span class="md-checkbox__box" aria-hidden="true" />
    <span v-if="label" class="md-checkbox__label">{{ label }}</span>
  </label>
</template>
<style scoped>
/* 根 relative：sr-only input(absolute) 的包含块收敛到组件根——否则逃逸到 ICB，
 * 在壳层锁高(批⑧ §4)布局下撑出 document 级隐性滚动(真机 2026-09-24 实证) */
.md-checkbox { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font: inherit;
  font-size: var(--md-sys-typescale-body-medium); color: var(--md-sys-color-on-surface); vertical-align: middle; }
.md-checkbox--disabled { cursor: default; opacity: .38; }
.md-checkbox__input { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.md-checkbox__box { position: relative; width: 18px; height: 18px; border-radius: 2px; box-sizing: border-box;
  background: transparent; box-shadow: inset 0 0 0 2px var(--md-sys-color-on-surface-variant);
  transition: background-color .15s, box-shadow .15s; flex: none; }
/* M3 状态层 hover 8% / pressed 12%(审查 X7;M3 定义于 40dp 触达区,本组件以盒面近似叠加;
 * 未选中叠 on-surface,选中在 primary 底上叠 on-primary)::before 置于勾选标 ::after 之下 */
.md-checkbox__box::before { content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: transparent; transition: background-color .15s; }
.md-checkbox:hover .md-checkbox__box::before { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.md-checkbox:active .md-checkbox__box::before { background: color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent); }
.md-checkbox--checked:hover .md-checkbox__box::before { background: color-mix(in srgb, var(--md-sys-color-on-primary) 8%, transparent); }
.md-checkbox--checked:active .md-checkbox__box::before { background: color-mix(in srgb, var(--md-sys-color-on-primary) 12%, transparent); }
.md-checkbox--checked .md-checkbox__box { background: var(--md-sys-color-primary); box-shadow: none; }
.md-checkbox--checked .md-checkbox__box::after { content: ''; position: absolute; left: 5px; top: 1px;
  width: 5px; height: 10px; border-right: 2px solid var(--md-sys-color-on-primary);
  border-bottom: 2px solid var(--md-sys-color-on-primary); transform: rotate(45deg); }
.md-checkbox__input:focus-visible + .md-checkbox__box { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
