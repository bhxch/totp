import { blobToPixels, decodeQrToUri } from '@totp/ui'
import { parseOtpUri } from '@totp/core'

/** 图片字节 → otpauth URI（无法解码/非 otpauth 内容均返回 null，调用方统一提示） */
export async function decodeImageBytesToUri(bytes: Uint8Array): Promise<string | null> {
  let uri: string
  try {
    const r = decodeQrToUri(await blobToPixels(new Blob([bytes as BlobPart])))
    if ('error' in r) return null
    uri = r.uri
  } catch {
    return null
  }
  try {
    parseOtpUri(uri)
    return uri
  } catch {
    return null
  }
}
