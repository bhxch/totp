/**
 * desktop 复制编排（P4 自 App.vue 抽出；R13 起 mini 剪贴板一并走本实现）：
 * - 30s 清剪贴板：settings.clipboardClearEnabled 开启时复制后定时清空（重复复制重置计时；setup
 *   作用域销毁自动 dispose；store 未就绪时读不到开关视为关闭）。F16：清除经 Rust
 *   clipboard_clear_if_staged 读回比对（仍为本应用复制内容才清空），dispose 欠清除补清、失败重试
 *   上报；托盘退出另有原生兜底。剪贴板读取只在 Rust 侧，webview JS 无读取能力。
 * - 复制结果返回值（R3-I1 反馈上移宿主）：stage 失败（剪贴板被第三方进程独占）→ 返回 false 且
 *   不武装自动清空；stage 成功 → 收尾后返回 true。成功/失败的用户可见反馈（toast）由调用方
 *   按返回值决定——替代原 copyFailed 横幅（设计 §3.2：失败 error toast，三宿主一致），消灭
 *   「emit 后 CodesPage 同步弹已复制 + 宿主失败横幅」的矛盾双反馈。
 * - onStaged 扩展点（R13）：stage 成功后、武装 30s 清空前调用——宿主通道特定收尾挂这里
 *   （mini：HOTP 复制旧 counter 码后递增 counter + 500ms 自动隐藏代次收尾）。
 */
import { createClipboardClearer } from '@totp/ui'

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
  /** 复制编排：stage 成功 → onStaged 收尾 → clearer.notifyCopied（武装 30s 清空），resolve true；
   *  stage 失败（剪贴板被独占等）→ resolve false 且不武装清空（反馈由调用方按返回值提示） */
  copyToClipboard(code: string, hooks?: CopyHooks): Promise<boolean>
}

export function createDesktopCopy(deps: DesktopCopyDeps): DesktopCopy {
  const clearer = createClipboardClearer(deps.isEnabled, deps.clearIfStaged)

  async function copyToClipboard(code: string, hooks?: CopyHooks): Promise<boolean> {
    // F16：复制经 Rust stage 命令登记暂存值（退出兜底比对的事实源）
    try {
      await deps.stage(code)
    } catch {
      // 码未复制成功：不武装清空（清走用户原有剪贴板内容），成败交调用方反馈
      return false
    }
    // 通道特定收尾先行（mini：HOTP 递增/自动隐藏代次），完成才武装 30s 清空
    if (hooks?.onStaged) await hooks.onStaged(code)
    clearer.notifyCopied()
    return true
  }

  return { copyToClipboard }
}
