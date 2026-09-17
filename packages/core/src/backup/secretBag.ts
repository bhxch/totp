/** DEK 保管区（设计 §1）：备份口令与各源云凭据以库 DEK AES-256-GCM 加密后落设备侧独立键。
 *  vault/云 envelope 不再含任何秘密；锁定（DEK 丢弃）后保管区密文不可解。每次密封新随机 nonce。 */
import type { CloudCred } from '../cloud/backend'
import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64, randomBytes } from '../crypto/aesgcm'

export const SECRET_BAG_KEY = 'secretBag'

export interface SecretBagContent {
  /** 备份口令；空串=未设置 */
  backupPassword: string
  /** 源 id → 云凭据 */
  creds: Record<string, CloudCred>
}

export interface SecretBagEnvelope { v: 1; nonce: string; ciphertext: string }

export function emptyBag(): SecretBagContent {
  return { backupPassword: '', creds: {} }
}

export async function sealSecretBag(dek: Uint8Array, content: SecretBagContent): Promise<string> {
  if (dek.length !== 32) throw new Error('invalid dek')
  const nonce = randomBytes(12)
  const ciphertext = await aesGcmEncrypt(dek, new TextEncoder().encode(JSON.stringify(content)), nonce)
  const env: SecretBagEnvelope = { v: 1, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) }
  return JSON.stringify(env)
}

export async function openSecretBag(dek: Uint8Array, raw: string | null): Promise<SecretBagContent> {
  if (dek.length !== 32) throw new Error('invalid dek')
  if (raw === null || raw === '') return emptyBag()
  let env: SecretBagEnvelope
  try {
    env = JSON.parse(raw) as SecretBagEnvelope
  } catch {
    return emptyBag()
  }
  if (env?.v !== 1 || typeof env.nonce !== 'string' || typeof env.ciphertext !== 'string') return emptyBag()
  // 信封字段 base64 非法属「结构损坏」而非 DEK 不匹配：按空保管区回落（不抛），与坏 JSON 同语义。
  let nonce: Uint8Array
  let data: Uint8Array
  try {
    nonce = base64ToBytes(env.nonce)
    data = base64ToBytes(env.ciphertext)
  } catch {
    return emptyBag()
  }
  let pt: Uint8Array
  try {
    pt = await aesGcmDecrypt(dek, data, nonce)
  } catch {
    throw new Error('保管区解密失败：DEK 不匹配或数据损坏')
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(pt)) as Partial<SecretBagContent>
    return { backupPassword: typeof parsed.backupPassword === 'string' ? parsed.backupPassword : '', creds: parsed.creds ?? {} }
  } catch {
    return emptyBag()
  }
}
