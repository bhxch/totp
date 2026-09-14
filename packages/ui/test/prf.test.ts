import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPrfCredential, getPrfOutput, prfSupported } from '../src/prf'

// ---- WebAuthn mock：PublicKeyCredential 静态方法 + navigator.credentials ----

interface CredLike { rawId: ArrayBuffer; getClientExtensionResults(): { prf?: { evalResults?: ArrayBuffer[] } } }

function installCredentials(opts: {
  uvpa?: boolean
  caps?: { prf?: boolean } | 'reject'
  create?: (options: { publicKey: Record<string, unknown> }) => Promise<CredLike | null>
  get?: (options: { publicKey: Record<string, unknown> }) => Promise<CredLike | null>
}): void {
  const FakePublicKeyCredential = class {
    static isUserVerifyingPlatformAuthenticatorAvailable =
      vi.fn(async () => { if (opts.uvpa === undefined) throw new Error('not available'); return opts.uvpa })
    static getClientCapabilities =
      vi.fn(async () => { if (opts.caps === 'reject') throw new Error('unsupported'); return opts.caps ?? {} })
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

const credWithPrf = (rawId: Uint8Array, evalResults: Uint8Array[]): CredLike => ({
  rawId: rawId.buffer as ArrayBuffer,
  getClientExtensionResults: () => ({
    prf: { evalResults: evalResults.map((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer) },
  }),
})

describe('prfSupported', () => {
  it('无 PublicKeyCredential → false', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined)
    await expect(prfSupported()).resolves.toBe(false)
  })
  it('getClientCapabilities().prf=true → true', async () => {
    installCredentials({ uvpa: true, caps: { prf: true } })
    await expect(prfSupported()).resolves.toBe(true)
  })
  it('getClientCapabilities().prf=false → false（即使平台认证器可用）', async () => {
    installCredentials({ uvpa: true, caps: { prf: false } })
    await expect(prfSupported()).resolves.toBe(false)
  })
  it('无 getClientCapabilities → 回退 UVPA 探测', async () => {
    installCredentials({ uvpa: true })
    // caps 未定义 → getClientCapabilities 返回 {} → 回退 UVPA
    await expect(prfSupported()).resolves.toBe(true)
    installCredentials({ uvpa: false })
    await expect(prfSupported()).resolves.toBe(false)
  })
  it('capabilities 查询抛错 → 回退 UVPA；UVPA 抛错 → false', async () => {
    installCredentials({ uvpa: true, caps: 'reject' })
    await expect(prfSupported()).resolves.toBe(true)
    installCredentials({ caps: 'reject' })
    await expect(prfSupported()).resolves.toBe(false)
  })
})

describe('createPrfCredential', () => {
  it('创建成功：请求 prf 扩展与 required UV，返回 base64url credentialId 与前 32B PRF 输出', async () => {
    let captured: Record<string, unknown> | null = null
    const rawId = new Uint8Array([1, 2, 3, 4])
    const evalResult = new Uint8Array(64).fill(7)
    installCredentials({
      create: async (options) => {
        captured = options.publicKey
        return credWithPrf(rawId, [evalResult])
      },
    })
    const out = await createPrfCredential('TOTP 验证码工具')
    expect(out).not.toBeNull()
    // create 参数：prf 扩展 + UV required + 常规 alg 声明
    expect(captured!['extensions']).toEqual({ prf: {} })
    expect((captured!['authenticatorSelection'] as Record<string, unknown>)['userVerification']).toBe('required')
    expect(captured!['pubKeyCredParams']).toEqual([
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ])
    expect((captured!['rp'] as Record<string, unknown>)['name']).toBe('TOTP 验证码工具')
    // credentialId 为 base64url（无 +/=/填充字符）
    expect(out!.credentialId).toBe('AQIDBA')
    // prfOutput 取 evalResults[0] 前 32 字节
    expect(out!.prfOutput).toEqual(new Uint8Array(32).fill(7))
    expect(out!.prfOutput.length).toBe(32)
  })
  it('evalResults 缺失/为空 → null（不支持 PRF）', async () => {
    installCredentials({ create: async () => credWithPrf(new Uint8Array([9]), []) })
    await expect(createPrfCredential('rp')).resolves.toBeNull()
  })
  it('create 抛错（用户取消/不支持）→ null', async () => {
    installCredentials({ create: async () => { throw new DOMException('NotAllowedError', 'NotAllowedError') } })
    await expect(createPrfCredential('rp')).resolves.toBeNull()
  })
})

describe('getPrfOutput', () => {
  it('解锁成功：allowCredentials 带 base64url 解码后的 id，prf.eval.first= salt，返回前 32B', async () => {
    let captured: Record<string, unknown> | null = null
    const evalResult = new Uint8Array(64).map((_, i) => i % 251)
    installCredentials({
      get: async (options) => {
        captured = options.publicKey
        return credWithPrf(new Uint8Array([1, 2, 3, 4]), [evalResult])
      },
    })
    const salt = new Uint8Array(32).fill(3)
    const out = await getPrfOutput('AQIDBA', salt)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(32)
    expect(out!).toEqual(evalResult.slice(0, 32))
    const allow = captured!['allowCredentials'] as { type: string; id: Uint8Array }[]
    expect(allow).toHaveLength(1)
    expect(allow[0]!.type).toBe('public-key')
    expect(Array.from(allow[0]!.id)).toEqual([1, 2, 3, 4])
    expect((captured!['extensions'] as { prf: { eval: { first: Uint8Array } } }).prf.eval.first).toBe(salt)
  })
  it('evalResults 缺失 → null；get 抛错（用户取消）→ null', async () => {
    installCredentials({ get: async () => credWithPrf(new Uint8Array([1]), []) })
    await expect(getPrfOutput('AQIDBA', new Uint8Array(32))).resolves.toBeNull()
    installCredentials({ get: async () => { throw new DOMException('NotAllowedError', 'NotAllowedError') } })
    await expect(getPrfOutput('AQIDBA', new Uint8Array(32))).resolves.toBeNull()
  })
})
