import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64, deriveKek, randomBytes } from '../crypto/aesgcm'
import { DEFAULT_KDF_PROFILE, isKdfProfile, KDF_PROFILES, type KdfProfile } from '../crypto/kdfProfile'

// 档位类型与展开常量定义在 crypto/kdfProfile（与 securityStore 的公共依赖，零循环）；re-export 保持既有公共出口
export { DEFAULT_KDF_PROFILE, isKdfProfile, KDF_PROFILES } from '../crypto/kdfProfile'
export type { KdfProfile } from '../crypto/kdfProfile'

// 契约：wrapNonce/dataNonce 各自独立随机，禁止同 KEK/DEK 下复用 nonce（GCM 语义）
export interface BackupEnvelope {
  v: 2
  kdf: { alg: 'argon2id'; profile: KdfProfile; m: number; t: number; p: number; salt: string }
  wrapNonce: string
  wrappedDek: string
  aead: 'aes-256-gcm'
  dataNonce: string
  ciphertext: string
}

export function isBackupEnvelope(x: unknown): x is BackupEnvelope {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    o['v'] === 2 &&
    typeof o['kdf'] === 'object' && o['kdf'] !== null &&
    // 应用未发布，放弃 v1 兼容：只认 v2 且 AEAD 只认 aes-256-gcm
    o['aead'] === 'aes-256-gcm' &&
    typeof o['wrapNonce'] === 'string' &&
    typeof o['wrappedDek'] === 'string' &&
    typeof o['dataNonce'] === 'string' &&
    typeof o['ciphertext'] === 'string'
  )
}

export async function createBackupEnvelope(vaultJson: string, password: string, profile: KdfProfile = DEFAULT_KDF_PROFILE): Promise<BackupEnvelope> {
  const prof = isKdfProfile(profile) ? profile : DEFAULT_KDF_PROFILE
  const { m, t, p } = KDF_PROFILES[prof]
  const salt = randomBytes(16)
  const dek = randomBytes(32)
  const kek = await deriveKek(password, salt, { m, t, p })
  const wrapNonce = randomBytes(12)
  const wrappedDek = await aesGcmEncrypt(kek, dek, wrapNonce)
  const dataNonce = randomBytes(12)
  const ciphertext = await aesGcmEncrypt(dek, new TextEncoder().encode(vaultJson), dataNonce)
  return {
    v: 2,
    kdf: { alg: 'argon2id', profile: prof, m, t, p, salt: bytesToBase64(salt) },
    wrapNonce: bytesToBase64(wrapNonce),
    wrappedDek: bytesToBase64(wrappedDek),
    aead: 'aes-256-gcm',
    dataNonce: bytesToBase64(dataNonce),
    ciphertext: bytesToBase64(ciphertext),
  }
}

export async function openBackupEnvelope(env: unknown, password: string): Promise<string> {
  if (!isBackupEnvelope(env)) throw new Error('invalid backup envelope')
  const kdf = env.kdf as { alg?: string; m?: number; t?: number; p?: number; salt?: string }
  if (kdf.alg !== 'argon2id' || typeof kdf.salt !== 'string') throw new Error('invalid backup envelope')
  // 钳制 envelope 自带的 KDF 参数：恶意文件可声明超大/超小 m/t/p 使 argon2id 资源耗尽或被旁路；
  // 下限遵循 Argon2id 规范/OWASP 最低推荐（m≥1024 KiB / t≥1 / p≥1），上限为正常写入参数（m=65536/t=3/p=1）的宽裕倍数，超限一律拒绝；
  // 钳的是展开值——kdf.profile 仅记录写入意图，不参与校验（向后兼容新档位名）
  if (
    (kdf.m !== undefined && (typeof kdf.m !== 'number' || kdf.m < 1024 || kdf.m > 2 ** 21)) ||
    (kdf.t !== undefined && (typeof kdf.t !== 'number' || kdf.t < 1 || kdf.t > 10)) ||
    (kdf.p !== undefined && (typeof kdf.p !== 'number' || kdf.p < 1 || kdf.p > 8))
  ) throw new Error('invalid backup envelope')
  let kek: Uint8Array
  try {
    kek = await deriveKek(password, base64ToBytes(kdf.salt), { m: kdf.m, t: kdf.t, p: kdf.p })
  } catch {
    throw new Error('invalid backup envelope')
  }
  let dek: Uint8Array
  try {
    dek = await aesGcmDecrypt(kek, base64ToBytes(env.wrappedDek), base64ToBytes(env.wrapNonce))
  } catch {
    throw new Error('bad password or corrupted backup')
  }
  try {
    const pt = await aesGcmDecrypt(dek, base64ToBytes(env.ciphertext), base64ToBytes(env.dataNonce))
    return new TextDecoder().decode(pt)
  } catch {
    throw new Error('bad password or corrupted backup')
  }
}
