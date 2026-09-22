<script setup lang="ts">
import { computed } from 'vue'
import { MdButton, MdDialog } from '@totp/ui'
import { isToolConfirmItem, type McpConsentItem } from './mcpApprovalQueue'

const props = defineProps<{
  open: boolean
  /** 待裁定项（mcp://approval | mcp://tool-approval 载荷）；仅 open=true 时非 null 保证。
   *  携带 id 的为工具级确认形态（T7） */
  request: McpConsentItem | null
  /** 壳层取词函数（desktop 壳无 useI18n 注入，沿 App.vue tr() 口径；内部读响应式 locale ref，切换联动） */
  t: (key: string, params?: Record<string, unknown>) => string
}>()

/** 工具级确认形态判定：携带 id（Rust BridgeShared oneshot 键）即逐次 Allow/Deny 的工具确认 */
const isToolConfirm = computed(() => props.request !== null && isToolConfirmItem(props.request))

/** 工具确认标题「允许执行 <tool>？」；首连形态沿用原标题 */
const headline = computed(() => {
  const r = props.request
  if (r !== null && isToolConfirmItem(r)) return props.t('mcpConsent.toolConfirmTitle', { tool: r.tool })
  return props.t('mcpConsent.title')
})

/** resolve=首连三键裁定（宿主回执 mcp_approval_response：deny=冷却/once=限时放行/trust=入白名单）；
 *  allow=工具确认放行（宿主回执 mcp_respond result:true，逐次即焚无记忆授权）；
 *  close=Esc 或点遮罩或工具确认的 Deny 键，宿主按通道 deny 回执（首连=deny 进 60s 冷却；工具确认=拒绝） */
const emit = defineEmits<{ resolve: ['deny' | 'once' | 'trust']; allow: []; close: [] }>()
</script>

<template>
  <MdDialog :open="open" :headline="headline" @close="emit('close')">
    <p class="consent-row">{{ t('mcpConsent.client') }}：<code class="consent-ident">{{ request?.ident }}</code></p>
    <p class="consent-row">{{ t('mcpConsent.tool') }}：<code class="consent-ident">{{ request?.tool }}</code></p>
    <p v-if="isToolConfirm" class="consent-hint">{{ t('mcpConsent.toolConfirmBody') }}</p>
    <p v-else class="consent-hint">{{ t('mcpConsent.hint') }}</p>
    <template #actions>
      <MdButton variant="text" danger @click="isToolConfirm ? emit('close') : emit('resolve', 'deny')">
        {{ t('mcpConsent.deny') }}
      </MdButton>
      <MdButton v-if="isToolConfirm" variant="tonal" @click="emit('allow')">{{ t('mcpConsent.allow') }}</MdButton>
      <template v-else>
        <MdButton variant="tonal" @click="emit('resolve', 'once')">{{ t('mcpConsent.once') }}</MdButton>
        <MdButton @click="emit('resolve', 'trust')">{{ t('mcpConsent.trust') }}</MdButton>
      </template>
    </template>
  </MdDialog>
</template>

<style scoped>
.consent-row { font-size: var(--md-sys-typescale-body-medium); margin: 0 0 6px; }
.consent-ident { font-family: ui-monospace, monospace; font-size: var(--md-sys-typescale-body-small);
  background: var(--md-sys-color-surface-container-highest); padding: 2px 6px; border-radius: 6px; word-break: break-all; }
.consent-hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 8px 0 0; }
</style>
