// 经 ./qr 子路径直引解码纯函数：根桶会把 Vue 组件树与 ?url 资产拖进 background
// （lib mode 下资产强制内联，background.js 曾超 AMO 5MB 解析上限）
import { blobToPixels, decodeQrToUri } from '@totp/ui/qr'
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
