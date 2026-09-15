<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ open: boolean; headline?: string }>()
const emit = defineEmits<{ close: [] }>()

const dialogRef = ref<HTMLElement | null>(null)
let prevFocus: Element | null = null

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
function onDialogClick(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest?.('[data-md-close]')) emit('close')
}
function restoreFocus() {
  if (prevFocus instanceof HTMLElement) prevFocus.focus()
  prevFocus = null
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      prevFocus = document.activeElement
      window.addEventListener('keydown', onKeydown)
      void nextTick(() => dialogRef.value?.focus())
    } else {
      window.removeEventListener('keydown', onKeydown)
      restoreFocus()
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  restoreFocus()
})
</script>
<template>
  <div v-if="open" class="md-dialog__scrim" @click="emit('close')">
    <div ref="dialogRef" class="md-dialog" role="dialog" aria-modal="true" tabindex="-1" @click.stop="onDialogClick">
      <h2 v-if="headline" class="md-dialog__headline">{{ headline }}</h2>
      <div class="md-dialog__body"><slot /></div>
      <div v-if="$slots.actions" class="md-dialog__actions"><slot name="actions" /></div>
    </div>
  </div>
</template>
<style scoped>
.md-dialog__scrim { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center;
  background: color-mix(in srgb, var(--md-sys-color-scrim) 55%, transparent); }
.md-dialog { width: 90%; max-width: 560px; padding: 24px; border-radius: 12px;
  background: var(--md-sys-color-surface-container-high); color: var(--md-sys-color-on-surface);
  box-shadow: 0 4px 12px var(--md-sys-color-shadow); }
.md-dialog:focus-visible { outline: none; }
.md-dialog__headline { margin: 0 0 12px; font-size: 20px; font-weight: 500; }
.md-dialog__body { font-size: 14px; }
.md-dialog__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
</style>
