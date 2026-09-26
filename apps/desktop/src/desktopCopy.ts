/**
 * desktop 复制编排与失败横幅（P4 自 App.vue 抽出，纯搬移行为不变）：
 * - 30s 清剪贴板：settings.clipboardClearEnabled 开启时复制后定时清空（重复复制重置计时；setup
 *   作用域销毁自动 dispose；store 未就绪时读不到开关视为关闭）。F16：清除经 Rust
 *   clipboard_clear_if_staged 读回比对（仍为本应用复制内容才清空），dispose 欠清除补清、失败重试
 *   上报；托盘退出另有原生兜底。剪贴板读取只在 Rust 侧，webview JS 无读取能力。
 * - 复制失败横幅（真机发现：剪贴板被第三方进程独占时 stage 命令拒绝，原实现静默无提示）：
 *   stage 失败 → copyFailed 置真并 3s 后自动复位（重复失败重置计时），不武装自动清空。
 */
import { ref, type Ref } from 'vue'
import { createClipboardClearer } from '@totp/ui'

/** 复制失败横幅自动复位时长（毫秒） */
export const COPY_FAILED_BANNER_MS = 3000

export interface DesktopCopyDeps {
  /** 清剪贴板开关现读（store 未就绪 false=关闭） */
  isEnabled(): boolean
  /** Rust stage 命令（stage_clipboard_write）：登记暂存值（退出兜底比对的事实源） */
  stage(value: string): Promise<void>
  /** Rust clipboard_clear_if_staged 读回比对清除 */
  clearIfStaged(): Promise<void>
}

export interface DesktopCopy {
  /** 模板消费的复制失败横幅 */
  copyFailed: Ref<boolean>
  /** 复制编排：stage 成功 → clearer.notifyCopied（武装 30s 清空）；失败 → 横幅 3s */
  copyToClipboard(code: string): Promise<void>
}

export function createDesktopCopy(deps: DesktopCopyDeps): DesktopCopy {
  const clearer = createClipboardClearer(deps.isEnabled, deps.clearIfStaged)

  const copyFailed = ref(false)
  let copyFailedTimer: ReturnType<typeof setTimeout> | null = null

  async function copyToClipboard(code: string) {
    // F16：复制经 Rust stage 命令登记暂存值（退出兜底比对的事实源）
    try {
      await deps.stage(code)
    } catch {
      copyFailed.value = true
      if (copyFailedTimer) clearTimeout(copyFailedTimer)
      copyFailedTimer = setTimeout(() => (copyFailed.value = false), COPY_FAILED_BANNER_MS)
      return
    }
    clearer.notifyCopied()
  }

  return { copyFailed, copyToClipboard }
}
