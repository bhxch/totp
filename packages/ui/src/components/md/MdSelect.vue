<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** 触发端字段标签（同 MdTextField label 语义，悬浮呈现） */
  label: string
  modelValue: string | number
  options: Array<{ value: string | number; label: string }>
  disabled?: boolean
  ariaLabel?: string
}>(), { disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()

const open = ref(false)
const activeIdx = ref(-1)
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)

const selectedLabel = computed(() => props.options.find(o => o.value === props.modelValue)?.label ?? '')
// 有显示值即悬浮（同 MdTextField「有值即悬浮」语义；0 等合法 number 也悬浮，故以显示值判断而非真值）
const floated = computed(() => selectedLabel.value !== '')

const GAP = 8
const EST_HEIGHT = 280 // 与 CSS max-height 同值，保证夹取估算与实际弹层高度一致
/** 弹层窗口坐标（同 MdMenu 的 fixed 方案）：触发框正下方，视口右/下溢出按估算宽高夹取 */
const pos = ref({ left: 0, top: 0 })
function openMenu(): void {
  let left = 0
  let top = 0
  if (typeof window !== 'undefined') {
    const rect = triggerRef.value?.getBoundingClientRect()
    left = rect?.left ?? 0
    top = (rect?.bottom ?? 0) + GAP
    const width = rect?.width ?? 160
    if (left + width > window.innerWidth) left = Math.max(GAP, window.innerWidth - width - GAP)
    if (top + EST_HEIGHT > window.innerHeight) top = Math.max(GAP, window.innerHeight - EST_HEIGHT - GAP)
  }
  pos.value = { left, top }
  activeIdx.value = props.options.findIndex(o => o.value === props.modelValue)
  open.value = true
}
/** focusBack：是否回焦触发按钮。键盘 Esc/点选/触发 toggle 回焦；resize/scroll/Tab 被动关闭不抢焦点
 *  （用户已 Tab 移走时滚动页面不应把焦点猛拉回） */
function close(focusBack = true): void {
  open.value = false
  if (focusBack) triggerRef.value?.focus() // 关闭焦点回触发按钮
}
function toggle(): void {
  if (props.disabled) return
  if (open.value) close()
  else openMenu()
}
function select(o: { value: string | number; label: string }): void {
  emit('update:modelValue', o.value) // value 原样透传（number 不转 string）
  close()
}
/** 键盘交互收敛在触发按钮上（焦点不移入弹层）：关闭态开弹层，开启态移高亮/选中/关闭 */
function onTriggerKeydown(e: KeyboardEvent): void {
  if (props.disabled) return
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      openMenu()
    }
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const len = props.options.length
    if (len === 0) return
    const delta = e.key === 'ArrowDown' ? 1 : -1
    activeIdx.value = (activeIdx.value + delta + len) % len // -1 起步时 ArrowDown 落首项、ArrowUp 落末项
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    const o = props.options[activeIdx.value]
    if (o) select(o)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  } else if (e.key === 'Tab') {
    close(false) // 不 preventDefault，焦点随 Tab 自然走
  }
}

/** 点外部关闭（document mousedown，开启期间挂载；MdMenu 缺的能力，本组件自包含） */
function onDocMousedown(e: MouseEvent): void {
  if (!rootRef.value?.contains(e.target as Node)) close()
}
/** 窗口 resize/scroll 一律关闭（简化策略；scroll 用捕获以覆盖容器滚动）。
 *  捕获阶段会收到弹层自身滚动：target 在组件内（弹层为 rootRef 子元素）时排除，内部一滚即关属误关 */
