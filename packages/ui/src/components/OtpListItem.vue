<script setup lang="ts">
import type { OtpEntry } from '@totp/core'
import { computed, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MdIconButton from './md/MdIconButton.vue'
import { avatarStyleOf } from './avatarColor'

const { t } = useI18n()

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
const emit = defineEmits<{ copy: []; qr: []; context: [event: MouseEvent] }>()

/** 验收条目3：6 位码默认打码；双击显示 8 秒后自动打回（spec §6 固定时长，不可配置） */
const MASK_CODE = '••• •••'
const REVEAL_MS = 8000
const revealed = ref(false)
let revealTimer: ReturnType<typeof setTimeout> | null = null
function onDblclick(): void {
  revealed.value = true
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    revealed.value = false
    revealTimer = null
  }, REVEAL_MS)
}
onScopeDispose(() => { if (revealTimer) clearTimeout(revealTimer) })

/** 显示口径：INVALID 优先（错误提示非秘密）；打码态恒 MASK；显示态走 grouped 分组 */
const displayed = computed(() => {
  if (props.code === 'INVALID') return t('otpListItem.invalid')
  if (!revealed.value) return MASK_CODE
  return grouped(props.code)
})

/** I52：圆周按 SVG 半径精确计算，避免硬编码 100.53 在改 viewBox/半径时产生视觉偏差 */
const RING_R = 16
const CIRCUMFERENCE = 2 * Math.PI * RING_R

/** I61：环形按剩余比例绘制；外层 CSS transition: stroke-dashoffset 1s linear 实现平滑过渡（每秒一次重算 progress） */
const dashOffset = computed(() => CIRCUMFERENCE * (1 - props.progress))

/** 批④ §5：无图标时首字母 avatar 按 issuer 哈希从主题 10 子色取底色；有图标时 undefined 保留 .avatar 默认底色 */
const avatarStyle = computed(() => (props.icon?.html || props.icon?.src ? undefined : avatarStyleOf(props.entry.issuer)))

function grouped(code: string): string {
  return code.length === 5 || code.length === 7 || code.length === 8 ? code : code.replace(/(\d{3})(\d+)/, '$1 $2')
}

/** 右键菜单：阻止默认浏览器菜单，上抛 event 给父组件在 (x,y) 渲染自定义菜单。
 *  键盘可达性：根元素 tabindex=0 可聚焦，Context Menu 键 / Shift+F10 会在焦点元素上派发
 *  contextmenu 事件 → 键盘用户可触达右键菜单，根上的 aria-haspopup="menu" 向 AT 声明该入口 */
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
    aria-haspopup="menu"
    @click="emit('copy')"
    @dblclick="onDblclick"
    @keydown.enter="emit('copy')"
    @contextmenu="onContextMenu"
  >
    <span class="avatar" :style="avatarStyle ?? undefined">
      <svg v-if="icon?.html" viewBox="0 0 24 24" class="icon-svg" aria-hidden="true" v-html="icon.html" />
      <img v-else-if="icon?.src" :src="icon.src" class="icon-img" alt="" />
      <template v-else>{{ entry.issuer.slice(0, 1).toUpperCase() || '?' }}</template>
    </span>
    <div class="meta">
      <div class="issuer">
        <span v-if="entry.pinned" class="pin" :title="t('otpListItem.pinnedTitle')">★</span>
        {{ entry.issuer }}
      </div>
      <div class="label">{{ entry.label }}</div>
    </div>
    <div class="right">
      <span
        :class="['code', { invalid: code === 'INVALID' }]"
        :title="code === 'INVALID' ? t('otpListItem.invalidTitle', { message: error ?? '' }) : undefined"
      >{{ displayed }}</span>
      <MdIconButton class="copy" :title="t('otpListItem.copyTitle')" :aria-label="t('otpListItem.copyTitle')" @click.stop="emit('copy')">⧉</MdIconButton>
      <MdIconButton class="show-qr" :title="t('otpListItem.qrTitle')" :aria-label="t('otpListItem.qrTitle')" @click.stop="emit('qr')">▣</MdIconButton>
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
.otp-item:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); display: grid; place-items: center; font-weight: 600; flex: none; overflow: hidden; }
.icon-svg { width: 22px; height: 22px; fill: currentColor; }
.icon-img { width: 100%; height: 100%; object-fit: cover; }
.meta { flex: 1; min-width: 0; }
.issuer { font-weight: 600; display: flex; align-items: center; gap: 4px; }
.pin { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); }
.label { font-size: var(--md-sys-typescale-body-small); opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.right { display: flex; align-items: center; gap: 8px; }
.code { font-family: system-ui, sans-serif; font-weight: 700; font-variant-numeric: tabular-nums; font-size: var(--md-sys-typescale-code-large); letter-spacing: 1px; }
.code.invalid { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); cursor: help; }
.show-qr { font-size: var(--md-sys-typescale-body-medium); }
.ring { width: 32px; height: 32px; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: var(--md-sys-color-outline-variant); stroke-width: 3; }
.ring-fg { fill: none; stroke: var(--md-sys-color-primary); stroke-width: 3; stroke-linecap: round; transition: stroke-dashoffset 1s linear; }
.ring-text { transform: rotate(90deg); transform-origin: 18px 18px; font-size: 11px; /* 豁免:SVG text 字号,按 SVG 视口定位,不接字阶 token */ fill: currentColor; }
</style>
