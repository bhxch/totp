<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated'; disabled?: boolean; type?: 'button' | 'submit'; danger?: boolean }>(), { variant: 'filled', disabled: false, type: 'button', danger: false })
const emit = defineEmits<{ click: [event: MouseEvent] }>()
</script>
<template>
  <button class="md-btn" :class="danger ? 'md-btn--danger' : `md-btn--${variant}`" :type="type" :disabled="disabled" @click="emit('click', $event)"><slot /></button>
</template>
<style scoped>
.md-btn { border: none; cursor: pointer; border-radius: 100px; padding: 0 24px; height: 40px;
  font: inherit; font-size: var(--md-sys-typescale-body-medium); font-weight: 500; display: inline-flex; align-items: center; gap: 8px;
  transition: box-shadow .15s; position: relative; }
.md-btn:disabled { opacity: .38; cursor: default; }
.md-btn::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: transparent; transition: background-color .15s; }
.md-btn:not(:disabled):hover::after { background: color-mix(in srgb, currentColor 8%, transparent); }
.md-btn--filled { background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); }
.md-btn--tonal { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.md-btn--outlined { background: transparent; color: var(--md-sys-color-primary); box-shadow: inset 0 0 0 1px var(--md-sys-color-outline); }
.md-btn--text { background: transparent; color: var(--md-sys-color-primary); padding: 0 12px; }
.md-btn--elevated { background: var(--md-sys-color-surface-container-low); color: var(--md-sys-color-primary); box-shadow: 0 1px 3px var(--md-sys-color-shadow); }
/* danger:text 形 + error 色(危险动作);hover 的 8% 叠色走通用 currentColor 规则,即 error 8% */
.md-btn--danger { background: transparent; color: var(--md-sys-color-error); padding: 0 12px; }
.md-btn--danger:not(:disabled):hover::after { background: color-mix(in srgb, var(--md-sys-color-error) 8%, transparent); }
.md-btn:not(:disabled):focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
.md-btn--danger:not(:disabled):focus-visible { outline-color: var(--md-sys-color-error); }
</style>
