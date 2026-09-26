/**
 * desktop 复制编排与失败横幅（P4 自 App.vue 抽出，纯搬移行为不变；R13 起 mini 剪贴板一并
 * 走本实现——横幅 3s 复位行为以本模块为准，修复 mini 原横幅不复位的漂移）：
 * - 30s 清剪贴板：settings.clipboardClearEnabled 开启时复制后定时清空（重复复制重置计时；setup
 *   作用域销毁自动 dispose；store 未就绪时读不到开关视为关闭）。F16：清除经 Rust
 *   clipboard_clear_if_staged 读回比对（仍为本应用复制内容才清空），dispose 欠清除补清、失败重试
 *   上报；托盘退出另有原生兜底。剪贴板读取只在 Rust 侧，webview JS 无读取能力。
 * - 复制失败横幅（真机发现：剪贴板被第三方进程独占时 stage 命令拒绝，原实现静默无提示）：
 *   stage 失败 → copyFailed 置真并 3s 后自动复位（重复失败重置计时），不武装自动清空；
 *   stage 成功 → copyFailed 复位（撤横幅）。
 * - onStaged 扩展点（R13）：stage 成功后、武装 30s 清空前调用——宿主通道特定收尾挂这里
 *   （mini：HOTP 复制旧 counter 码后递增 counter + 500ms 自动隐藏代次收尾）。
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

/** 复制后通道特定收尾钩子（stage 成功后、武装 30s 清空前调用；失败路径不调用） */
export interface CopyHooks {
  /** code=已暂存的码；await 期间不武装清空（收尾完成才 notifyCopied） */
  onStaged?(code: string): void | Promise<void>
}

export interface DesktopCopy {
  /** 模板消费的复制失败横幅 */
  copyFailed: Ref<boolean>
  /** 复制编排：stage 成功 → 撤横幅 → onStaged 收尾 → clearer.notifyCopied（武装 30s 清空）；失败 → 横幅 3s */
  copyToClipboard(code: string, hooks?: CopyHooks): Promise<void>
}

export function createDesktopCopy(deps: DesktopCopyDeps): DesktopCopy {
  const clearer = createClipboardClearer(deps.isEnabled, deps.clearIfStaged)

  const copyFailed = ref(false)
  let copyFailedTimer: ReturnType<typeof setTimeout> | null = null

  async function copyToClipboard(code: string, hooks?: CopyHooks) {
    // F16：复制经 Rust stage 命令登记暂存值（退出兜底比对的事实源）
    try {
      await deps.stage(code)
    } catch {
      copyFailed.value = true
      if (copyFailedTimer) clearTimeout(copyFailedTimer)
      copyFailedTimer = setTimeout(() => (copyFailed.value = false), COPY_FAILED_BANNER_MS)
      return
    }
    // 码已复制成功：撤失败横幅（下次成功复制不该再被旧横幅盖住 3s）
    copyFailed.value = false
    // 通道特定收尾先行（mini：HOTP 递增/自动隐藏代次），完成才武装 30s 清空
    if (hooks?.onStaged) await hooks.onStaged(code)
    clearer.notifyCopied()
  }

  return { copyFailed, copyToClipboard }
}