function onWindowClose(e?: Event): void {
  if (e?.target instanceof Node && rootRef.value?.contains(e.target)) return
  if (open.value) close(false)
}
watch(open, (v) => {
  if (v) {
    document.addEventListener('mousedown', onDocMousedown)
    window.addEventListener('resize', onWindowClose)
    window.addEventListener('scroll', onWindowClose, true)
  } else {
    document.removeEventListener('mousedown', onDocMousedown)
    window.removeEventListener('resize', onWindowClose)
    window.removeEventListener('scroll', onWindowClose, true)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMousedown)
  window.removeEventListener('resize', onWindowClose)
  window.removeEventListener('scroll', onWindowClose, true)
})
</script>
<template>
  <div ref="rootRef" class="md-select" :class="{ 'md-select--disabled': disabled }">
    <div class="md-select__box">
      <span class="md-select__label" :class="{ 'md-select__label--floated': floated }">{{ label }}</span>
      <button ref="triggerRef" type="button" class="md-select__trigger" :disabled="disabled"
        aria-haspopup="listbox" :aria-expanded="open ? 'true' : 'false'" :aria-label="ariaLabel || undefined"
        @click="toggle" @keydown="onTriggerKeydown">
        <span class="md-select__value">{{ selectedLabel }}</span>
        <svg class="md-select__arrow" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M7 10l5 5 5-5z" fill="currentColor" />
        </svg>
      </button>
    </div>
    <div v-if="open" class="md-select__menu" role="listbox" :style="`left: ${pos.left}px; top: ${pos.top}px;`">
      <div v-for="(o, i) in options" :key="o.value" class="md-select__option" role="option"
        :class="{ 'md-select__option--selected': o.value === modelValue, 'md-select__option--active': i === activeIdx }"
        :aria-selected="o.value === modelValue ? 'true' : 'false'"
        @click="select(o)">{{ o.label }}</div>
    </div>
  </div>
</template>
<style scoped>
/* 触发端与 MdTextField 同款：filled 底 + 底边框 + 悬浮 label；差异仅在右侧箭头与只读（按钮不可输入） */
.md-select { display: flex; flex-direction: column; font: inherit; }
.md-select--disabled { opacity: .38; cursor: default; }
.md-select__box { position: relative; background: var(--md-sys-color-surface-container-highest);
  border-radius: 4px 4px 0 0; border-bottom: 1px solid var(--md-sys-color-on-surface-variant); transition: border-color .15s; }
.md-select__box:focus-within { border-bottom: 2px solid var(--md-sys-color-primary); }
.md-select__label { position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
  font-size: var(--md-sys-typescale-body-large); color: var(--md-sys-color-on-surface-variant); pointer-events: none; transition: all .15s; }
.md-select__label--floated,
.md-select__box:focus-within .md-select__label { top: 8px; transform: none; font-size: var(--md-sys-typescale-body-small); }
.md-select__box:focus-within .md-select__label { color: var(--md-sys-color-primary); }
.md-select__trigger { width: 100%; box-sizing: border-box; border: none; outline: none; background: transparent;
  padding: 22px 12px 6px 16px; font: inherit; font-size: var(--md-sys-typescale-body-large); color: var(--md-sys-color-on-surface);
  display: flex; align-items: center; justify-content: space-between; gap: 8px; text-align: left; cursor: pointer; }
.md-select--disabled .md-select__trigger { cursor: default; }
.md-select__trigger:focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
.md-select__value { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-select__arrow { flex: none; color: var(--md-sys-color-on-surface-variant); }
/* 弹层与 MdMenu 同源外观：fixed + surface-container-high + outline-variant 内描边 */
.md-select__menu { position: fixed; z-index: 1100; min-width: 120px; max-height: 280px; overflow: auto; padding: 6px 0;
  border-radius: 4px; background: var(--md-sys-color-surface-container-high);
  box-shadow: inset 0 0 0 1px var(--md-sys-color-outline-variant), 0 2px 8px var(--md-sys-color-shadow); }
.md-select__option { height: 40px; display: flex; align-items: center; padding: 0 16px; cursor: pointer;
  font-size: var(--md-sys-typescale-body-medium); color: var(--md-sys-color-on-surface); }
.md-select__option--active { background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent); }
.md-select__option--selected { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
</style>
