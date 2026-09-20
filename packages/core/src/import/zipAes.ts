// WinZip AES 加密（AE-1/AE-2）条目解密原语。参数为 brief 权威参数表（WinZip AES 规范 × zip4j
// AESDecryptorJCE——Aegis AuthenticatorPlusImporter 经 zip4j 读 Authenticator Plus 导出，参数一致即可互解）：
// - KDF：PBKDF2-HMAC-SHA1，迭代 1000，输出 (2*ks + 2) 字节 = encKey(ks) || authKey(ks) || verifier(2)
// - 条目布局：salt(ks/2) || verifier(2) || ciphertext || authCode(10)；strength 1/2/3 → ks 16/24/32
// - 加密：AES-CTR，初始 counter block = 全零 16B、整 128 位大端递增（JCE AES/CTR/NoPadding IV=0 同语义）
// - 完整性：HMAC-SHA1(authKey, ciphertext) 前 10 字节 == authCode；口令校验：派生 verifier 与头 2 字节比对
// - 尾部差异：AE-1（version=1）解密明文 = 原始数据 + CRC32(4B)（HMAC 覆盖含 CRC 的密文），须截除；
//   AE-2（version=2）无尾巴。version 取自 extra field 0x9901 的 formatVersion 字段

const encoder = new TextEncoder()

/** PBKDF2-HMAC-SHA1（RFC 2898/6070）：iterations 轮，输出 outBytes 字节 */
export async function pbkdf2Sha1(password: string, salt: Uint8Array, iterations: number, outBytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password) as BufferSource, 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-1', salt: salt as BufferSource, iterations }, key, outBytes * 8))
}

const ZERO_COUNTER = new Uint8Array(16)

/** WinZip AES KDF：PBKDF2-HMAC-SHA1 × 1000 → encKey || authKey || verifier(2) */
export async function deriveZipAesKeys(password: string, salt: Uint8Array, ks: 16 | 24 | 32) {
  const derived = await pbkdf2Sha1(password, salt, 1000, ks * 2 + 2)
  return {
    encKey: derived.slice(0, ks),
    authKey: derived.slice(ks, ks * 2),
    verifier: derived.slice(ks * 2),
  }
}

/** AES-CTR（counter 参数化，16B 块大端递增——WebCrypto length:128 同语义；加解对称，encrypt 即解密） */
export async function zipAesCtrDecrypt(key: Uint8Array, data: Uint8Array, counter: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-CTR', false, ['encrypt'])
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: counter as BufferSource, length: 128 }, k, data as BufferSource))
}

const STRENGTH_KS = { 1: 16, 2: 24, 3: 32 } as const

/** WinZip AES 条目解密：salt || verifier || ciphertext || authCode(10)；version=1（AE-1）额外截除明文尾部 CRC32(4B) */
export async function decryptZipEntryAes(password: string, entryData: Uint8Array, strength: 1 | 2 | 3, version: 1 | 2): Promise<Uint8Array> {
  const ks = STRENGTH_KS[strength]
  const saltLen = ks / 2
  if (entryData.length < saltLen + 2 + 10) throw new Error('AP 加密条目过短')
  const salt = entryData.slice(0, saltLen)
  const storedVerifier = entryData.slice(saltLen, saltLen + 2)
  const ciphertext = entryData.slice(saltLen + 2, entryData.length - 10)
  const authCode = entryData.slice(entryData.length - 10)
  const { encKey, authKey, verifier } = await deriveZipAesKeys(password, salt, ks)
  // 密码校验（2 字节）：不匹配=口令错误
  if (verifier[0] !== storedVerifier[0] || verifier[1] !== storedVerifier[1]) throw new Error('口令错误或文件已损坏')
  // 完整性：HMAC-SHA1(authKey, ciphertext) 前 10 字节
  const hmacKey = await crypto.subtle.importKey('raw', authKey as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, ciphertext as BufferSource)).slice(0, 10)
  for (let i = 0; i < 10; i++) if (mac[i] !== authCode[i]) throw new Error('AP 加密条目完整性校验失败（文件损坏或口令错误）')
  const plain = await zipAesCtrDecrypt(encKey, ciphertext, ZERO_COUNTER)
  return version === 1 ? plain.slice(0, plain.length - 4) : plain
}
