import { argon2id } from 'hash-wasm'

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

export function bytesToBase64(b: Uint8Array): string {
  // M3：空 bytes 短路 — btoa('') === '' 行为正确但循环 0 次是常量级无副作用；
  // 此处显式短路仅为「让意图明显 + 避免无关 for 循环」的微小清理。
  if (b.length === 0) return ''
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return btoa(s)
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function deriveKek(
  password: string,
  salt: Uint8Array,
  params: { m?: number; t?: number; p?: number } = {},
): Promise<Uint8Array> {
  const { m = 65536, t = 3, p = 1 } = params
  return (await argon2id({
    password,
    salt,
    parallelism: p,
    iterations: t,
    memorySize: m,
    hashLength: 32,
    outputType: 'binary',
  })) as Uint8Array
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (keyBytes.length !== 32) throw new Error('AES-256 key must be 32 bytes')
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

// F8：additionalData 可选参数（undefined 时与无 AAD 完全同字节——WebIDL 字典成员 undefined 视为缺省，
// 此处仍显式展开以杜绝运行时差异）；既有调用方不传即保持原行为
export async function aesGcmEncrypt(
  keyBytes: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array, additionalData?: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes')
  const key = await importAesKey(keyBytes)
  const params: AesGcmParams = { name: 'AES-GCM', iv: nonce as BufferSource }
  if (additionalData) params.additionalData = additionalData as BufferSource
  return new Uint8Array(await crypto.subtle.encrypt(params, key, plaintext as BufferSource))
}

export async function aesGcmDecrypt(
  keyBytes: Uint8Array, data: Uint8Array, nonce: Uint8Array, additionalData?: Uint8Array,
): Promise<Uint8Array> {
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes')
  // AES-GCM 16B 认证标签：密文若不足 16B 即不可能含完整 tag，subtle 在底层可能返回不可预期结果；
  // 显式抛错让上层统一捕获「bad password or corrupted」语义，不向调用方泄漏底层细节。
  if (data.length < 16) throw new Error('ciphertext too short')
  const key = await importAesKey(keyBytes)
  const params: AesGcmParams = { name: 'AES-GCM', iv: nonce as BufferSource }
  if (additionalData) params.additionalData = additionalData as BufferSource
  return new Uint8Array(await crypto.subtle.decrypt(params, key, data as BufferSource))
}
