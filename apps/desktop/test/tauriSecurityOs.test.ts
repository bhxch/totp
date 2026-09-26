/**
 * tauriSecurity OS 自动解锁三通道补测（P3b）：osAutoProtectOs / osAutoUnprotectOs / osAutoForgetOs。
 * why（盘点 B6 22-24）：DEK 32B 双层防御是安全边界——保护侧前端先拒（不达 OS 加密边界），
 * 解包侧对 Rust 返回值后置兜底（双层防御）；osAutoForgetOs 薄封装不吞错，Windows 报错桩的
 * 静默由宿主 best-effort 处理（App.vue，P4 范围）。isEntropyBoundDekWrap 3 例在
 * src/tauriSecurity.test.ts（保留不动），本文件走 P0 工厂接法。
 */
import { base64ToBytes, bytesToBase64 } from '@totp/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tauriMock } from './mocks/tauri'
import { isEntropyBoundDekWrap, osAutoForgetOs, osAutoProtectOs, osAutoUnprotectOs } from '../src/tauriSecurity'

vi.mock('@tauri-apps/api/core', async () => (await import('./mocks/tauri')).invokeModule())

const dek = new Uint8Array(32).fill(7)

beforeEach(() => {
  tauriMock.reset()
})

describe('osAutoProtectOs（DEK → base64(OS保护(DEK))）', () => {
  it('DEK≠32B：前端先拒，invoke 不被调（无效长度不打到 OS 加密边界）', async () => {
    for (const bad of [new Uint8Array(31), new Uint8Array(0), new Uint8Array(33)]) {
      await expect(osAutoProtectOs(bad)).rejects.toThrow('DEK must be 32 bytes')
    }
    expect(tauriMock.invoke).not.toHaveBeenCalled()
  })

  it('恰 32B：invoke os_auto_protect 带 base64(DEK)，返回包裹文本透传', async () => {
    tauriMock.on('os_auto_protect', ({ dataB64 }) => `wrapped:${String(dataB64)}`)
    const wrapped = await osAutoProtectOs(dek)
    expect(wrapped).toBe(`wrapped:${bytesToBase64(dek)}`)
    expect(tauriMock.calls('os_auto_protect')).toEqual([
      { command: 'os_auto_protect', args: { dataB64: bytesToBase64(dek) } },
    ])
  })
})

describe('osAutoUnprotectOs（base64(OS保护(DEK)) → DEK 字节）', () => {
  it('invoke 返回 32B：解出 DEK 字节；wrappedB64 原样透传', async () => {
    const protectedDek = new Uint8Array(32).fill(9)
    tauriMock.onReturn('os_auto_unprotect', bytesToBase64(protectedDek))
    await expect(osAutoUnprotectOs('wrapped-b64')).resolves.toEqual(protectedDek)
    expect(tauriMock.calls('os_auto_unprotect')).toEqual([
      { command: 'os_auto_unprotect', args: { wrappedB64: 'wrapped-b64' } },
    ])
  })

  it('invoke 成功但返回非 32B：后置兜底拒绝（双层防御，畸形返回不流入密钥位）', async () => {
    for (const len of [0, 16, 31, 33]) {
      tauriMock.onReturn('os_auto_unprotect', bytesToBase64(new Uint8Array(len)))
      await expect(osAutoUnprotectOs('wrapped-b64')).rejects.toThrow('DEK must be 32 bytes')
    }
  })

  it('invoke 抛错（跨机器/跨用户/条目缺失）→ 透传，由调用方静默处理', async () => {
    tauriMock.on('os_auto_unprotect', () => Promise.reject('解包失败'))
    await expect(osAutoUnprotectOs('wrapped-b64')).rejects.toBe('解包失败')
  })

  it('返回非法 base64 → base64ToBytes 抛错透传（不吞）', async () => {
    tauriMock.onReturn('os_auto_unprotect', 'not-base64!!!')
    await expect(osAutoUnprotectOs('x')).rejects.toThrow()
  })
})

describe('osAutoForgetOs（删除 keyring DEK 条目）', () => {
  it('成功路径：invoke os_auto_forget 无参调用', async () => {
    tauriMock.onReturn('os_auto_forget', null)
    await expect(osAutoForgetOs()).resolves.toBeUndefined()
    expect(tauriMock.calls('os_auto_forget')).toEqual([{ command: 'os_auto_forget', args: undefined }])
  })

  it('Windows/其余平台报错桩（Rust Err 字符串）→ 薄封装不吞，向上传播给宿主 best-effort', async () => {
    // Rust lib.rs 桩形态：Err("当前平台无 keyring DEK 条目可删除")
    tauriMock.on('os_auto_forget', () => Promise.reject('当前平台无 keyring DEK 条目可删除'))
    await expect(osAutoForgetOs()).rejects.toBe('当前平台无 keyring DEK 条目可删除')
  })
})

describe('v2 熵绑定帧与三通道的字节关系（防回归锚点）', () => {
  it('osAutoProtectOs 返回的包裹按 isEntropyBoundDekWrap 应判为待迁移旧格式（无 TOTPDEK1 前缀）', async () => {
    // v2 前缀由宿主迁移逻辑（App.vue migrateDekWrapToEntropyBound）负责重包，OS 通道本体不带前缀
    tauriMock.onReturn('os_auto_protect', bytesToBase64(dek))
    const wrapped = await osAutoProtectOs(dek)
    expect(isEntropyBoundDekWrap(wrapped)).toBe(false)
    expect(base64ToBytes(wrapped)).toHaveLength(32)
  })
})
