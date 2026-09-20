import { getCurrentScope, onScopeDispose } from 'vue'

/** 复制后清空剪贴板的延迟：30s（本地定时器与 background alarms 共用） */
export const CLIPBOARD_CLEAR_DELAY_MS = 30_000

/** F16 清除失败重试参数：250ms 间隔、至多 2 次（首试后） */
const RETRY_DELAY_MS = 250
const MAX_RETRIES = 2

/**
 * 30s 清剪贴板（复制体验统一）：settings.clipboardClearEnabled 开启时，notifyCopied 后
 * 启动 30s 定时器调用 clear；重复复制重置计时并作废在途重试链（generation）。
 *
 * F16 加固：
 * - dispose（作用域销毁）时若仍有清除义务，尽力补清一次——桌面端唯一清除机制即本页定时器，
 *   「复制后 30s 内退出」原实现会取消清除使验证码/种子 URI 滞留剪贴板；
 * - clear 失败不再静默：250ms×2 重试，最终失败 console.warn 固定字面量上报（不含内容）；
 * - 底层 clear 建议实现为「读回比对后才清」的幂等语义（桌面端=Rust clipboard_clear_if_staged，
 *   比对在 Rust 侧完成，不向 webview JS 授予剪贴板读取能力）；比对不匹配时义务同样视为解除
 *   （内容已非本应用所复制，无需也无法清除）。
 * 工厂在组件 setup 内调用时自动挂 onScopeDispose（getCurrentScope 守卫，测试环境无作用域不告警）。
 */
export function createClipboardClearer(getEnabled: () => boolean, clear: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0 // 每次复制递增：作废在途重试链，防旧链清掉新复制内容
  let owed = false // 复制后未完成的清除义务（dispose 补清与重试的依据）

  async function clearWithRetry(gen: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (gen !== generation || !owed) return // 期间又有新复制/义务已解除：本轮作废
        await clear()
        if (gen !== generation) return // 竞态：清除期间又有新复制（新链已接管义务）
        owed = false
        return
      } catch {
        if (gen !== generation || !owed || attempt >= MAX_RETRIES) {
          if (gen === generation && owed) console.warn('[clipboardClearer] 自动清除剪贴板失败（含重试）')
          return
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }
  }

  function cancelPending(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** 作用域销毁：欠清除时尽力补清（fire-and-forget——页面即关时尽力而为，进程退出另有宿主兜底） */
  function dispose(): void {
    cancelPending()
    generation++ // 使任何在途重试链失效；补清使用新代数
    if (owed) void clearWithRetry(generation)
  }

  function notifyCopied(): void {
    generation++ // 新复制：在途重试链作废，旧内容的清除义务转移给本次复制
    cancelPending()
    if (!getEnabled()) {
      owed = false
      return
    }
    owed = true
    timer = setTimeout(() => {
      timer = null
      void clearWithRetry(generation)
    }, CLIPBOARD_CLEAR_DELAY_MS)
  }

  if (getCurrentScope()) onScopeDispose(dispose)
  return { notifyCopied, dispose }
}
