import { ref, type Ref } from 'vue'

/** toast 语义态：成功 / 错误 */
export type ToastKind = 'success' | 'error'

/** 单条 toast：key 为模块级自增标识（dismiss/渲染 :key 用），同 message 替换时复用 */
export interface ToastItem { key: number; message: string; kind: ToastKind }

/** 自动过期时长：3s */
const TOAST_DURATION_MS = 3_000
/** 同屏上限：超出移除最旧 */
const MAX_VISIBLE = 3

// 模块级单例状态（非 per-caller）：宿主任意组件 useToast().show()，根组件挂的 ToastHost
// 直读同一 toasts 渲染——跨组件零接线。key 自增与计时表同为模块级
const toasts = ref<ToastItem[]>([])
/** key → 自动过期计时器；dismiss/替换/过期/挤出时同步清理，防已移除项被旧计时再操作 */
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextKey = 0

/** 移除单条：清其计时并出队（未知 key 静默 no-op） */
function remove(key: number): void {
  const timer = timers.get(key)
  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(key)
  }
  const idx = toasts.value.findIndex((t) => t.key === key)
  if (idx !== -1) toasts.value.splice(idx, 1)
}

/** (重)置自动过期计时：替换刷新与新增共用入口 */
function armTimer(key: number): void {
  const prev = timers.get(key)
  if (prev !== undefined) clearTimeout(prev)
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      remove(key)
    }, TOAST_DURATION_MS),
  )
}

/**
 * 全局 toast（P3 item-layout toast 设计）：模块级单例，多调用方共享同一 toasts。
 * - show：同 message 既有项被原位替换（key 复用、kind 更新）并刷新 3s 计时；不同 message
 *   追加，同屏最多 3 条（超出移除最旧）。
 * - dismiss：按 key 立即移除（ToastHost 点击单条即 dismiss）。
 * 渲染端为根组件挂载的 ToastHost（无 props，直读本状态）。
 */
export function useToast(): {
  show: (message: string, kind?: ToastKind) => void
  toasts: Readonly<Ref<ToastItem[]>>
  dismiss: (key: number) => void
} {
  function show(message: string, kind: ToastKind = 'success'): void {
    const existing = toasts.value.find((t) => t.message === message)
    if (existing) {
      // 替换刷新：原位替换（保持队列位置）、key 复用、计时重置
      const idx = toasts.value.indexOf(existing)
      toasts.value.splice(idx, 1, { key: existing.key, message, kind })
      armTimer(existing.key)
      return
    }
    const key = nextKey++
    toasts.value.push({ key, message, kind })
    armTimer(key)
    while (toasts.value.length > MAX_VISIBLE) {
      const oldest = toasts.value[0]
      if (!oldest) break
      remove(oldest.key)
    }
  }

  return { show, toasts, dismiss: remove }
}
