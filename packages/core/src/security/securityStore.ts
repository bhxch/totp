import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64, deriveKek, randomBytes } from '../crypto/aesgcm'
import { kekSourcesOf } from './multiKek'

// KEK 来源（计划11 多绑）：同一 DEK 可被多把 KEK 分别包裹；wrappedDek 字段保留为口令包裹
export type KekSource =
  | { kind: 'password' }
  | { kind: 'prf'; credentialId: string; salt: string; wrappedDekP: string }
  | { kind: 'dpapi'; wrappedDekD: string }

// 契约：wrapNonce/dataNonce 各自独立随机，禁止同 KEK/DEK 下复用 nonce（GCM 语义）
export interface SecuritySettings {
  v: 1
  enabled: true
  kdf: { alg: 'argon2id'; m: number; t: number; p: number; salt: string }
  wrapNonce: string
  wrappedDek: string
  kekSources?: KekSource[]
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
  params?: { m?: number; t?: number; p?: number },
): Promise<{ security: SecuritySettings; encrypted: EncryptedVault; dek: Uint8Array }> {
  if (params) assertKdfParams(params)
  const salt = randomBytes(16)
  const dek = randomBytes(32)
  const kek = await deriveKek(password, salt, params)
  const wrapNonce = randomBytes(12)
  const wrappedDek = await aesGcmEncrypt(kek, dek, wrapNonce)
  const security: SecuritySettings = {
    v: 1,
    enabled: true,
    kdf: {
      alg: 'argon2id',
      m: params?.m ?? 65536,
      t: params?.t ?? 3,
      p: params?.p ?? 1,
      salt: bytesToBase64(salt),
    },
    wrapNonce: bytesToBase64(wrapNonce),
    wrappedDek: bytesToBase64(wrappedDek),
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
): Promise<SecuritySettings> {
  if (dek.length !== 32) throw new Error('invalid dek')
  if (!isSecuritySettings(security)) throw new Error('invalid security settings')
  assertKdfParams(security.kdf)
  // 仅重包裹 DEK：salt/wrapNonce 全新随机，DEK 不变（数据无需重加密），KDF 费用沿用原设置
  const salt = randomBytes(16)
  const kek = await deriveKek(newPassword, salt, { m: security.kdf.m, t: security.kdf.t, p: security.kdf.p })
  const wrapNonce = randomBytes(12)
  const wrappedDek = await aesGcmEncrypt(kek, dek, wrapNonce)
  return {
    v: 1,
    enabled: true,
    kdf: { alg: 'argon2id', m: security.kdf.m, t: security.kdf.t, p: security.kdf.p, salt: bytesToBase64(salt) },
    wrapNonce: bytesToBase64(wrapNonce),
    wrappedDek: bytesToBase64(wrappedDek),
    // 多绑来源（prf/dpapi 的 wrappedDekP/D 与 DEK 绑定）不受换口令影响，原样保留
    ...(security.kekSources ? { kekSources: security.kekSources } : {}),
  }
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
