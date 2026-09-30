/**
 * miniSession 直测（① 主窗→mini 解锁态同步）：publishMiniUnlock（DEK base64 入 Rust 进程内槽
 * + emitTo mini locked:false）、publishMiniLock（清槽 + emitTo locked:true，槽清失败不阻断事件）。
 * 事件只传状态布尔不传密钥；DEK 只进槽。Tauri 边界走 test/mocks/tauri（mock 套路同 desktopShell.test）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { bytesToBase64 } from '@totp/core'

vi.mock('@tauri-apps/api/core', async () => (await import('../test/mocks/tauri')).invokeModule())
vi.mock('@tauri-apps/api/event', async () => (await import('../test/mocks/tauri')).eventModule())

import { publishMiniLock, publishMiniUnlock } from '../src/miniSession'
import { tauriMock } from '../test/mocks/tauri'

describe('miniSession（① 主窗→mini 解锁态同步）', () => {
  beforeEach(() => tauriMock.reset())

  it('publishMiniUnlock：DEK base64 入槽 + emitTo mini locked:false', async () => {
    const dek = new Uint8Array(32).fill(7)
    await publishMiniUnlock(dek)
    expect(tauriMock.calls('set_mini_dek')).toEqual([{ command: 'set_mini_dek', args: { dek: bytesToBase64(dek) } }])
    expect(tauriMock.emitToCalls()).toEqual([['mini', 'mini-session', { locked: false }]])
  })

  it('publishMiniLock：clear_mini_dek + emitTo locked:true', async () => {
    await publishMiniLock()
    expect(tauriMock.calls('clear_mini_dek')).toHaveLength(1)
    expect(tauriMock.emitToCalls()).toEqual([['mini', 'mini-session', { locked: true }]])
  })

  it('publishMiniLock：槽清失败不阻断 locked:true 事件', async () => {
    tauriMock.on('clear_mini_dek', () => { throw new Error('boom') })
    await publishMiniLock()
    expect(tauriMock.calls('clear_mini_dek')).toHaveLength(1)
    expect(tauriMock.emitToCalls()).toEqual([['mini', 'mini-session', { locked: true }]])
  })
})
