import { base32Decode } from '../encoding/base32'

// Yandex（yaotp）算法：对齐 Aegis 移植的 YandexInfo.validateSecret + crypto/otp/YAOTP.java（spec 批③ §4.1 权威算法，参数不得改动）。
// 要点：key = SHA-256(UTF8(pin) || secret)（首字节为 0 时去掉）；counter 8 字节大端；
// HMAC-SHA256 后 RFC 4226 动态截断取 uint64，mod 26^digits，低位在前逐位映射为小写字母（a-z）。

export const YANDEX_DIGITS = 8
const CRC_POLY = 0b1_1000_1111_0011

/**
 * YandexInfo.validateSecret 移植（Aegis app/otp/YandexInfo.java，源自 KeeYaOtp Secret.cs ChecksumIsValid）：
 * 16B 直通（二维码来源无校验和，视为合法）；26B 时尾部 12 位（secret[24] 低 4 位 + secret[25]）为校验值，
 * 前 196 位数据流按 MSB-first 每 13 位一组模 2 异或 poly（0x18F3），16 位累积寄存器最终须等于校验值。
 */
export function yandexValidateSecret(secret: Uint8Array): void {
  if (secret.length === 16) return
  if (secret.length !== 26) throw new Error('yandex secret 长度非法（须 16 或 26 字节）')
  const originalChecksum = ((secret[24]! & 0x0f) << 8) | secret[25]!
  let accum = 0
  let accumBits = 0
  let totalBits = secret.length * 8 - 12
  let inputIndex = 0
  let inputBitsAvailable = 8
  while (totalBits > 0) {
    let requiredBits = 13 - accumBits
    if (totalBits < requiredBits) requiredBits = totalBits
    while (requiredBits > 0) {
      const curInput = secret[inputIndex]! & ((1 << inputBitsAvailable) - 1)
      const bitsToRead = Math.min(requiredBits, inputBitsAvailable)
      accum = ((accum << bitsToRead) | (curInput >> (inputBitsAvailable - bitsToRead))) & 0xffff
      totalBits -= bitsToRead
      requiredBits -= bitsToRead
      inputBitsAvailable -= bitsToRead
      accumBits += bitsToRead
      if (inputBitsAvailable === 0) {
        inputIndex += 1
        inputBitsAvailable = 8
      }
    }
    if (accumBits === 13) accum ^= CRC_POLY
    // Java: accumBits = 16 - numberOfLeadingZeros16(accum)；accum ≤ 0xffff 时 clz32 = 16 + 前导零
    accumBits = accum === 0 ? 0 : 32 - Math.clz32(accum)
  }
  if (accum !== originalChecksum) throw new Error('yandex secret 校验和不匹配')
}

/** Yandex secret（base32）→ 16 字节（26B 先过校验再取前 16） */
export function yandexSecretBytes(secretB32: string): Uint8Array {
  const bytes = base32Decode(secretB32.replace(/\s+/g, '').toUpperCase())
  yandexValidateSecret(bytes)
  return bytes.length === 26 ? bytes.slice(0, 16) : bytes
}

/** YAOTP.generateOTP 移植（spec 批③ §4.1 权威算法 1-5 步） */
export async function yandexCode(secretB32: string, pin: string, timeMs: number, period = 30, digits = YANDEX_DIGITS): Promise<string> {
  const secret = yandexSecretBytes(secretB32)
  const pinBytes = new TextEncoder().encode(pin)
  const merged = new Uint8Array(pinBytes.length + secret.length)
  merged.set(pinBytes); merged.set(secret, pinBytes.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', merged))
  const key = digest[0] === 0 ? digest.slice(1) : digest
  const counter = Math.floor(timeMs / 1000 / period)
  const msg = new Uint8Array(8)
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter))
  const hmacKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, msg))
  const off = h[h.length - 1]! & 0xf
  h[off]! &= 0x7f
  let code = new DataView(h.buffer, h.byteOffset).getBigUint64(off) % 26n ** BigInt(digits)
  let out = ''
  for (let i = 0; i < digits; i++) { out += String.fromCharCode(97 + Number(code % 26n)); code /= 26n }
  return out
}
