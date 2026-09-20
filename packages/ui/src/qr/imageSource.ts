import type { ImagePixels } from './decodeQr'

export function imagesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items
  if (!items) return []
  const out: File[] = []
  for (const it of Array.from(items)) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

/** 解码位图取像素：OffscreenCanvas 优先，无则回退 DOM canvas（popup/options 均有 DOM） */
export async function blobToPixels(blob: Blob): Promise<ImagePixels> {
  const bmp = await createImageBitmap(blob)
  try {
    const w = bmp.width
    const h = bmp.height
    const canvas: OffscreenCanvas | HTMLCanvasElement =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h })
    // 联合类型上 getContext('2d') 的重载合并会退化为宽泛 RenderingContext（extension 图谱下触发），
    // 显式收窄到两类 2d 上下文；运行时行为不变
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null
    if (!ctx) throw new Error('无法创建 2d 上下文')
    ctx.drawImage(bmp, 0, 0)
    return ctx.getImageData(0, 0, w, h)
  } finally {
    bmp.close()
  }
}
