<script lang="ts">
// 模块级计数器:跨实例唯一(测试中每次 mount 为独立 app,useId() 会重置)
let errorIdCounter = 0
</script>
<script setup lang="ts">
import { computed, useAttrs } from 'vue'
// inheritAttrs:false + $attrs 透传内部 input：autocomplete/min/max/disabled/onKeydown/data-* 等直达原生 input；
// class/style 例外——关闭自动继承后 Vue 不再落根，须显式绑回根元素（消费方布局 class 依赖根元素）
defineOptions({ inheritAttrs: false })
withDefaults(defineProps<{ modelValue: string; label: string; type?: string; error?: string; placeholder?: string; ariaLabel?: string }>(), { type: 'text', error: '', placeholder: '' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const errorId = `md-text-field-error-${++errorIdCounter}`
const attrs = useAttrs()
// disabled 经 $attrs 透传内部 input,组件内自行感知以做视觉降级(对齐 MdSwitch/MdCheckbox 的 opacity .38);
// $attrs 响应式,动态增删 disabled 时类名跟随。'' 与缺省视为禁用/未禁用的 HTML 原生语义边界
const isDisabled = computed(() => {
  const v = attrs.disabled
  return v !== undefined && v !== false
})
const inputAttrs = computed(() => {
  const rest: Record<string, unknown> = { ...attrs }
  delete rest.class
  delete rest.style
  return rest
})
</script>
<template>
  <div class="md-text-field" :class="[attrs.class, { 'md-text-field--error': !!error, 'md-text-field--disabled': isDisabled }]" :style="attrs.style">
    <label class="md-text-field__box">
      <span class="md-text-field__label" :class="{ 'md-text-field__label--floated': !!modelValue || !!placeholder }">{{ label }}</span>
      <input v-bind="inputAttrs" class="md-text-field__input" :type="type" :value="modelValue" :placeholder="placeholder"
        :aria-label="ariaLabel" :aria-invalid="error ? 'true' : undefined" :aria-describedby="error ? errorId : undefined"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
    </label>
    <p v-if="error" :id="errorId" class="md-text-field__error">{{ error }}</p>
  </div>
</template>
<style scoped>
.md-text-field { display: flex; flex-direction: column; gap: 4px; font: inherit; }
.md-text-field__box { position: relative; display: block; background: var(--md-sys-color-surface-container-highest);
  border-radius: 4px 4px 0 0; border-bottom: 1px solid var(--md-sys-color-on-surface-variant); transition: border-color .15s; }
.md-text-field__box:focus-within { border-bottom: 2px solid var(--md-sys-color-primary); }
.md-text-field--error .md-text-field__box { border-bottom-color: var(--md-sys-color-error); }
.md-text-field--error .md-text-field__box:focus-within { border-bottom: 2px solid var(--md-sys-color-error); }
.md-text-field--disabled { opacity: .38; cursor: default; }
.md-text-field--disabled .md-text-field__input { cursor: default; }
.md-text-field__label { position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
  font-size: var(--md-sys-typescale-body-large); color: var(--md-sys-color-on-surface-variant); pointer-events: none; transition: all .15s; }
.md-text-field__label--floated,
.md-text-field__box:focus-within .md-text-field__label { top: 8px; transform: none; font-size: var(--md-sys-typescale-body-small); }
.md-text-field__box:focus-within .md-text-field__label { color: var(--md-sys-color-primary); }
.md-text-field--error .md-text-field__box:focus-within .md-text-field__label,
.md-text-field--error .md-text-field__label { color: var(--md-sys-color-error); }
.md-text-field__input { width: 100%; box-sizing: border-box; border: none; outline: none; background: transparent;
  padding: 22px 16px 6px; font: inherit; font-size: var(--md-sys-typescale-body-large); color: var(--md-sys-color-on-surface); }
.md-text-field__input::placeholder { color: var(--md-sys-color-on-surface-variant); }
.md-text-field__error { margin: 0; padding: 0 16px; font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-error); }
</style>
