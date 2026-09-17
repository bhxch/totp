<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ x: number; y: number; open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const EST_WIDTH = 140
const EST_HEIGHT = 200
const GAP = 8

const rootRef = ref<HTMLElement | null>(null)

const pos = computed(() => {
  let left = props.x
  let top = props.y
  if (typeof window !== 'undefined') {
    if (left + EST_WIDTH > window.innerWidth) left = Math.max(GAP, window.innerWidth - EST_WIDTH - GAP)
    if (top + EST_HEIGHT > window.innerHeight) top = Math.max(GAP, window.innerHeight - EST_HEIGHT - GAP)
  }
  return { left, top }
})

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
/** 点外部关闭（document mousedown，开启期间挂载；同 MdSelect 自包含模式，批 4 抽查补齐——
 *  此前仅 Esc/点选收起，外点不收起） */
function onDocMousedown(e: MouseEvent) {
  if (!rootRef.value?.contains(e.target as Node)) emit('close')
}
watch(
  () => props.open,
  (open) => {
    if (open) {
      window.addEventListener('keydown', onKeydown)
      document.addEventListener('mousedown', onDocMousedown)
    } else {
      window.removeEventListener('keydown', onKeydown)
      document.removeEventListener('mousedown', onDocMousedown)
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('mousedown', onDocMousedown)
})
</script>
<template>
  <div v-if="open" ref="rootRef" class="md-menu" role="menu" :style="`left: ${pos.left}px; top: ${pos.top}px;`"><slot /></div>
</template>
<style scoped>
.md-menu { position: fixed; z-index: 1100; min-width: 120px; padding: 6px 0; border-radius: 4px; /* M3 menu=extra-small 4dp(审查 X9) */
  background: var(--md-sys-color-surface-container-high);
  box-shadow: inset 0 0 0 1px var(--md-sys-color-outline-variant), 0 2px 8px var(--md-sys-color-shadow); }
</style>
