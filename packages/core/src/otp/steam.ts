import { STEAM_ALPHABET } from '../encoding/base32'

async function hmacSha1(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message as BufferSource))
}

export async function steamCode(secret: Uint8Array, timeMs: number): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / 30)
  const message = new Uint8Array(8)
  new DataView(message.buffer).setUint32(4, counter)
  const mac = await hmacSha1(secret, message)
  // RFC 4226 动态截断：以 mac[19] 低 4 位为偏移取 4 字节，并清除最高符号位
  // （Steam 官方 SteamGuard 与 steam-totp 参考实现均如此；SHA-1 摘要仅 20 字节，不能取"最后 4 字节"）
  const start = mac[19]! & 0x0f
  let n = (((mac[start]! << 24) | (mac[start + 1]! << 16) | (mac[start + 2]! << 8) | mac[start + 3]!) >>> 0) & 0x7fffffff
  let code = ''
  for (let i = 0; i < 5; i++) {
    code += STEAM_ALPHABET[n % 26]
    n = Math.floor(n / 26)
  }
  return code
}
