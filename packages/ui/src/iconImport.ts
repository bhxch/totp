import { unzipSync } from 'fflate'
import { normalizeIssuer } from '@totp/core'
import type { IconStore } from './iconStore'

export interface IconPackResult {
  imported: number
  skipped: number
  /** normalize 后的 stored id 列表 */
  names: string[]
}

const DEFAULT_MAX = 500
const DEFAULT_MAX_BYTES = 50 * 1024

function bytesToDataUrl(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:image/png;base64,${btoa(bin)}`
}

/**
 * aegis-icons 风格 zip 导入：任意层级下 *.png（大小写不敏感），
 * 文件名（去扩展名）normalizeIssuer 后作 stored id——控制器裁定：不自动映射 builtin，
 * 用户包可管理可删除。跳过：非 png 直接忽略；超 maxBytes 计 skipped；
 * 同名（normalize 后）后者覆盖前者并计 skipped；导入数达 max 停止。
 */
export async function importIconPackZip(
  zipBytes: Uint8Array,
  icons: IconStore,
  opts?: { max?: number; maxBytes?: number },
): Promise<IconPackResult> {
  const max = opts?.max ?? DEFAULT_MAX
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const files = unzipSync(zipBytes)
  let imported = 0
  let skipped = 0
  const seen = new Set<string>()
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.toLowerCase().endsWith('.png')) continue
    if (bytes.length > maxBytes) {
      skipped++
      continue
    }
    if (imported >= max) break
    const base = path.slice(path.lastIndexOf('/') + 1, -4)
    const id = normalizeIssuer(base)
    const dataUrl = bytesToDataUrl(bytes)
    const overwrite = seen.has(id)
    await icons.put(id, dataUrl)
    if (overwrite) skipped++
    else {
      imported++
      seen.add(id)
    }
  }
  return { imported, skipped, names: [...seen] }
}

/**
 * 用户上传缩放：canvas 缩放至长边 ≤size（不放大）保持比例，PNG 输出。
 * jsdom 等无 canvas 环境下 getContext 为 null，抛 Error('canvas 不可用')——
 * 真实缩放路径在浏览器手工验收。
 */
export async function fileToScaledDataUrl(file: Blob, size = 128): Promise<string> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('图片加载失败'))
      image.src = url
    })
    const scale = Math.min(1, size / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    canvas.width = w
    canvas.height = h
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}
