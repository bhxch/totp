// WebAuthn PRF 扩展封装：passkey 解锁的浏览器侧能力探测 / 凭据创建 / PRF 求值。
// credentialId 统一以 base64url 存储（WebAuthn rawId 的标准传输编码）。
// PRF 输出约定与 core 对齐：取 results.first 前 32 字节作为 KEK_prf。
// 绑定语义（Yubico PRF 指南流程）：注册期 create 即带 eval{first:盐} 请求求值，
// create 成功后立即对同一盐执行 get —— get 的 results 是权威绑定输出
//（同认证器 + 同盐 → 同输出）；解锁期 getPrfOutput 以同一盐求值即可复现。

import { base64ToBytes, randomBytes } from '@totp/core'

/** lib.dom 尚未收录的新能力/扩展：以最小结构断言（W3C WebAuthn L3 AuthenticationExtensionsPRFOutputs）：
 *  { prf: { enabled?: boolean, results?: { first: BufferSource, second?: BufferSource } } } */
interface PrfClientExtensionResults {
  prf?: {
    enabled?: boolean
    results?: { first?: BufferSource }
  }
}
interface WebAuthnCredentialLike {
  rawId: ArrayBuffer
  getClientExtensionResults(): PrfClientExtensionResults
}
interface PublicKeyCredentialStatic {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>
  getClientCapabilities?: () => Promise<{ prf?: boolean }>
}

function publicKeyCredential(): PublicKeyCredentialStatic | null {
  return (globalThis as { PublicKeyCredential?: PublicKeyCredentialStatic }).PublicKeyCredential ?? null
}

function toBase64Url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  return base64ToBytes(b64 + pad)
}

function bytesOf(src: BufferSource): Uint8Array {
  return ArrayBuffer.isView(src)
    ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
    : new Uint8Array(src)
}

/** 取 results.first 前 32B；无有效输出 → null */
function firstPrfOutput(cred: WebAuthnCredentialLike): Uint8Array | null {
  const first = cred.getClientExtensionResults().prf?.results?.first
  if (!first) return null
  const out = bytesOf(first)
  return out.length >= 32 ? out.slice(0, 32) : null
}

/** PRF 能力探测：优先 getClientCapabilities().prf（显式布尔即权威），
 *  无该 API（旧内核）或查询失败时回退平台认证器可用性探测（真实 PRF 支持由 create/get 阶段兜底返回 null） */
export async function prfSupported(): Promise<boolean> {
  const pk = publicKeyCredential()
  if (!pk?.isUserVerifyingPlatformAuthenticatorAvailable) return false
  try {
    if (pk.getClientCapabilities) {
      const caps = await pk.getClientCapabilities()
      if (typeof caps.prf === 'boolean') return caps.prf
    }
  } catch { /* capabilities 不可用 → 回退 UVPA */ }
  try {
    return await pk.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

export interface BoundPrfCredential {
  /** base64url(rawId)，存入 security.kekSources 的 prf 条目 */
  credentialId: string
  /** results.first 前 32B（绑定盐的权威求值输出），绑定 KEK_prf */
  prfOutput: Uint8Array
}

export interface CreatePrfOptions {
  /** 已绑定凭据（base64url credentialId）→ create 的 excludeCredentials，防认证器残留重复凭据 */
  excludeCredentialIds?: string[]
}

/** 对已绑定凭据执行 PRF 求值（UV 弹窗）：eval.first = 盐。
 *  用户取消 / 无 PRF 输出 → null（调用方按解锁失败处理，不抛错） */
async function requestPrfOutput(credentialId: string, salt: Uint8Array): Promise<Uint8Array | null> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32) as BufferSource,
      allowCredentials: [{ type: 'public-key', id: fromBase64Url(credentialId) as BufferSource }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt as BufferSource } } } as AuthenticationExtensionsClientInputs,
    },
  })) as unknown as WebAuthnCredentialLike | null
  if (!assertion) return null
  return firstPrfOutput(assertion)
}

/** 创建用于 PRF 解锁的 passkey 凭据：
 *  1. create 带 extensions.prf={eval:{first:盐}}（部分认证器注册期即可求值并建立内部状态）；
 *  2. create 成功后立即对该盐执行 get —— PRF 输出的权威来源（认证器支持 PRF 的可靠保证）。
 *  用户取消 / 认证器不支持 PRF / 无输出 → null（调用方提示，不抛错） */
export async function createPrfCredential(
  rpName: string,
  salt: Uint8Array,
  opts: CreatePrfOptions = {},
): Promise<BoundPrfCredential | null> {
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: randomBytes(32) as BufferSource,
        rp: { name: rpName },
        user: { id: randomBytes(16) as BufferSource, name: rpName, displayName: rpName },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: (opts.excludeCredentialIds ?? []).map((id) => ({
          type: 'public-key' as const,
          id: fromBase64Url(id) as BufferSource,
        })),
        extensions: { prf: { eval: { first: salt as BufferSource } } } as AuthenticationExtensionsClientInputs,
      },
    })) as unknown as WebAuthnCredentialLike | null
    if (!cred) return null
    const credentialId = toBase64Url(new Uint8Array(cred.rawId))
    // 注册期 outputs 不作绑定依据（create 期 results 仅为部分认证器行为），以 get 求值为准
    const prfOutput = await requestPrfOutput(credentialId, salt)
    if (!prfOutput) return null
    return { credentialId, prfOutput }
  } catch {
    return null
  }
}

/** 解锁期：对已绑定凭据以绑定盐执行 PRF 求值（UV 弹窗）。
 *  用户取消 / 无 PRF 输出 → null（调用方按解锁失败提示，不抛错） */
export async function getPrfOutput(credentialId: string, salt: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await requestPrfOutput(credentialId, salt)
  } catch {
    return null
  }
}
