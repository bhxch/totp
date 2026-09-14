<script setup lang="ts">
defineProps<{
  entry: import('@totp/core').OtpEntry
  code: string
  remaining: number
  progress: number
  /** 图标视图：html=builtin path 包裹片段（svg innerHTML，fill currentColor）；src=dataUrl；均缺省回退首字母 avatar */
  icon?: { html?: string; src?: string }
}>()
const emit = defineEmits<{ copy: [] }>()

function grouped(code: string): string {
  return code.length === 5 || code.length === 7 || code.length === 8 ? code : code.replace(/(\d{3})(\d+)/, '$1 $2')
}
</script>

<template>
  <div class="otp-item" role="button" tabindex="0" @click="emit('copy')" @keydown.enter="emit('copy')">
    <span class="avatar">
      <svg v-if="icon?.html" viewBox="0 0 24 24" class="icon-svg" aria-hidden="true" v-html="icon.html" />
      <img v-else-if="icon?.src" :src="icon.src" class="icon-img" alt="" />
      <template v-else>{{ entry.issuer.slice(0, 1).toUpperCase() || '?' }}</template>
    </span>
    <div class="meta">
      <div class="issuer">{{ entry.issuer }}</div>
      <div class="label">{{ entry.label }}</div>
    </div>
    <div class="right">
      <span class="code">{{ grouped(code) }}</span>
      <svg viewBox="0 0 36 36" class="ring" aria-hidden="true">
        <circle cx="18" cy="18" r="16" class="ring-bg" />
        <circle
          cx="18" cy="18" r="16" class="ring-fg"
          :stroke-dasharray="100.53"
          :stroke-dashoffset="100.53 * (1 - progress)"
        />
        <text x="18" y="21.5" text-anchor="middle" class="ring-text">{{ remaining }}</text>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.otp-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; cursor: pointer; border-radius: 8px; }
.otp-item:hover { background: rgba(128, 128, 128, 0.15); }
.avatar { width: 36px; height: 36px; border-radius: 50%; background: #5b6b8c; color: #fff; display: grid; place-items: center; font-weight: 600; flex: none; overflow: hidden; }
.icon-svg { width: 22px; height: 22px; fill: currentColor; }
.icon-img { width: 100%; height: 100%; object-fit: cover; }
.meta { flex: 1; min-width: 0; }
.issuer { font-weight: 600; }
.label { font-size: 12px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.right { display: flex; align-items: center; gap: 8px; }
.code { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: 1px; }
.ring { width: 32px; height: 32px; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: rgba(128,128,128,.3); stroke-width: 3; }
.ring-fg { fill: none; stroke: #4a90d9; stroke-width: 3; stroke-linecap: round; }
.ring-text { transform: rotate(90deg); transform-origin: 18px 18px; font-size: 11px; fill: currentColor; }
</style>
