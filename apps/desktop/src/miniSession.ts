/**
 * 主窗→mini 解锁态同步（① mini 跟随主窗解锁，2026-09-30 设计）：主窗解锁汇聚点（ui 层
 * applyDekAndUnlock 成功）经 publishMiniUnlock 把 DEK base64 写入 Rust 进程内槽后再 emitTo
 * mini —— 事件只传状态布尔不传密钥，DEK 只进槽（mini 侧经 peek_mini_dek 取用，Task 4）；
 * 锁定汇聚点（lock() → onLocked）经 publishMiniLock 清槽并通知。槽清失败不阻断事件
 * （mini 收到 locked:true 后自身也会重读/清态，双保险）。
 */
import { invoke } from '@tauri-apps/api/core'
import { emitTo } from '@tauri-apps/api/event'
import { bytesToBase64 } from '@totp/core'

/** 主窗→mini 解锁态同步（2026-09-30 设计）：DEK 只进 Rust 进程内槽，事件只传状态布尔不传密钥 */
export async function publishMiniUnlock(dek: Uint8Array): Promise<void> {
  await invoke('set_mini_dek', { dek: bytesToBase64(dek) })
  await emitTo('mini', 'mini-session', { locked: false })
}

export async function publishMiniLock(): Promise<void> {
  // M3 审查修复（2026-10-01）：槽残留 = 主窗锁定后 mini 聚焦重建仍能 peek 旧 DEK 解锁（击穿
  // 不变量），失败不可静默——重试一次尽力清，仍失败 console.error 留痕；不抛出打断锁定主流程
  // （mini 收 locked:true 后自身锁窗清态，双保险见模块头注释）
  try {
    await invoke('clear_mini_dek')
  } catch {
    try {
      await invoke('clear_mini_dek')
    } catch (e) {
      console.error('[miniSession] clear_mini_dek 重试后仍失败（mini 槽可能残留 DEK）:', e)
    }
  }
  await emitTo('mini', 'mini-session', { locked: true }).catch(() => {})
}
