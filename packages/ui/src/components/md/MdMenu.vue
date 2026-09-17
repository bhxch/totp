<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ x: number; y: number; open: boolean; /** 触发点元素（可选）：Esc 关闭且焦点在菜单内时回焦；右键等无按钮触发场景可省略 */ triggerEl?: HTMLElement | null }>()
const emit = defineEmits<{ close: [] }>()

const EST_WIDTH = 140
const EST_HEIGHT = 200
const GAP = 8

const rootRef = ref<HTMLElement | null>(null)

const pos = computed(() => {
  let left = props.x
  let top = props.y
  if (typeof window !== 'undefined') {
    if (left + EST_WIDTH > window.innerWidth) left = Math.max(GAP, window.innerWidth - EST_WIDTH - GAP)
    if (top + EST_HEIGHT > window.innerHeight) top = Math.max(GAP, window.innerHeight - EST_HEIGHT - GAP)
  }
  return { left, top }
})

/** 菜单项（键盘导航/role 标注对象）：菜单根内 button/[href]/显式 tabindex 的可聚焦元素。
 *  跳过 disabled（含通用 disabled 属性与 aria-disabled）与明显隐藏项；jsdom 无布局，深度可见性
 *  检测不可行，仅挡 hidden 属性与 inline display:none（消费方菜单项均为可见 button，静默兜底不抛错） */
function menuItems(): HTMLElement[] {
  const root = rootRef.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')).filter((el) => {
    if ((el as HTMLButtonElement).disabled || el.hasAttribute('disabled')) return false
    if (el.getAttribute('aria-disabled') === 'true') return false
    if (el.getAttribute('hidden') !== null || el.style.display === 'none') return false
    return true
  })
}

/** Esc 关闭后焦点回触发点：仅当焦点当前在菜单内且触发点仍在文档中（否则不动焦点，静默兜底） */
function focusTrigger(): void {
  const t = props.triggerEl
  if (!t || !t.isConnected) return
  if (!rootRef.value?.contains(document.activeElement)) return
  t.focus()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
    focusTrigger()
    return
  }
  // Tab 关闭不 preventDefault、不拉回焦点（焦点随 Tab 自然移走，同 MdSelect 的 close(false)）
  if (e.key === 'Tab') {
    emit('close')
    return
  }
  // 方向键/Home/End 导航：焦点用原生 .focus()（菜单项为真实 button 时 Enter/Space 原生激活）
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    const items = menuItems()
    if (items.length === 0) return
    e.preventDefault()
    if (e.key === 'Home') { items[0]!.focus(); return }
    if (e.key === 'End') { items[items.length - 1]!.focus(); return }
    const delta = e.key === 'ArrowDown' ? 1 : -1
    const idx = items.indexOf(document.activeElement as HTMLElement)
    // 焦点不在项上时 ArrowDown 落首项 / ArrowUp 落末项；否则循环移动（末项 ArrowDown 回首项）
    items[idx === -1 ? (delta === 1 ? 0 : items.length - 1) : (idx + delta + items.length) % items.length]!.focus()
  }
}
/** 点外部关闭（document mousedown，开启期间挂载；同 MdSelect 自包含模式，批 4 抽查补齐——
 *  此前仅 Esc/点选收起，外点不收起） */
function onDocMousedown(e: MouseEvent) {
  if (!rootRef.value?.contains(e.target as Node)) emit('close')
}
watch(
  () => props.open,
  (open) => {
    if (open) {
      window.addEventListener('keydown', onKeydown)
      document.addEventListener('mousedown', onDocMousedown)
      // 开启后：菜单项补 role=menuitem（根已 role=menu）+ 聚焦首项（W3C APG menu 推荐，键盘/程序
      // 触发均适用）。仅 open 翻转时执行一次——当前消费方（CodesPage 右键菜单/CloudCard 添加目标）
      // 菜单项均静态，open 期间动态增删项的重新标注不做；查询不到可聚焦项时静默跳过
      void nextTick(() => {
        if (!props.open) return // 竞态兜底：nextTick 前已关闭
        const items = menuItems()
        for (const el of items) el.setAttribute('role', 'menuitem')
        items[0]?.focus()
      })
    } else {
      window.removeEventListener('keydown', onKeydown)
      document.removeEventListener('mousedown', onDocMousedown)
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('mousedown', onDocMousedown)
})
</script>
<template>
  <div v-if="open" ref="rootRef" class="md-menu" role="menu" :style="`left: ${pos.left}px; top: ${pos.top}px;`"><slot /></div>
</template>
<style scoped>
.md-menu { position: fixed; z-index: 1100; min-width: 120px; padding: 6px 0; border-radius: 4px; /* M3 menu=extra-small 4dp(审查 X9) */
  background: var(--md-sys-color-surface-container-high);
  box-shadow: inset 0 0 0 1px var(--md-sys-color-outline-variant), 0 2px 8px var(--md-sys-color-shadow); }
</style>
