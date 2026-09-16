<script setup lang="ts">
import type { OtpEntry } from '@totp/core'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'

defineProps<{
  open: boolean
  /** 揭示目标；仅 open=true 时非 null 保证 */
  entry: OtpEntry | null
}>()

const emit = defineEmits<{ close: [] }>()

/** 自 旧单页 reveal 模态逐字迁移：显前 4 + 后 4，中间遮蔽（≤8 全显），避免整段密钥常驻 DOM */
function maskSecret(secret: string): string {
  const s = secret.replace(/\s+/g, '')
  if (s.length <= 8) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}
</script>

<template>
  <MdDialog :open="open" :headline="`${entry?.issuer} — 密钥`" @close="emit('close')">
    <code v-if="entry" class="reveal-secret">{{ maskSecret(entry.secret) }}</code>
    <p class="reveal-hint">出于安全考虑，仅显示密钥前后各 4 位；如需完整密钥请使用编辑功能。</p>
    <template #actions>
      <MdButton variant="text" data-md-close>关闭</MdButton>
    </template>
  </MdDialog>
</template>

<style scoped>
.reveal-secret { display: block; font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: 1px;
  background: var(--md-sys-color-surface-container-highest); padding: 10px; border-radius: 6px;
  text-align: center; word-break: break-all; }
.reveal-hint { font-size: 12px; opacity: .65; margin: 8px 0 0; }
</style>
