import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64, deriveKek, randomBytes } from '../crypto/aesgcm'
import { DEFAULT_KDF_PROFILE, isKdfProfile, KDF_PROFILES, type KdfProfile } from '../crypto/kdfProfile'
import { kekSourcesOf } from './multiKek'

export { DEFAULT_KDF_PROFILE, isKdfProfile, KDF_PROFILES } from '../crypto/kdfProfile'
export type { KdfProfile } from '../crypto/kdfProfile'

// KEK 来源（计划11 多绑）：同一 DEK 可被多把 KEK 分别包裹；wrappedDek 字段保留为口令包裹
export type KekSource =
  | { kind: 'password' }
  | { kind: 'prf'; credentialId: string; salt: string; wrappedDekP: string }
  | { kind: 'dpapi'; wrappedDekD: string }

// 契约：wrapNonce/dataNonce 各自独立随机，禁止同 KEK/DEK 下复用 nonce（GCM 语义）
export interface SecuritySettings {
  v: 1
  enabled: true
  /** profile 镜像落盘（与 envelope v2 kdf 块同形）；顶层 profile 为展示权威，两者同写 */
  kdf: { alg: 'argon2id'; m: number; t: number; p: number; salt: string; profile?: KdfProfile }
  wrapNonce: string
  wrappedDek: string
  kekSources?: KekSource[]
  /** KDF 档位（设计 §2）：写入时记录的档位意图，仅展示用；旧数据缺失视为 balanced */
  profile?: KdfProfile
  /** 主口令最后更换时刻（设计 §2 天数提示/被动轮换）；旧数据缺失视为未记录 */
  passwordChangedAt?: number
}

export interface EncryptedVault { v: 1; enc: true; dataNonce: string; ciphertext: string }

export const SECURITY_KEY = 'security'

// 钳制 security 自带的 KDF 参数：恶意数据可声明超大/超小 m/t/p 使 argon2id 资源耗尽或被旁路；
// 下限遵循 Argon2id 规范/OWASP 最低推荐（m≥1024 KiB / t≥1 / p≥1），上限与 backup/envelope 一致（m=2**21/t=10/p=8）
const MIN_M = 1024
const MAX_M = 2 ** 21
const MIN_T = 1
const MAX_T = 10
const MIN_P = 1
const MAX_P = 8

function assertKdfParams(params: { m?: unknown; t?: unknown; p?: unknown }): void {
  if (
    (params.m !== undefined && (typeof params.m !== 'number' || params.m < MIN_M || params.m > MAX_M)) ||
    (params.t !== undefined && (typeof params.t !== 'number' || params.t < MIN_T || params.t > MAX_T)) ||
    (params.p !== undefined && (typeof params.p !== 'number' || params.p < MIN_P || params.p > MAX_P))
  ) throw new Error('invalid security settings')
}

export function isEncryptedVault(x: unknown): x is EncryptedVault {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    o['v'] === 1 &&
    o['enc'] === true &&
    typeof o['dataNonce'] === 'string' &&
    typeof o['ciphertext'] === 'string'
  )
}

export function isSecuritySettings(x: unknown): x is SecuritySettings {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  const kdf = o['kdf']
  if (typeof kdf !== 'object' || kdf === null) return false
  const k = kdf as Record<string, unknown>
  return (
    o['v'] === 1 &&
    o['enabled'] === true &&
    k['alg'] === 'argon2id' &&
    typeof k['salt'] === 'string' &&
    typeof o['wrapNonce'] === 'string' &&
    typeof o['wrappedDek'] === 'string'
  )
}

