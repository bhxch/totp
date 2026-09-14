import { argon2id } from 'hash-wasm'

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

export function bytesToBase64(b: Uint8Array): string {
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

export async function aesGcmEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes')
  const key = await importAesKey(keyBytes)
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plaintext as BufferSource))
}

export async function aesGcmDecrypt(keyBytes: Uint8Array, data: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes')
  // AES-GCM 16B 认证标签：密文若不足 16B 即不可能含完整 tag，subtle 在底层可能返回不可预期结果；
  // 显式抛错让上层统一捕获「bad password or corrupted」语义，不向调用方泄漏底层细节。
  if (data.length < 16) throw new Error('ciphertext too short')
  const key = await importAesKey(keyBytes)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, data as BufferSource))
}
