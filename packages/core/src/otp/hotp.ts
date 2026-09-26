export type HashAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

// Web Crypto 规范要求带连字符的算法名（SHA-1/SHA-256/SHA-512）
const WEB_CRYPTO_HASH: Record<HashAlgorithm, string> = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
}

// R16①：HMAC 原语单点导出（原 hotp 私有实现；steam.ts 的 SHA-1 特化与其等价，改导入复用）
export async function hmac(secret: Uint8Array, message: Uint8Array, algorithm: HashAlgorithm): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: WEB_CRYPTO_HASH[algorithm] }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, message as BufferSource)
  return new Uint8Array(sig)
}

// R16①：RFC 4226 动态截断底层——以末字节低 4 位为偏移取 4 字节并清最高符号位，产出 u31
// （0 ≤ n ≤ 2^31-1）。产出形态不在本层：hotp 转十进制串 padStart，steam 用字符表取模；
// yandex 为 uint64/BigInt 形态本质不同，按方案 §6 裁定不归一。
export function truncateU31(mac: Uint8Array): number {
  const offset = mac[mac.length - 1]! & 0x0f
  return (
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!
  )
}

function dynamicTruncate(mac: Uint8Array, digits: number): string {
  return String(truncateU31(mac)).padStart(digits, '0').slice(-digits)
}

export async function hotp(
  secret: Uint8Array,
  counter: number,
  opts: { algorithm?: HashAlgorithm; digits?: number } = {},
): Promise<string> {
  const { algorithm = 'SHA1', digits = 6 } = opts
  const message = new Uint8Array(8)
  const view = new DataView(message.buffer)
  view.setUint32(4, counter) // 大端 64 位，高 32 位恒 0（counter 超 2^32 不支持）
  const mac = await hmac(secret, message, algorithm)
  return dynamicTruncate(mac, digits)
}