export async function setupVaultEncryption(
  vaultJson: string,
  password: string,
  // 故意只接受档位名而非裸参数：KDF 展开值统一由 KDF_PROFILES 给出，避免外部调用注入「极弱」配置绕过 argon2id 强度
  opts: { profile?: KdfProfile } = {},
): Promise<{ security: SecuritySettings; encrypted: EncryptedVault; dek: Uint8Array }> {
  const profile = isKdfProfile(opts.profile) ? opts.profile : DEFAULT_KDF_PROFILE
  const { m, t, p } = KDF_PROFILES[profile]
  const salt = randomBytes(16)
  const dek = randomBytes(32)
  const kek = await deriveKek(password, salt, { m, t, p })
  const wrapNonce = randomBytes(12)
  const wrappedDek = await aesGcmEncrypt(kek, dek, wrapNonce)
  const security: SecuritySettings = {
    v: 1,
    enabled: true,
    kdf: {
      alg: 'argon2id',
      m,
      t,
      p,
      salt: bytesToBase64(salt),
      profile,
    },
    wrapNonce: bytesToBase64(wrapNonce),
    wrappedDek: bytesToBase64(wrappedDek),
    profile,
    passwordChangedAt: Date.now(),
  }
  const encrypted = await encryptVaultWithDek(dek, vaultJson)
  return { security, encrypted, dek }
}

export async function unlockVaultEncryption(security: SecuritySettings, password: string): Promise<Uint8Array> {
  if (!isSecuritySettings(security)) throw new Error('invalid security settings')
  const kdf = security.kdf as { alg?: string; m?: number; t?: number; p?: number; salt?: string }
  if (kdf.alg !== 'argon2id' || typeof kdf.salt !== 'string') throw new Error('invalid security settings')
  assertKdfParams(kdf)
  let kek: Uint8Array
  try {
    kek = await deriveKek(password, base64ToBytes(kdf.salt), { m: kdf.m, t: kdf.t, p: kdf.p })
  } catch {
    throw new Error('invalid security settings')
  }
  try {
    return await aesGcmDecrypt(kek, base64ToBytes(security.wrappedDek), base64ToBytes(security.wrapNonce))
  } catch {
    throw new Error('口令错误或数据已损坏')
  }
}

export async function encryptVaultWithDek(dek: Uint8Array, vaultJson: string): Promise<EncryptedVault> {
  if (dek.length !== 32) throw new Error('invalid dek')
  const dataNonce = randomBytes(12)
  const ciphertext = await aesGcmEncrypt(dek, new TextEncoder().encode(vaultJson), dataNonce)
  return { v: 1, enc: true, dataNonce: bytesToBase64(dataNonce), ciphertext: bytesToBase64(ciphertext) }
}

export async function decryptVaultWithDek(dek: Uint8Array, enc: EncryptedVault): Promise<string> {
  if (dek.length !== 32) throw new Error('invalid dek')
  if (!isEncryptedVault(enc)) throw new Error('invalid encrypted vault')
  const pt = await aesGcmDecrypt(dek, base64ToBytes(enc.ciphertext), base64ToBytes(enc.dataNonce))
  return new TextDecoder().decode(pt)
}

