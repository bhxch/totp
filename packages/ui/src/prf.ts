// WebAuthn PRF 扩展封装：passkey 解锁的浏览器侧能力探测 / 凭据创建 / PRF 求值。
// credentialId 统一以 base64url 存储（WebAuthn rawId 的标准传输编码）。
// PRF 输出约定与 core 对齐：取 evalResults[0] 前 32 字节作为 KEK_prf。

import { base64ToBytes, randomBytes } from '@totp/core'

/** lib.dom 尚未收录的新能力/扩展：以最小结构断言，避免依赖实验性类型 */
interface PrfClientExtensionResults {
  prf?: { evalResults?: ArrayBuffer[] }
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

/** 取 evalResults[0] 前 32B；无有效输出 → null */
function firstPrfOutput(cred: WebAuthnCredentialLike): Uint8Array | null {
  const first = cred.getClientExtensionResults().prf?.evalResults?.[0]
  if (!first) return null
  const out = new Uint8Array(first)
  return out.length >= 32 ? out.slice(0, 32) : null
}

/** PRF 能力探测：优先 getClientCapabilities().prf（显式布尔即权威），
 *  无该 API（旧内核）或查询失败时回退平台认证器可用性探测（真实 PRF 支持在 create 时兜底返回 null） */
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

export interface CreatedPrfCredential {
  /** base64url(rawId)，存入 security.kekSources 的 prf 条目 */
  credentialId: string
  /** evalResults[0] 前 32B，绑定 KEK_prf */
  prfOutput: Uint8Array
}

/** 创建用于 PRF 解锁的 passkey 凭据（带 prf 扩展执行一次预求值）。
 *  用户取消 / 认证器不支持 PRF / 无输出 → null（调用方提示，不抛错） */
export async function createPrfCredential(rpName: string): Promise<CreatedPrfCredential | null> {
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
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    })) as unknown as WebAuthnCredentialLike | null
    if (!cred) return null
    const prfOutput = firstPrfOutput(cred)
    if (!prfOutput) return null
    return { credentialId: toBase64Url(new Uint8Array(cred.rawId)), prfOutput }
  } catch {
    return null
  }
}

/** 对已绑定凭据执行 PRF 求值（UV 弹窗）：eval.first = salt。
 *  用户取消 / 无 PRF 输出 → null（调用方按解锁失败提示，不抛错） */
export async function getPrfOutput(credentialId: string, salt: Uint8Array): Promise<Uint8Array | null> {
  try {
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
  } catch {
    return null
  }
}
