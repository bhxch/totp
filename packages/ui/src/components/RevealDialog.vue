<script setup lang="ts">
import type { OtpEntry } from '@totp/core'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'

const { t } = useI18n()

const props = defineProps<{
  open: boolean
  /** 揭示目标；仅 open=true 时非 null 保证 */
  entry: OtpEntry | null
}>()

const emit = defineEmits<{ close: [] }>()

/** 审查 Minor：headline 兜底——契约破坏（entry=null）时原插值渲染「undefined — 密钥」，
 *  改计算属性回退中性占位「密钥」 */
const headline = computed(() => (props.entry ? t('revealDialog.headline', { issuer: props.entry.issuer }) : t('revealDialog.secret')))

/** 自 旧单页 reveal 模态逐字迁移：显前 4 + 后 4，中间遮蔽（≤8 全显），避免整段密钥常驻 DOM */
function maskSecret(secret: string): string {
  const s = secret.replace(/\s+/g, '')
  if (s.length <= 8) return s
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}
</script>

<template>
  <MdDialog :open="open" :headline="headline" @close="emit('close')">
    <code v-if="entry" class="reveal-secret">{{ maskSecret(entry.secret) }}</code>
    <p class="reveal-hint">{{ t('revealDialog.hint') }}</p>
    <template #actions>
      <MdButton variant="text" data-md-close>{{ t('revealDialog.close') }}</MdButton>
    </template>
  </MdDialog>
</template>

<style scoped>
.reveal-secret { display: block; font-family: ui-monospace, monospace; font-size: var(--md-sys-typescale-code-large); letter-spacing: 1px;
  background: var(--md-sys-color-surface-container-highest); padding: 10px; border-radius: 6px;
  text-align: center; word-break: break-all; }
.reveal-hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 8px 0 0; }
</style>
