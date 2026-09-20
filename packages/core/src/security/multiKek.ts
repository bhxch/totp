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
  // dpapi 来源恒单份（dpapiSource 视图即单数语义）：重复绑定/旧格式重包升级时替换而非追加，
  // 防止历史无熵 wrappedDekD 残留 kekSources 导致锁定态静默解锁永远走旧格式兜底
  const others = kekSourcesOf(s).filter((src) => src.kind !== 'dpapi')
  return { ...s, kekSources: [...others, { kind: 'dpapi', wrappedDekD }] }
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
// KEK_prf = prfOutput 前 32B（WebCrypto AES-GCM 密钥要求严格 16/32B，调用方可能传 64B）。
// 逐个尝试匹配的 prf 来源，全部失败/无来源 → Error('passkey 解锁失败）。
export async function unlockWithPrf(
  s: SecuritySettings,
  prfOutput: Uint8Array,
  match?: { credentialId?: string },
): Promise<Uint8Array> {
  if (prfOutput.length < 32) throw new Error('invalid prf output')
  const sources = kekSourcesOf(s).filter(
    (src): src is PrfSource =>
      src.kind === 'prf' && (match?.credentialId === undefined || src.credentialId === match.credentialId),
  )
  // 提取前 32B 作为 KEK_prf 一次性（避免循环内重复 subarray）
  const kek = prfOutput.subarray(0, 32)
  for (const src of sources) {
    try {
      const blob = base64ToBytes(src.wrappedDekP)
      const dek = await aesGcmDecrypt(kek, blob.subarray(12), blob.subarray(0, 12))
      // C1：明示拒绝长度非 32B 的解密结果——wrappedDekP 可被构造产生可控 32B 假明文，
      // 静默返回会让 addPrfSourceOp 后续把伪 DEK 当真 DEK 用，引发幽灵加密
      if (dek.length !== 32) throw new Error('invalid DEK length from PRF unwrap')
      return dek
    } catch (e) {
      // 区分「长度校验失败」(C1 真实数据错误) 与「解密失败」(尝试下一 prf 来源)
      if (e instanceof Error && e.message === 'invalid DEK length from PRF unwrap') throw e
      // 尝试下一 prf 来源
    }
  }
  throw new Error('passkey 解锁失败')
}
