<script setup lang="ts">
import type { OtpEntry } from '@totp/core'
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { avatarStyleOf } from './avatarColor'
import { CODE_PLACEHOLDER } from '../composables/useOtpCodes'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  entry: OtpEntry
  code: string
  /** [兼容签名] 环形倒计时已移除（Aegis 式两行布局：行顶进度条替环形），本 prop 不再渲染。
   *  保留声明是三宿主 v-bind 透传（codes.get() 携带 remaining）的兼容需要，勿删 */
  remaining: number
  progress: number
  /** [可选] secret 非法时的错误信息（鼠标悬停查看具体原因） */
  error?: string
  /** 图标视图：html=builtin path 包裹片段（svg innerHTML，fill currentColor）；src=dataUrl；均缺省回退首字母 avatar */
  icon?: { html?: string; src?: string }
  /** 宿主是否接了条目右键菜单（CodesPage/popup 已接，默认 true）；未接宿主（mini）传 false：不声明 aria-haspopup，右键恢复浏览器默认 */
  contextMenu?: boolean
  /** 紧凑档（MD3 48px 行高，QuickCodesPanel 快速窗用）；默认 56px 标准档 */
  compact?: boolean
  /** 行首展示序号（1-based，宿主按当前排序传入）；缺省不渲染序号列。
   *  CodesPage 经 #lead slot 覆盖此区域为「拖拽把手/序号」hover 切换（④C） */
  index?: number
}>(), {
  // 注意：Boolean prop 有 Vue 运行时 casting（未传即 false），默认开启的项必须显式给默认值
  contextMenu: true,
  compact: false,
})
const emit = defineEmits<{ copy: []; context: [event: MouseEvent] }>()

const hasContextMenu = computed(() => props.contextMenu !== false)

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

/** Aegis 式两行布局上行标题：issuer/label 以「/」合并单行；二者缺一只显其一（P3 item-layout） */
const titleLine = computed(() => {
  if (props.entry.issuer) return props.entry.label ? `${props.entry.issuer}/${props.entry.label}` : props.entry.issuer
  return props.entry.label
})

/** 跑马灯仅在标题溢出可视宽时启用（未溢出无动画，不建合成层）。checkOverflow 四触发路径：
 *  onMounted（首帧）+ document.fonts.ready（R3-M7：字体加载只变 scrollWidth，ResizeObserver
 *  感知不到，就绪后防御性重测；缺 fonts API 的环境守卫跳过）+ watch(issuer/label, flush:'post'，
 *  改名/换宿主数据后重测) + ResizeObserver（宿主面板/窗口宽度变化）。jsdom 无布局
 *  （scrollWidth/clientWidth 恒 0）也无 ResizeObserver，后者 try/catch 跳过；组件测试经
 *  mock 元素尺寸 + setProps 走 watch 路径验证 */
const titleEl = ref<HTMLElement | null>(null)
const overflowing = ref(false)
/** 溢出时实测可视宽（clientWidth）注入 CSS 变量供 keyframes 终点用：
 *  硬编码 160px 在宽行滚不足（终点露字）、窄行过头，实测值随宿主宽度自适应 */
const viewportWidth = ref(0)
function checkOverflow(): void {
  const el = titleEl.value
  overflowing.value = el !== null && el.scrollWidth > el.clientWidth
  viewportWidth.value = overflowing.value && el !== null ? el.clientWidth : 0
}
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  checkOverflow()
  // R3-M7：字体后加载（webfont/系统字体替换）会把 scrollWidth 从回退字体宽度拉开，
  // 只变 scrollWidth 不触发 ResizeObserver——ready 后重测一次；卸载后 titleEl=null 走 no-op
  document.fonts?.ready?.then(() => { if (titleEl.value !== null) checkOverflow() })
  try {
    resizeObserver = new ResizeObserver(checkOverflow)
    resizeObserver.observe(titleEl.value!)
  } catch { /* jsdom 无 ResizeObserver：溢出检测退化为 onMounted + watch 两路径 */ }
})
watch([() => props.entry.issuer, () => props.entry.label], checkOverflow, { flush: 'post' })
onScopeDispose(() => resizeObserver?.disconnect())

/** 行顶进度条宽度（百分比字符串）。进度条刻意无 CSS transition：width 是 paint 属性无合成器加速，
 *  1s linear 补间会把每秒一次的离散跳变放大为每条目常驻 ~60fps 重绘（2026-09-28 GPU profile
 *  实锤 9 条目即 4% GPU，环形时代同款结论，P3 布局沿用该红线） */
const progressPct = computed(() => `${Math.round(props.progress * 100)}%`)

