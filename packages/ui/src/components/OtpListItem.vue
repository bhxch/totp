<script setup lang="ts">
import type { OtpEntry } from '@totp/core'
import { computed, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MdIconButton from './md/MdIconButton.vue'
import { avatarStyleOf } from './avatarColor'
import { CODE_PLACEHOLDER } from '../composables/useOtpCodes'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  entry: OtpEntry
  code: string
  remaining: number
  progress: number
  /** [可选] secret 非法时的错误信息（鼠标悬停查看具体原因） */
  error?: string
  /** 图标视图：html=builtin path 包裹片段（svg innerHTML，fill currentColor）；src=dataUrl；均缺省回退首字母 avatar */
  icon?: { html?: string; src?: string }
  /** 宿主是否接了条目右键菜单（CodesPage/popup 已接，默认 true）；未接宿主（mini）传 false：不声明 aria-haspopup，右键恢复浏览器默认 */
  contextMenu?: boolean
  /** 是否渲染行内 QR 按钮（默认 true）；未接 QR 面板的宿主（mini）传 false 移除死入口 */
  showQr?: boolean
  /** 行首展示序号（1-based，宿主按当前排序传入）；缺省不渲染序号列。
   *  CodesPage 经 #lead slot 覆盖此区域为「拖拽把手/序号」hover 切换（④C） */
  index?: number
}>(), {
  // 注意：Boolean prop 有 Vue 运行时 casting（未传即 false），默认开启的两项必须显式给默认值
  contextMenu: true,
  showQr: true,
})
const emit = defineEmits<{ copy: []; qr: []; context: [event: MouseEvent] }>()

const hasContextMenu = computed(() => props.contextMenu !== false)
const showQrButton = computed(() => props.showQr !== false)

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

/** I61：环形按剩余比例绘制。每秒一次离散跳变（Aegis 等主流 TOTP 应用同款）——刻意不用 CSS
 * transition 补间：stroke-dashoffset 是 paint 属性无合成器加速，1s linear 补间会把每秒一次
 * 的跳变放大为每条目常驻 ~60fps SVG 重绘（2026-09-28 GPU profile 实锤 9 条目即 4% GPU） */
const dashOffset = computed(() => CIRCUMFERENCE * (1 - props.progress))

/** ④A：周期最后三分之一（remaining ≤ period/3）倒计时环与数字转醒目错误色。
 *  杂-I1：仅限会过期的码——hotp 按计数取码永不过期（环末三分之一转红无语义）；
 *  占位码 '------'（首帧 codes 未就绪）无到期概念，且 fallback progress 落 1/3 区间
 *  会闪一帧红，两者均排除。totp/steam/yandex 均时间基（yandex counter 亦由 nowMs 推导） */
const urgent = computed(() => props.progress <= 1 / 3 && props.entry.type !== 'hotp' && props.code !== CODE_PLACEHOLDER)

/** 批④ §5：无图标时首字母 avatar 按 issuer 哈希从主题 10 子色取底色；有图标时 undefined 保留 .avatar 默认底色 */
const avatarStyle = computed(() => (props.icon?.html || props.icon?.src ? undefined : avatarStyleOf(props.entry.issuer)))

function grouped(code: string): string {
  return code.length === 5 || code.length === 7 || code.length === 8 ? code : code.replace(/(\d{3})(\d+)/, '$1 $2')
}

/** 右键菜单：阻止默认浏览器菜单，上抛 event 给父组件在 (x,y) 渲染自定义菜单。
 *  键盘可达性：根元素 tabindex=0 可聚焦，Context Menu 键 / Shift+F10 会在焦点元素上派发
 *  contextmenu 事件 → 键盘用户可触达右键菜单；仅当宿主接入菜单（contextMenu≠false）时
 *  阻止默认并上抛，根上的 aria-haspopup="menu" 同步向 AT 声明该入口（B6：mini 未接不声明） */
function onContextMenu(e: MouseEvent): void {
  if (!hasContextMenu.value) return
  e.preventDefault()
  emit('context', e)
}
</script>

<template>
  <!-- F7(B3)：键盘揭示与双击同链——根元素 Shift+Enter 复用 onDblclick 的揭示+8s 自动打回，
       无障碍：AT/纯键盘用户此前只能复制不可见码；.prevent 阻止默认（如表单内换行） -->
  <div
    class="otp-item"
    role="button"
    tabindex="0"
    :aria-haspopup="hasContextMenu ? 'menu' : undefined"
    @click="emit('copy')"
    @dblclick="onDblclick"
    @keydown.enter="emit('copy')"
    @keydown.shift.enter.prevent="onDblclick"
    @contextmenu="onContextMenu"
  >
    <!-- ④A：行首序号列（index 传入即渲染）；#lead slot 供 CodesPage 覆盖为把手/序号 hover 切换 -->
    <span v-if="$slots.lead || index !== undefined" class="index"><slot name="lead">{{ index }}</slot></span>
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
      <!-- aria-live(F7 无障碍闭环):揭示/打回时 .code 文本动态变化且从不获得焦点,读屏用户
           仅靠聚焦无法感知——polite 声明让揭示的真码与 8s 后的打回被自动播报;倒计时在
           aria-hidden 的 SVG 内,不会造成播报噪音 -->
      <span
        :class="['code', { invalid: code === 'INVALID', revealed: revealed && code !== 'INVALID' }]"
        :title="code === 'INVALID' ? t('otpListItem.invalidTitle', { message: error ?? '' }) : undefined"
        aria-live="polite"
      >{{ displayed }}</span>
      <!-- M-3：内嵌按钮只 stop click 不够——快速双击按钮的 dblclick 会冒泡到根元素触发揭示
           （QR 弹窗打开瞬间底层码明文），按钮层须一并 stop dblclick -->
      <MdIconButton class="copy" :title="t('otpListItem.copyTitle')" :aria-label="t('otpListItem.copyTitle')" @click.stop="emit('copy')" @dblclick.stop>⧉</MdIconButton>
      <MdIconButton v-if="showQrButton" class="show-qr" :title="t('otpListItem.qrTitle')" :aria-label="t('otpListItem.qrTitle')" @click.stop="emit('qr')" @dblclick.stop>▣</MdIconButton>
      <svg viewBox="0 0 36 36" class="ring" :class="{ urgent }" aria-hidden="true">
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
/* ④A：行首序号列（窄列定宽防跳字；tabular-nums 数字等宽） */
.index { flex: none; min-width: 20px; text-align: center; font-variant-numeric: tabular-nums; font-size: var(--md-sys-typescale-body-small); opacity: .55; }
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
/* ④A：揭示态验证码转主题主色醒目（与倒计时紧急的错误红区分：主色=就绪可用，红=紧急） */
.code.revealed { color: var(--md-sys-color-primary); }
.show-qr { font-size: var(--md-sys-typescale-body-medium); }
.ring { width: 32px; height: 32px; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: var(--md-sys-color-outline-variant); stroke-width: 3; }
.ring-fg { fill: none; stroke: var(--md-sys-color-primary); stroke-width: 3; stroke-linecap: round; }
.ring-text { transform: rotate(90deg); transform-origin: 18px 18px; font-size: 11px; /* 豁免:SVG text 字号,按 SVG 视口定位,不接字阶 token */ fill: currentColor; }
/* ④A：周期最后三分之一——环与数字转 error 醒目色（currentColor 由 svg color 下发，text 恒继承） */
.ring.urgent { color: var(--md-sys-color-error); }
.ring.urgent .ring-fg { stroke: currentColor; }
</style>
