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
  await invoke('clear_mini_dek').catch(() => {})
  await emitTo('mini', 'mini-session', { locked: true }).catch(() => {})
}
