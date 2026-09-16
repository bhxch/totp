<script lang="ts">
// 模块级计数器:跨实例唯一(测试中每次 mount 为独立 app,useId() 会重置)
let errorIdCounter = 0
</script>
<script setup lang="ts">
withDefaults(defineProps<{ modelValue: string; label: string; type?: string; error?: string; placeholder?: string; ariaLabel?: string }>(), { type: 'text', error: '', placeholder: '' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const errorId = `md-text-field-error-${++errorIdCounter}`
</script>
<template>
  <div class="md-text-field" :class="{ 'md-text-field--error': !!error }">
    <label class="md-text-field__box">
      <span class="md-text-field__label" :class="{ 'md-text-field__label--floated': !!modelValue || !!placeholder }">{{ label }}</span>
      <input class="md-text-field__input" :type="type" :value="modelValue" :placeholder="placeholder"
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
.md-text-field__label { position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
  font-size: 16px; color: var(--md-sys-color-on-surface-variant); pointer-events: none; transition: all .15s; }
.md-text-field__label--floated,
.md-text-field__box:focus-within .md-text-field__label { top: 8px; transform: none; font-size: 12px; }
.md-text-field__box:focus-within .md-text-field__label { color: var(--md-sys-color-primary); }
.md-text-field--error .md-text-field__box:focus-within .md-text-field__label,
.md-text-field--error .md-text-field__label { color: var(--md-sys-color-error); }
.md-text-field__input { width: 100%; box-sizing: border-box; border: none; outline: none; background: transparent;
  padding: 22px 16px 6px; font: inherit; font-size: 16px; color: var(--md-sys-color-on-surface); }
.md-text-field__input::placeholder { color: var(--md-sys-color-on-surface-variant); }
.md-text-field__error { margin: 0; padding: 0 16px; font-size: 12px; color: var(--md-sys-color-error); }
</style>
