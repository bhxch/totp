import { colsForCount, drawQrToCanvas, qrMatrix, type QrGrid } from '../src/qr/qrDraw'
import { describe, expect, it, vi } from 'vitest'

/** 记录调用的假 2d 上下文（不装 canvas 原生包）：fillRect/fillStyle 序列即绘制断言依据 */
interface FakeCtx {
  fills: Array<{ x: number; y: number; w: number; h: number }>
  styles: string[]
  fillStyle: string
  fillRect(x: number, y: number, w: number, h: number): void
}

function makeFakeCtx(): FakeCtx {
  const ctx: FakeCtx = {
    fills: [],
    styles: [],
    fillStyle: '',
    fillRect(x, y, w, h) {
      ctx.styles.push(ctx.fillStyle)
      ctx.fills.push({ x, y, w, h })
    },
  }
  return ctx
}

/** 固定 2×2 网格（(1,0) 与 (0,1) 为黑），绘制坐标可手工推演 */
const grid: QrGrid = { size: 2, get: (x, y) => (x === 1 && y === 0) || (x === 0 && y === 1) }

function withCtx(ctx: FakeCtx | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
}

describe('drawQrToCanvas（绘制行为：假 2d context 调用序列）', () => {
  it('默认参数：moduleSize=6、quiet zone=4 模块；先白底再逐黑模块 fillRect', () => {
    const ctx = makeFakeCtx()
    withCtx(ctx)
    const canvas = document.createElement('canvas')
    drawQrToCanvas(canvas, grid)
    // 画布总尺寸 = size*module + margin*2 = 2*6 + 48 = 60
    expect(canvas.width).toBe(60)
    expect(canvas.height).toBe(60)
    // 首笔为全幅白底
    expect(ctx.styles[0]).toBe('#ffffff')
    expect(ctx.fills[0]).toEqual({ x: 0, y: 0, w: 60, h: 60 })
    // 黑模块：grid 中 2 个 true → 恰 2 笔，坐标 margin + x/y*module
    const blacks = ctx.fills.slice(1)
    expect(ctx.styles.slice(1)).toEqual(['#000000', '#000000'])
    expect(blacks[0]).toEqual({ x: 24 + 6, y: 24, w: 6, h: 6 }) // (1,0)
    expect(blacks[1]).toEqual({ x: 24, y: 24 + 6, w: 6, h: 6 }) // (0,1)
    vi.restoreAllMocks()
  })

  it('自定义 moduleSize/marginModules：总尺寸与模块坐标按换算平移', () => {
    const ctx = makeFakeCtx()
    withCtx(ctx)
    const canvas = document.createElement('canvas')
    drawQrToCanvas(canvas, grid, { moduleSize: 4, marginModules: 2 })
    expect(canvas.width).toBe(2 * 4 + 2 * 2 * 4) // 8+16=24
    const blacks = ctx.fills.slice(1)
    expect(blacks[0]).toEqual({ x: 8 + 4, y: 8, w: 4, h: 4 })
    vi.restoreAllMocks()
  })

  it('get 全 false：只有白底一笔，无黑模块', () => {
    const ctx = makeFakeCtx()
    withCtx(ctx)
    drawQrToCanvas(document.createElement('canvas'), { size: 2, get: () => false })
    expect(ctx.fills).toHaveLength(1)
    expect(ctx.styles).toEqual(['#ffffff'])
    vi.restoreAllMocks()
  })

  it('jsdom 无 2d 上下文（ctx null）：防御早退不改画布', () => {
    withCtx(null)
    const canvas = document.createElement('canvas')
    drawQrToCanvas(canvas, grid)
    expect(canvas.width).toBe(300) // HTMLCanvasElement 缺省宽，未被触碰
    vi.restoreAllMocks()
  })

  it('qrMatrix 与 drawQrToCanvas 串联：真实 URI 矩阵逐模块绘制（黑模块数一致）', () => {
    const ctx = makeFakeCtx()
    withCtx(ctx)
    const g = qrMatrix('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP')
    drawQrToCanvas(document.createElement('canvas'), g)
    let trueCount = 0
    for (let y = 0; y < g.size; y++) for (let x = 0; x < g.size; x++) if (g.get(x, y)) trueCount++
    expect(ctx.fills).toHaveLength(trueCount + 1) // +1 白底
    expect(colsForCount(1)).toBe(2) // 顺带锚定同模块导出可用
    vi.restoreAllMocks()
  })
})
