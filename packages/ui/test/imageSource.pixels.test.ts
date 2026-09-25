import { blobToPixels } from '../src/qr/imageSource'
import { describe, expect, it, vi } from 'vitest'

/** 记录调用的假 2d 上下文（drawImage/getImageData） */
function makeFakeCtx(pixels: { data: Uint8ClampedArray; width: number; height: number } | null) {
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => pixels),
  }
}

interface OffscreenOptsHolder {
  lastOpts: { willReadFrequently?: boolean } | null
  lastSize: { w: number; h: number } | null
}

/** jsdom 无 createImageBitmap / OffscreenCanvas：均以 stubGlobal 替身（与运行时 Blob→Bitmap→像素管线同形） */
function stubBitmap(width = 2, height = 2) {
  const closed = vi.fn()
  const bmp = { width, height, close: closed }
  const createImageBitmap = vi.fn(async () => bmp)
  vi.stubGlobal('createImageBitmap', createImageBitmap)
  return { bmp, closed, createImageBitmap }
}

function stubOffscreen(ctx: ReturnType<typeof makeFakeCtx> | null): OffscreenOptsHolder {
  const holder: OffscreenOptsHolder = { lastOpts: null, lastSize: null }
  class FakeOffscreen {
    width: number
    height: number
    constructor(w: number, h: number) {
      holder.lastSize = { w, h }
      this.width = w
      this.height = h
    }
    getContext(_kind: string, opts?: { willReadFrequently?: boolean }) {
      holder.lastOpts = opts ?? null
      return ctx
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen)
  return holder
}

describe('blobToPixels（OffscreenCanvas 主路径）', () => {
  it('位图绘制到 OffscreenCanvas 后读出像素：willReadFrequently=true，bmp 用毕关闭', async () => {
    const pixels = { data: new Uint8ClampedArray([1, 2, 3, 4]), width: 2, height: 2 }
    const ctx = makeFakeCtx(pixels)
    const { bmp, closed, createImageBitmap } = stubBitmap()
    const holder = stubOffscreen(ctx)
    const blob = new Blob(['x'], { type: 'image/png' })
    const out = await blobToPixels(blob)
    expect(createImageBitmap).toHaveBeenCalledWith(blob)
    expect(holder.lastSize).toEqual({ w: 2, h: 2 }) // 画布按位图尺寸创建
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0)
    expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 2, 2)
    expect(holder.lastOpts?.willReadFrequently).toBe(true)
    expect(out).toBe(pixels)
    expect(closed).toHaveBeenCalledTimes(1) // finally 关闭位图
  })

  it('getContext 返回 null：抛「无法创建 2d 上下文」且 bmp 仍被关闭（finally 兜底）', async () => {
    const { closed } = stubBitmap()
    stubOffscreen(null)
    await expect(blobToPixels(new Blob(['x']))).rejects.toThrow('无法创建 2d 上下文')
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe('blobToPixels（DOM canvas 回退路径：无 OffscreenCanvas 宿主）', () => {
  it('document.createElement canvas + 2d 上下文同样产出像素', async () => {
    const pixels = { data: new Uint8ClampedArray([9, 9, 9, 9]), width: 2, height: 2 }
    const ctx = makeFakeCtx(pixels)
    const { bmp, closed } = stubBitmap()
    vi.stubGlobal('OffscreenCanvas', undefined) // 走 DOM canvas 分支
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    const out = await blobToPixels(new Blob(['x']))
    expect(spy).toHaveBeenCalledWith('2d', { willReadFrequently: true })
    expect(ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0)
    expect(out).toBe(pixels)
    expect(closed).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
})
