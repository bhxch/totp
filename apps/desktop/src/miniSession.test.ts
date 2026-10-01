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

  it('M3：槽清失败重试一次，仍失败 console.error 留痕且不阻断 locked:true 事件', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    tauriMock.on('clear_mini_dek', () => { throw new Error('boom') })
    await publishMiniLock()
    expect(tauriMock.calls('clear_mini_dek')).toHaveLength(2) // 首次 + 重试一次
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('clear_mini_dek')
    expect(tauriMock.emitToCalls()).toEqual([['mini', 'mini-session', { locked: true }]]) // 锁定主流程不中断
    errSpy.mockRestore()
  })

  it('M3：槽清首试失败、重试成功 → 不留痕不报错，事件照发', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let n = 0
    tauriMock.on('clear_mini_dek', () => {
      if (n++ === 0) throw new Error('transient')
    })
    await publishMiniLock()
    expect(tauriMock.calls('clear_mini_dek')).toHaveLength(2)
    expect(errSpy).not.toHaveBeenCalled()
    expect(tauriMock.emitToCalls()).toEqual([['mini', 'mini-session', { locked: true }]])
    errSpy.mockRestore()
  })
})
