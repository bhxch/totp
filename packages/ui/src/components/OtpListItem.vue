<script setup lang="ts">
import type { OtpEntry } from '@totp/core'
import { computed } from 'vue'

const props = defineProps<{
  entry: OtpEntry
  code: string
  remaining: number
  progress: number
  /** [可选] secret 非法时的错误信息（鼠标悬停查看具体原因） */
  error?: string
  /** 图标视图：html=builtin path 包裹片段（svg innerHTML，fill currentColor）；src=dataUrl；均缺省回退首字母 avatar */
  icon?: { html?: string; src?: string }
}>()
const emit = defineEmits<{ copy: []; reveal: []; context: [event: MouseEvent] }>()

/** I52：圆周按 SVG 半径精确计算，避免硬编码 100.53 在改 viewBox/半径时产生视觉偏差 */
const RING_R = 16
const CIRCUMFERENCE = 2 * Math.PI * RING_R

/** I61：环形按剩余比例绘制；外层 CSS transition: stroke-dashoffset 1s linear 实现平滑过渡（每秒一次重算 progress） */
const dashOffset = computed(() => CIRCUMFERENCE * (1 - props.progress))

function grouped(code: string): string {
  return code.length === 5 || code.length === 7 || code.length === 8 ? code : code.replace(/(\d{3})(\d+)/, '$1 $2')
}

/** 右键菜单：阻止默认浏览器菜单，上抛 event 给父组件在 (x,y) 渲染自定义菜单 */
function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
  emit('context', e)
}
</script>

<template>
  <div
    class="otp-item"
    role="button"
    tabindex="0"
    @click="emit('copy')"
    @keydown.enter="emit('copy')"
    @contextmenu="onContextMenu"
  >
    <span class="avatar">
      <svg v-if="icon?.html" viewBox="0 0 24 24" class="icon-svg" aria-hidden="true" v-html="icon.html" />
      <img v-else-if="icon?.src" :src="icon.src" class="icon-img" alt="" />
      <template v-else>{{ entry.issuer.slice(0, 1).toUpperCase() || '?' }}</template>
    </span>
    <div class="meta">
      <div class="issuer">
        <span v-if="entry.pinned" class="pin" title="已置顶">★</span>
        {{ entry.issuer }}
      </div>
      <div class="label">{{ entry.label }}</div>
    </div>
    <div class="right">
      <span
        :class="['code', { invalid: code === 'INVALID' }]"
        :title="code === 'INVALID' ? `密钥非法：${error ?? ''}` : undefined"
      >{{ code === 'INVALID' ? '密钥非法' : grouped(code) }}</span>
      <button type="button" class="reveal" title="显示密钥" @click.stop="emit('reveal')">🔑</button>
      <svg viewBox="0 0 36 36" class="ring" aria-hidden="true">
        <circle cx="18" cy="18" r="16" class="ring-bg" />
        <circle
          cx="18" cy="18" r="16" class="ring-fg"
          :stroke-dasharray="CIRCUMFERENCE"
          :stroke-dashoffset="dashOffset"
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
.issuer { font-weight: 600; display: flex; align-items: center; gap: 4px; }
.pin { color: #f5a623; font-size: 14px; }
.label { font-size: 12px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.right { display: flex; align-items: center; gap: 8px; }
.code { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: 1px; }
.code.invalid { color: #d9534f; font-size: 13px; cursor: help; }
.reveal { border: none; background: none; cursor: pointer; padding: 4px; font-size: 14px; opacity: 0.5; }
.reveal:hover { opacity: 1; }
.ring { width: 32px; height: 32px; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: rgba(128,128,128,.3); stroke-width: 3; }
.ring-fg { fill: none; stroke: #4a90d9; stroke-width: 3; stroke-linecap: round; transition: stroke-dashoffset 1s linear; }
.ring-text { transform: rotate(90deg); transform-origin: 18px 18px; font-size: 11px; fill: currentColor; }
</style>