/** ④A：周期最后三分之一（remaining ≤ period/3）进度条转醒目错误色。
 *  杂-I1：仅限会过期的码——hotp 按计数取码永不过期（进度条末三分之一转红无语义）；
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
       无障碍：AT/纯键盘用户此前只能复制不可见码；.prevent 阻止默认（如表单内换行）。
       行内复制按钮已删（P3）：单击行（@click）即复制，copy emit 契约不变 -->
  <div
    class="otp-item"
    :class="{ 'otp-item--compact': compact }"
    role="button"
    tabindex="0"
    :aria-haspopup="hasContextMenu ? 'menu' : undefined"
    @click="emit('copy')"
    @dblclick="onDblclick"
    @keydown.enter="emit('copy')"
    @keydown.shift.enter.prevent="onDblclick"
    @contextmenu="onContextMenu"
  >
    <!-- P3：行顶进度条替环形倒计时（Aegis 同款 2px 线性条，宽度随 progress 每秒离散跳变，无 transition） -->
    <div class="progress-line" aria-hidden="true"><div class="progress-fill" :class="{ urgent }" :style="{ width: progressPct }" /></div>
    <!-- ④A：行首序号列（index 传入即渲染）；#lead slot 供 CodesPage 覆盖为把手/序号 hover 切换 -->
    <span v-if="$slots.lead || index !== undefined" class="index"><slot name="lead">{{ index }}</slot></span>
    <span class="avatar" :style="avatarStyle ?? undefined">
      <svg v-if="icon?.html" viewBox="0 0 24 24" class="icon-svg" aria-hidden="true" v-html="icon.html" />
      <img v-else-if="icon?.src" :src="icon.src" class="icon-img" alt="" />
      <template v-else>{{ entry.issuer.slice(0, 1).toUpperCase() || '?' }}</template>
    </span>
    <div class="meta">
      <!-- P3：上行=服务商/名称合并单行（超长跑马灯）；下行=大号验证码（行内 QR 钮已删，入口归右键菜单） -->
      <div class="title-line">
        <!-- R3-M8：★ 在裁切容器层（title-text 外），长名跑马灯滚动循环中置顶指示不再随文本滚出视野 -->
        <span v-if="entry.pinned" class="pin" :title="t('otpListItem.pinnedTitle')">★</span><span
          ref="titleEl"
          class="title-text"
          :class="{ marquee: overflowing }"
          :style="overflowing ? { '--marquee-viewport': `${viewportWidth}px` } : undefined"
        >{{ titleLine }}</span>
      </div>
      <div class="code-line">
        <!-- aria-live(F7 无障碍闭环):揭示/打回时 .code 文本动态变化且从不获得焦点,读屏用户
             仅靠聚焦无法感知——polite 声明让揭示的真码与 8s 后的打回被自动播报;进度条在
             aria-hidden 的 .progress-line 内,不会造成播报噪音 -->
        <span
          :class="['code', { invalid: code === 'INVALID', revealed: revealed && code !== 'INVALID' }]"
          :title="code === 'INVALID' ? t('otpListItem.invalidTitle', { message: error ?? '' }) : undefined"
          aria-live="polite"
        >{{ displayed }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* P3：position relative 供行顶进度条绝对定位。MD3 紧凑化：行盒 56px 档（padding 6px 16px +
   min-height 56px），width:100% 保证整行等宽（进度条等长兜底——宿主容器不再决定行宽） */
.otp-item { position: relative; display: flex; align-items: center; gap: 12px; padding: 6px 16px; min-height: 56px; width: 100%; cursor: pointer; border-radius: 8px; }
.otp-item:hover { background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-sys-state-layer-hover), transparent); }
/* pressed 态走 state-layer token（12%，同 MdIconButton pressed 口径） */
.otp-item:active { background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-sys-state-layer-pressed), transparent); }
/* 紧凑档：快速窗（QuickCodesPanel）48px 行高 */
.otp-item--compact { min-height: 48px; padding: 4px 12px; }
/* P3：行顶进度条（替环形倒计时）。刻意无 transition（GPU 红线，见 progressPct 注释） */
.progress-line { position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--md-sys-color-outline-variant); border-radius: 8px 8px 0 0; overflow: hidden; }
.progress-fill { height: 100%; background: var(--md-sys-color-primary); }
/* ④A：周期最后三分之一转 error 醒目色 */
.progress-fill.urgent { background: var(--md-sys-color-error); }
/* ④A：行首序号列（窄列定宽防跳字；tabular-nums 数字等宽）；色收 on-surface-variant（去 opacity hack，次级文本 M3 语义色） */
.index { flex: none; min-width: 20px; text-align: center; font-variant-numeric: tabular-nums; font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-on-surface-variant); }
.avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); display: grid; place-items: center; font-weight: 600; flex: none; overflow: hidden; }
.icon-svg { width: 22px; height: 22px; fill: currentColor; }
.icon-img { width: 100%; height: 100%; object-fit: cover; }
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
/* P3：上行标题裁切容器；R3-M8 起 ★ 与 title-text 并列为其 flex 子项（★ 恒固定不参与跑马灯），
   title-text inline-block 使 transform 跑马灯生效且 shrink-to-fit 宽度跟随容器（溢出时
   clientWidth=可视宽、scrollWidth=全文宽，checkOverflow 据此判定） */
.title-line { display: flex; overflow: hidden; white-space: nowrap; }
.title-text { display: inline-block; font-weight: 600; }
/* P3：超长跑马灯（约 8s/循环）；终点经 --marquee-viewport 注入实测可视宽（checkOverflow 写入，
   未溢出无变量），160px 为变量缺失保底；仅 overflowing 时启用，未溢出无动画 */
.title-text.marquee { animation: marquee 8s infinite; }
@keyframes marquee { 0%,15% { transform: translateX(0) } 50%,65% { transform: translateX(calc(-100% + var(--marquee-viewport, 160px))) } 100% { transform: translateX(0) } }
/* ★ 置顶指示（R3-M8：位于裁切容器层，flex 子项不被 translateX 带走）；4px 间距对齐原内嵌形态 */
.pin { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-medium); margin-right: 4px; flex: none; }
/* P3：下行=大号验证码 */
.code-line { display: flex; align-items: center; gap: 8px; }
.code { font-family: system-ui, sans-serif; font-weight: 700; font-variant-numeric: tabular-nums; font-size: var(--md-sys-typescale-code-large); line-height: 24px; letter-spacing: 1px; }
.code.invalid { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); cursor: help; }
/* ④A：揭示态验证码转主题主色醒目（与进度条紧急的错误红区分：主色=就绪可用，红=紧急） */
.code.revealed { color: var(--md-sys-color-primary); }
</style>
