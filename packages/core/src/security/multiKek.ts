import { aesGcmDecrypt, base64ToBytes } from '../crypto/aesgcm'
import type { KekSource, SecuritySettings } from './securityStore'

export type { KekSource }

type PrfSource = Extract<KekSource, { kind: 'prf' }>

function isKekSource(x: unknown): x is KekSource {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  if (o['kind'] === 'password') return true
  if (o['kind'] === 'prf') {
    return (
      typeof o['credentialId'] === 'string' &&
      typeof o['salt'] === 'string' &&
      typeof o['wrappedDekP'] === 'string'
    )
  }
  if (o['kind'] === 'dpapi') return typeof o['wrappedDekD'] === 'string'
  return false
}

// 归一化规则（旧数据兼容）：kekSources 字段存在且过滤非法条目后非空 → 按条目返回（不补 password）；
// 字段缺失/非数组/空/全部非法 → [{kind:'password'}]
export function kekSourcesOf(s: SecuritySettings): KekSource[] {
  const raw: unknown = s.kekSources
  if (Array.isArray(raw)) {
    const valid = raw.filter(isKekSource)
    if (valid.length > 0) return valid
  }
  return [{ kind: 'password' }]
}

export function withPrfSource(
  s: SecuritySettings,
  credentialId: string,
  salt: string,
  wrappedDekP: string,
): SecuritySettings {
  return { ...s, kekSources: [...kekSourcesOf(s), { kind: 'prf', credentialId, salt, wrappedDekP }] }
}

export function withDpapiSource(s: SecuritySettings, wrappedDekD: string): SecuritySettings {
  return { ...s, kekSources: [...kekSourcesOf(s), { kind: 'dpapi', wrappedDekD }] }
}

// 移除指定来源；移除后一个来源不剩 → 抛 Error('至少保留一种解锁方式')
// prf 可按 credentialId 精确移除；password 移除后必须仍有其余来源
export function removeKekSource(
  s: SecuritySettings,
  kind: 'prf' | 'dpapi' | 'password',
  match?: { credentialId?: string },
): SecuritySettings {
  const remaining = kekSourcesOf(s).filter((src) => {
    if (src.kind !== kind) return true
    if (src.kind === 'prf' && match?.credentialId !== undefined && src.credentialId !== match.credentialId) return true
    return false
  })
  if (remaining.length === 0) throw new Error('至少保留一种解锁方式')
  return { ...s, kekSources: remaining }
}

// wrappedDekP 编码：base64(nonce(12B) ‖ AES-GCM 密文)，nonce 独立随机（GCM 语义同 securityStore 契约）
// KEK_prf = prfOutput 前 32B；逐个尝试匹配的 prf 来源，全部失败/无来源 → Error('passkey 解锁失败')
export async function unlockWithPrf(
  s: SecuritySettings,
  prfOutput: Uint8Array,
  match?: { credentialId?: string },
): Promise<Uint8Array> {
  const sources = kekSourcesOf(s).filter(
    (src): src is PrfSource =>
      src.kind === 'prf' && (match?.credentialId === undefined || src.credentialId === match.credentialId),
  )
  for (const src of sources) {
    try {
      const blob = base64ToBytes(src.wrappedDekP)
      const dek = await aesGcmDecrypt(prfOutput.subarray(0, 32), blob.subarray(12), blob.subarray(0, 12))
      if (dek.length === 32) return dek
    } catch {
      // 尝试下一 prf 来源
    }
  }
  throw new Error('passkey 解锁失败')
}
