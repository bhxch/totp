import { getCurrentScope, onScopeDispose } from 'vue'

/** 复制后清空剪贴板的延迟：30s（本地定时器与 background alarms 共用） */
export const CLIPBOARD_CLEAR_DELAY_MS = 30_000

/**
 * 30s 清剪贴板（复制体验统一）：settings.clipboardClearEnabled 开启时，notifyCopied 后
 * 启动 30s 定时器调用 clear；重复复制重置计时；dispose 清定时器。
 * 工厂在组件 setup 内调用时自动挂 onScopeDispose（getCurrentScope 守卫，测试环境无作用域不告警）。
 */
export function createClipboardClearer(getEnabled: () => boolean, clear: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | null = null
  function dispose(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  function notifyCopied(): void {
    dispose() // 重复复制重置计时
    if (!getEnabled()) return
    timer = setTimeout(() => {
      timer = null
      void clear().catch(() => {}) // 清剪贴板失败（如窗口已关）不打扰用户
    }, CLIPBOARD_CLEAR_DELAY_MS)
  }
  if (getCurrentScope()) onScopeDispose(dispose)
  return { notifyCopied, dispose }
}
