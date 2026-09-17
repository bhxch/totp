<script setup lang="ts">
import { ref, watch } from 'vue'
const props = withDefaults(defineProps<{ modelValue: boolean; disabled?: boolean; ariaLabel?: string }>(), { modelValue: false, disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const checked = ref(props.modelValue)
watch(() => props.modelValue, v => { checked.value = v })
function onChange(e: Event) {
  checked.value = (e.target as HTMLInputElement).checked
  emit('update:modelValue', checked.value)
}
</script>
<template>
  <label class="md-switch" :class="{ 'md-switch--checked': checked, 'md-switch--disabled': disabled }">
    <input type="checkbox" class="md-switch__input" role="switch" :aria-label="ariaLabel" :checked="checked" :disabled="disabled" @change="onChange" />
    <span class="md-switch__track"><span class="md-switch__thumb" /></span>
  </label>
</template>
<style scoped>
.md-switch { display: inline-flex; align-items: center; cursor: pointer; vertical-align: middle; }
.md-switch--disabled { opacity: .38; cursor: default; }
.md-switch__input { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.md-switch__track { position: relative; width: 52px; height: 32px; border-radius: 16px; box-sizing: border-box;
  background: var(--md-sys-color-surface-container-highest); box-shadow: inset 0 0 0 2px var(--md-sys-color-outline);
  display: inline-flex; align-items: center; padding: 4px; transition: background-color .15s, box-shadow .15s; }
/* M3 状态层 hover 8% / pressed 12%(审查 X7;M3 定义于拇指触达区,本组件以轨道面近似叠加;
 * 未选中叠 on-surface,选中在 primary 轨道上叠 on-primary)::before 置于拇指之下 */
.md-switch__track::before { content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: transparent; transition: background-color .15s; }
.md-switch:hover .md-switch__track::before { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.md-switch:active .md-switch__track::before { background: color-mix(in srgb, var(--md-sys-color-on-surface) 12%, transparent); }
.md-switch--checked:hover .md-switch__track::before { background: color-mix(in srgb, var(--md-sys-color-on-primary) 8%, transparent); }
.md-switch--checked:active .md-switch__track::before { background: color-mix(in srgb, var(--md-sys-color-on-primary) 12%, transparent); }
/* M3 拇指随状态缩放(审查挂账收口):未选中 16dp(on-surface-variant 描边+芯,border-box 含描边)、
 * 选中 24dp 实心(on-primary);150ms cubic(.2,0,0,1) 标准过渡。轨尺寸与状态层(X7)保持不动 */
.md-switch__thumb { position: relative; box-sizing: border-box; width: 16px; height: 16px; border-radius: 50%;
  background: var(--md-sys-color-on-surface-variant); border: 2px solid var(--md-sys-color-on-surface-variant);
  transition: transform .15s cubic-bezier(.2, 0, 0, 1), width .15s cubic-bezier(.2, 0, 0, 1),
    height .15s cubic-bezier(.2, 0, 0, 1), border-color .15s, background-color .15s; }
.md-switch--checked .md-switch__track { background: var(--md-sys-color-primary); box-shadow: none; }
.md-switch--checked .md-switch__thumb { width: 24px; height: 24px; background: var(--md-sys-color-on-primary);
  border-color: var(--md-sys-color-on-primary); transform: translateX(20px); }
.md-switch__input:focus-visible + .md-switch__track { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