export async function changeVaultPassphrase(
  security: SecuritySettings,
  dek: Uint8Array,
  newPassword: string,
  opts: { rotateDek?: boolean; profile?: KdfProfile } = {},
): Promise<{ security: SecuritySettings; dek: Uint8Array | null }> {
  if (dek.length !== 32) throw new Error('invalid dek')
  if (!isSecuritySettings(security)) throw new Error('invalid security settings')
  assertKdfParams(security.kdf)
  // 档位切换（设计 §2 立即生效裁定）：提供 profile 时用新档位展开参数重 wrap（salt 本就全新随机，数据无需重加密）；缺省沿用原设置
  const profile = isKdfProfile(opts.profile) ? opts.profile : undefined
  const m = profile ? KDF_PROFILES[profile].m : security.kdf.m
  const t = profile ? KDF_PROFILES[profile].t : security.kdf.t
  const p = profile ? KDF_PROFILES[profile].p : security.kdf.p
  // 被动轮换（设计 §2）：rotateDek=true 时重生成 DEK 作被包裹对象并返回，调用方须全库重加密 + 保管区重封
  const nextDek = opts.rotateDek ? randomBytes(32) : dek
  // 仅重包裹 DEK：salt/wrapNonce 全新随机（数据无需重加密）
  const salt = randomBytes(16)
  const kek = await deriveKek(newPassword, salt, { m, t, p })
  const wrapNonce = randomBytes(12)
  const wrappedDek = await aesGcmEncrypt(kek, nextDek, wrapNonce)
  // 恒刷新（设计 §2）：改口令/轮换/换档都视作口令凭证更新
  const nextProfile = profile ?? security.profile
  return {
    security: {
      v: 1,
      enabled: true,
      kdf: { alg: 'argon2id', m, t, p, salt: bytesToBase64(salt), profile: nextProfile },
      wrapNonce: bytesToBase64(wrapNonce),
      wrappedDek: bytesToBase64(wrappedDek),
      // 多绑来源的数据层失效语义：prf/dpapi 的 wrappedDekP/D 包裹的是旧 DEK，rotateDek=true 轮换后
      // 新 DEK 不可能由旧凭证源解开——留盘只会把「未绑定」误报成「解密失败」，故轮换路径直接丢弃，
      // 仅保留 password 源（口令通道恒可用，不产生死锁）；宿主 UI 需引导用户重新绑定 passkey/DPAPI。
      // rotateDek=false 仅换口令时凭证源与 DEK 绑定关系不变，原样保留。
      // 走 kekSourcesOf 归一：旧数据缺字段/空数组/全非法 → [{kind:'password'}]，避免原条件展开在「旧密码无 kekSources」分支漏写 password 源导致换口令后多绑列表丢失。
      // M6：去重 — 旧数据/手改/历史 bug 引入同 kind 重复条目时，换口令后只保留首条，避免后续 UI 列表渲染重复项
      kekSources: opts.rotateDek ? [{ kind: 'password' }] : removeDuplicateKekSources(kekSourcesOf(security)),
      // 档位未提供时保留原档位意图（无档位记录的旧数据保持 undefined）
      profile: nextProfile,
      // 恒刷新（设计 §2）：改口令/轮换/换档都视作口令凭证更新
      passwordChangedAt: Date.now(),
    },
    dek: opts.rotateDek ? nextDek : null,
  }
}

/** kekSources 去重：password/dpapi 各保留首个；prf 按 credentialId 保留首个。语义：同 kind 多份等价（仅首条实际参与解锁），多余条目仅占空间且误导 UI */
function removeDuplicateKekSources(sources: ReturnType<typeof kekSourcesOf>): ReturnType<typeof kekSourcesOf> {
  const seenPassword = new Set<'password'>()
  const seenDpapi = new Set<'dpapi'>()
  const seenPrf = new Set<string>() // credentialId
  const out: ReturnType<typeof kekSourcesOf> = []
  for (const s of sources) {
    if (s.kind === 'password') {
      if (seenPassword.has('password')) continue
      seenPassword.add('password')
      out.push(s)
    } else if (s.kind === 'dpapi') {
      if (seenDpapi.has('dpapi')) continue
      seenDpapi.add('dpapi')
      out.push(s)
    } else {
      if (seenPrf.has(s.credentialId)) continue
      seenPrf.add(s.credentialId)
      out.push(s)
    }
  }
  return out
}

/** 添加/替换 prf KEK 来源：KEK_prf = prfOutput 前 32B，wrappedDekP = base64(nonce(12B) ‖ AES-GCM(DEK))。
 *  同 credentialId 已存在时替换（先移除再添加），其余来源原样保留；salt 为 base64（解锁时 PRF eval 用） */
export async function addPrfSource(
  settings: SecuritySettings,
  dek: Uint8Array,
  credentialId: string,
  prfOutput: Uint8Array,
  salt: string,
): Promise<SecuritySettings> {
  if (dek.length !== 32) throw new Error('invalid dek')
  if (!isSecuritySettings(settings)) throw new Error('invalid security settings')
  if (prfOutput.length < 32) throw new Error('invalid prf output')
  const nonce = randomBytes(12)
  const ct = await aesGcmEncrypt(prfOutput.subarray(0, 32), dek, nonce)
  const blob = new Uint8Array(12 + ct.length)
  blob.set(nonce, 0)
  blob.set(ct, 12)
  const others = kekSourcesOf(settings).filter((src) => !(src.kind === 'prf' && src.credentialId === credentialId))
  return {
    ...settings,
    kekSources: [...others, { kind: 'prf', credentialId, salt, wrappedDekP: bytesToBase64(blob) }],
  }
}
