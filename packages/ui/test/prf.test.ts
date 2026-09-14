import { afterEach, describe, expect, it, vi } from 'vitest'
import { addPrfSource, bytesToBase64, setupVaultEncryption, unlockWithPrf } from '@totp/core'
import { createPrfCredential, getPrfOutput, prfSupported } from '../src/prf'

// ---- WebAuthn mock：PublicKeyCredential 静态方法 + navigator.credentials ----
// getClientExtensionResults 按 W3C WebAuthn L3 真实形状 mock：{ prf: { enabled, results?: { first } } }

interface CredLike { rawId: ArrayBuffer; getClientExtensionResults(): { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } } }

function toBuf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

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

const credApi = (): { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } =>
  (navigator as unknown as { credentials: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } }).credentials

const credWithPrf = (rawId: Uint8Array, first?: Uint8Array): CredLike => ({
  rawId: toBuf(rawId),
  getClientExtensionResults: () =>
    first ? { prf: { enabled: true, results: { first: toBuf(first) } } } : { prf: { enabled: false } },
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (navigator as unknown as { credentials?: unknown }).credentials
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

describe('createPrfCredential（注册期带盐求值 + create 后立即 get 权威取值）', () => {
  it('create 带 prf.eval{first:盐}；随后 get 绑定同盐；返回 base64url credentialId 与 get 输出前 32B', async () => {
    const rawId = new Uint8Array([1, 2, 3, 4])
    const salt = new Uint8Array(32).fill(7)
    const prfValue = new Uint8Array(64).fill(7)
    installCredentials({
      create: async () => credWithPrf(rawId),
      get: async () => credWithPrf(rawId, prfValue),
    })
    const out = await createPrfCredential('TOTP 验证码工具', salt)
    expect(out).not.toBeNull()
    // create 参数：注册期即以绑定盐请求求值 + UV required + 常规 alg 声明
    const createArg = credApi().create.mock.calls[0]![0] as { publicKey: Record<string, unknown> }
    expect(createArg.publicKey['extensions']).toEqual({ prf: { eval: { first: salt } } })
    expect((createArg.publicKey['authenticatorSelection'] as Record<string, unknown>)['userVerification']).toBe('required')
    expect(createArg.publicKey['pubKeyCredParams']).toEqual([
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ])
    expect((createArg.publicKey['rp'] as Record<string, unknown>)['name']).toBe('TOTP 验证码工具')
    // 未传 excludeCredentialIds → 空列表
    expect(createArg.publicKey['excludeCredentials']).toEqual([])
    // create 后立即 get（权威来源）：allowCredentials 指向新凭据、eval.first=同一盐
    const getArg = credApi().get.mock.calls[0]![0] as { publicKey: Record<string, unknown> }
    const allow = getArg.publicKey['allowCredentials'] as { type: string; id: Uint8Array }[]
    expect(allow).toEqual([{ type: 'public-key', id: rawId }])
    expect(getArg.publicKey['extensions']).toEqual({ prf: { eval: { first: salt } } })
    // credentialId 为 base64url(rawId)；prfOutput 取 get results.first 前 32B
    expect(out!.credentialId).toBe('AQIDBA')
    expect(out!.prfOutput).toEqual(prfValue.slice(0, 32))
  })

  it('excludeCredentialIds 透传为 excludeCredentials（防认证器残留重复凭据）', async () => {
    installCredentials({
      create: async () => credWithPrf(new Uint8Array([9]), new Uint8Array(64)),
      get: async () => credWithPrf(new Uint8Array([9]), new Uint8Array(64)),
    })
    await createPrfCredential('rp', new Uint8Array(32), { excludeCredentialIds: ['AAA', 'BBB'] })
    const createArg = credApi().create.mock.calls[0]![0] as { publicKey: Record<string, unknown> }
    const exclude = createArg.publicKey['excludeCredentials'] as { type: string; id: Uint8Array }[]
    expect(exclude).toHaveLength(2)
    expect(exclude[0]!.type).toBe('public-key')
  })

  it('get 阶段无 prf.results → null（认证器不支持 PRF，注册不生效）', async () => {
    installCredentials({
      create: async () => credWithPrf(new Uint8Array([9])),
      get: async () => credWithPrf(new Uint8Array([9])), // enabled 但无 results
    })
    await expect(createPrfCredential('rp', new Uint8Array(32))).resolves.toBeNull()
  })

  it('create 抛错（用户取消/不支持）→ null 且不触发 get', async () => {
    installCredentials({
      create: async () => { throw new DOMException('NotAllowedError', 'NotAllowedError') },
      get: async () => credWithPrf(new Uint8Array([1]), new Uint8Array(64)),
    })
    await expect(createPrfCredential('rp', new Uint8Array(32))).resolves.toBeNull()
    expect(credApi().get).not.toHaveBeenCalled()
  })

  it('create 成功但 get 抛错 → null', async () => {
    installCredentials({
      create: async () => credWithPrf(new Uint8Array([9])),
      get: async () => { throw new DOMException('NotAllowedError', 'NotAllowedError') },
    })
    await expect(createPrfCredential('rp', new Uint8Array(32))).resolves.toBeNull()
  })
})

describe('getPrfOutput（解锁期同盐求值）', () => {
  it('allowCredentials 带 base64url 解码后的 id，prf.eval.first=盐，读 results.first 前 32B', async () => {
    const evalResult = new Uint8Array(64).map((_, i) => i % 251)
    installCredentials({ get: async () => credWithPrf(new Uint8Array([1, 2, 3, 4]), evalResult) })
    const salt = new Uint8Array(32).fill(3)
    const out = await getPrfOutput('AQIDBA', salt)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(32)
    expect(out!).toEqual(evalResult.slice(0, 32))
    const arg = credApi().get.mock.calls[0]![0] as { publicKey: Record<string, unknown> }
    const allow = arg.publicKey['allowCredentials'] as { type: string; id: Uint8Array }[]
    expect(Array.from(allow[0]!.id)).toEqual([1, 2, 3, 4])
    expect(arg.publicKey['extensions']).toEqual({ prf: { eval: { first: salt } } })
  })
  it('results 缺失 → null；get 抛错（用户取消）→ null', async () => {
    installCredentials({ get: async () => credWithPrf(new Uint8Array([1])) })
    await expect(getPrfOutput('AQIDBA', new Uint8Array(32))).resolves.toBeNull()
    installCredentials({ get: async () => { throw new DOMException('NotAllowedError', 'NotAllowedError') } })
    await expect(getPrfOutput('AQIDBA', new Uint8Array(32))).resolves.toBeNull()
  })
})

describe('绑定→解锁闭环（同认证器+同盐→同输出的绑定语义）', () => {
  /** 确定性 PRF 模拟：输出 = 盐‖盐（同盐必同输出，异盐必不同） */
  const prfOf = (salt: Uint8Array): Uint8Array => {
    const out = new Uint8Array(64)
    out.set(salt.subarray(0, 32), 0)
    out.set(salt.subarray(0, 32), 32)
    return out
  }

  it('绑定盐求值 → addPrfSource → 解锁期同盐求值 → unlockWithPrf 解出原 DEK；异盐失败', async () => {
    const rawId = new Uint8Array([1, 2, 3, 4])
    installCredentials({
      create: async () => credWithPrf(rawId),
      get: async (options) => {
        const exts = (options.publicKey as { extensions: { prf: { eval: { first: ArrayBuffer } } } }).extensions
        return credWithPrf(rawId, prfOf(new Uint8Array(exts.prf.eval.first)))
      },
    })
    const salt = new Uint8Array(32).fill(9)
    const created = await createPrfCredential('rp', salt)
    expect(created).not.toBeNull()

    const { security, dek } = await setupVaultEncryption('{"v":1}', 'p')
    const bound = await addPrfSource(security, dek, created!.credentialId, created!.prfOutput, bytesToBase64(salt))
    // 绑定输出即绑定盐求值结果（get 为权威来源）
    expect(created!.prfOutput).toEqual(prfOf(salt).slice(0, 32))
    // 解锁期同盐 → 同输出 → 解锁成功
    const unlocked = await getPrfOutput(created!.credentialId, salt)
    await expect(unlockWithPrf(bound, unlocked!)).resolves.toEqual(dek)
    // 异盐 → 输出不同 → 解锁失败
    const wrong = await getPrfOutput(created!.credentialId, new Uint8Array(32).fill(1))
    await expect(unlockWithPrf(bound, wrong!)).rejects.toThrow('passkey 解锁失败')
  })
})
