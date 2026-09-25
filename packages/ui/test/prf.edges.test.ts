import { afterEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64, setupVaultEncryption } from '@totp/core'
import { createPrfCredential, getPrfOutput, prfSupported } from '../src/prf'

interface CredLike { rawId: ArrayBuffer; getClientExtensionResults(): { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } } }

function installCredentials(opts: {
  uvpa?: boolean
  get?: (options: { publicKey: Record<string, unknown> }) => Promise<CredLike | null>
  create?: (options: { publicKey: Record<string, unknown> }) => Promise<CredLike | null>
}): void {
  const FakePublicKeyCredential = class {
    static isUserVerifyingPlatformAuthenticatorAvailable =
      vi.fn(async () => { if (opts.uvpa === undefined) throw new Error('not available'); return opts.uvpa })
    static getClientCapabilities = vi.fn(async () => ({}))
  }
  vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential)
  ;(navigator as unknown as { credentials: unknown }).credentials = {
    create: opts.create ? vi.fn(opts.create) : vi.fn(),
    get: opts.get ? vi.fn(opts.get) : vi.fn(),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (navigator as unknown as { credentials?: unknown }).credentials
})

describe('prf 边界分支（视图字节/短输出/空凭据）', () => {
  it('prf results.first 以 TypedArray 视图传入：bytesOf isView 分支同样取前 32B', async () => {
    await prfSupported()
    const first = new Uint8Array(40).fill(9)
    installCredentials({
      get: async () => ({
        rawId: new Uint8Array([1]).buffer as ArrayBuffer,
        getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: first as unknown as ArrayBuffer } } }),
      }),
    })
    const out = await getPrfOutput('AA', new Uint8Array(32).fill(3))
    expect(out).not.toBeNull()
    expect(out).toEqual(new Uint8Array(32).fill(9))
  })

  it('prf 输出不足 32B：getPrfOutput 回落 null（绑定侧拒绝弱熵输出）', async () => {
    await prfSupported()
    installCredentials({
      get: async () => ({
        rawId: new Uint8Array([1]).buffer as ArrayBuffer,
        getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: new Uint8Array(16).buffer as ArrayBuffer } } }),
      }),
    })
    const out = await getPrfOutput('AA', new Uint8Array(32))
    expect(out).toBeNull()
  })

  it('get 返回 null（取消/无凭据）：getPrfOutput null 不抛', async () => {
    await prfSupported()
    installCredentials({ get: async () => null })
    const out = await getPrfOutput('AA', new Uint8Array(32))
    expect(out).toBeNull()
  })

  it('create 返回 null（用户取消）：createPrfCredential null 且不进入 get', async () => {
    await prfSupported()
    const get = vi.fn()
    installCredentials({ create: async () => null, get: get as never })
    const cred = await createPrfCredential('rp', new Uint8Array(32))
    expect(cred).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })

  it('create 后 get 输出为空：绑定失败回落 null（调用方提示不抛错）', async () => {
    await prfSupported()
    installCredentials({
      create: async () => ({ rawId: new Uint8Array([1]).buffer as ArrayBuffer, getClientExtensionResults: () => ({ prf: { enabled: true } }) }),
      get: async () => ({ rawId: new Uint8Array([1]).buffer as ArrayBuffer, getClientExtensionResults: () => ({ prf: { enabled: true } }) }),
    })
    const cred = await createPrfCredential('rp', new Uint8Array(32))
    expect(cred).toBeNull()
  })
})
