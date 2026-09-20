import jsQR from 'jsqr'
import { parseOtpUri } from '@totp/core'

export interface ImagePixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** 纯像素解码：成功返回码文本，识别失败返回 null */
export function decodeQrPixels(p: ImagePixels): string | null {
  const r = jsQR(p.data, p.width, p.height)
  return r?.data ?? null
}

/** 解码并校验为 otpauth 链接；parseOtpUri 仅作通过性校验，popup 预填通道会再解析一次，成本可忽略 */
export function decodeQrToUri(p: ImagePixels): { uri: string } | { error: string } {
  const text = decodeQrPixels(p)
  if (text === null) return { error: '未识别到二维码' }
  try {
    parseOtpUri(text)
    return { uri: text }
  } catch {
    return { error: '二维码内容不是有效的 otpauth 链接' }
  }
}
