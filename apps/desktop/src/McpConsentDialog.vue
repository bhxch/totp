<script setup lang="ts">
import { MdButton, MdDialog } from '@totp/ui'

defineProps<{
  open: boolean
  /** 待审批请求（mcp://approval 载荷）；仅 open=true 时非 null 保证 */
  request: { ident: string; tool: string } | null
  /** 壳层取词函数（desktop 壳无 useI18n 注入，沿 App.vue tr() 口径；内部读响应式 locale ref，切换联动） */
  t: (key: string) => string
}>()

/** resolve=三键裁定（宿主回执 mcp_approval_response：deny=冷却/once=限时放行/trust=入白名单）；
 *  close=Esc 或点遮罩，宿主按 deny 回执（审批无会话无 TTL，关闭即终局裁定，
 *  随 DENY_COOLDOWN 60s 冷却自然退避——「关掉=别再问了」） */
const emit = defineEmits<{ resolve: ['deny' | 'once' | 'trust']; close: [] }>()
</script>

<template>
  <MdDialog :open="open" :headline="t('mcpConsent.title')" @close="emit('close')">
    <p class="consent-row">{{ t('mcpConsent.client') }}：<code class="consent-ident">{{ request?.ident }}</code></p>
    <p class="consent-row">{{ t('mcpConsent.tool') }}：<code class="consent-ident">{{ request?.tool }}</code></p>
    <p class="consent-hint">{{ t('mcpConsent.hint') }}</p>
    <template #actions>
      <MdButton variant="text" danger @click="emit('resolve', 'deny')">{{ t('mcpConsent.deny') }}</MdButton>
      <MdButton variant="tonal" @click="emit('resolve', 'once')">{{ t('mcpConsent.once') }}</MdButton>
      <MdButton @click="emit('resolve', 'trust')">{{ t('mcpConsent.trust') }}</MdButton>
    </template>
  </MdDialog>
</template>

<style scoped>
.consent-row { font-size: var(--md-sys-typescale-body-medium); margin: 0 0 6px; }
.consent-ident { font-family: ui-monospace, monospace; font-size: var(--md-sys-typescale-body-small);
  background: var(--md-sys-color-surface-container-highest); padding: 2px 6px; border-radius: 6px; word-break: break-all; }
.consent-hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 8px 0 0; }
</style>
