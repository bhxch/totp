import { STEAM_ALPHABET } from '../encoding/base32'
import { hmac, truncateU31 } from './hotp'

export async function steamCode(secret: Uint8Array, timeMs: number): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / 30)
  const message = new Uint8Array(8)
  new DataView(message.buffer).setUint32(4, counter)
  // R16①：HMAC 与「取 4 字节+清符号位」截断底层收敛到 hotp.ts 单点（原私有 hmacSha1 与其 SHA-1 特化等价）
  const mac = await hmac(secret, message, 'SHA1')
  // RFC 4226 动态截断：SHA-1 摘要仅 20 字节，偏移取末字节低 4 位（不能取"最后 4 字节"）；
  // 产出形态不变：u31 对 STEAM_ALPHABET 取模
  let n = truncateU31(mac)
  let code = ''
  for (let i = 0; i < 5; i++) {
    code += STEAM_ALPHABET[n % 26]
    n = Math.floor(n / 26)
  }
  return code
}
