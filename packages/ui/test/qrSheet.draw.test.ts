import { buildOtpUri, type OtpEntry } from '@totp/core'
import { qrMatrix } from '../src/qr/qrDraw'
import { renderQrSheet } from '../src/components/qrSheet'
import { afterEach, describe, expect, it, vi } from 'vitest'

// getContext spy 逐用例统一还原（对齐 imageSource.pixels.test.ts 的文件级 afterEach 口径）
afterEach(() => {
  vi.restoreAllMocks()
})

/** 记录调用的假 2d 上下文：fillRect/fillText/drawImage 序列即拼版绘制断言依据 */
interface FakeCtx {
  fillRects: Array<{ x: number; y: number; w: number; h: number }>
  texts: Array<{ text: string; x: number; y: number }>
  draws: Array<{ image: HTMLCanvasElement; x: number; y: number }>
  fillStyle: string
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  drawImage(image: HTMLCanvasElement, x: number, y: number): void
}

function makeFakeCtx(): FakeCtx {
  const ctx: FakeCtx = {
    fillRects: [],
    texts: [],
    draws: [],
    fillStyle: '',
    fillRect(x, y, w, h) { ctx.fillRects.push({ x, y, w, h }) },
    fillText(text, x, y) { ctx.texts.push({ text, x, y }) },
    drawImage(image, x, y) { ctx.draws.push({ image, x, y }) },
  }
  return ctx
}

function entry(i: number): OtpEntry {
  return {
    uuid: `u${i}`, type: 'totp', issuer: `Svc${i}`, label: `user${i}`, secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: i, createdAt: 0,
  }
}

describe('renderQrSheet（拼版绘制：假 2d context 调用序列）', () => {
  it('3 条（2 列）：白底整幅 → 每格 drawImage 子画布 + issuer/label 黑字，moduleSize 换算正确', () => {
    const ctx = makeFakeCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    const canvas = document.createElement('canvas')
    const entries = [1, 2, 3].map(entry)
    const layout = renderQrSheet(canvas, entries)
    expect(layout.cols).toBe(2)
    expect(canvas.width).toBe(520)
    expect(canvas.height).toBe(520)
    // 整幅白底
    expect(ctx.fillRects[0]).toEqual({ x: 0, y: 0, w: 520, h: 520 })
    // 每条目一个子画布 + 两行文字
    expect(ctx.draws).toHaveLength(3)
    entries.forEach((e, i) => {
      const grid = qrMatrix(buildOtpUri({ type: e.type, issuer: e.issuer, label: e.label, secret: e.secret, algorithm: e.algorithm, digits: e.digits, period: e.period, counter: e.counter, pin: e.pin }))
      const moduleSize = Math.max(2, Math.floor(180 / (grid.size + 8)))
      const sub = ctx.draws[i]!.image
      expect(sub.width).toBe(grid.size * moduleSize + 8 * moduleSize) // 两侧 quiet zone 各 4 模块
      const cx = (i % 2) * 260
      const cy = Math.floor(i / 2) * 260
      expect(ctx.draws[i]!.x).toBe(cx + Math.floor((260 - sub.width) / 2))
      expect(ctx.draws[i]!.y).toBe(cy + 16)
      const issuerText = ctx.texts.find((t) => t.text === e.issuer)
      const labelText = ctx.texts.find((t) => t.text === e.label)
      expect(issuerText).toEqual({ text: e.issuer, x: cx + 130, y: cy + 214 })
      expect(labelText).toEqual({ text: e.label, x: cx + 130, y: cy + 236 })
    })
  })

  it('长 URI 密度大：moduleSize 钳制下限 2 仍可扫（子画布不小于 size*2+16）', () => {
    const ctx = makeFakeCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    const long: OtpEntry = { ...entry(1), issuer: 'LongSvc', secret: 'A'.repeat(600) } // 大矩阵压低 moduleSize
    renderQrSheet(document.createElement('canvas'), [long])
    const grid = qrMatrix(buildOtpUri({ type: long.type, issuer: long.issuer, label: long.label, secret: long.secret, algorithm: long.algorithm, digits: long.digits, period: long.period, counter: long.counter, pin: long.pin }))
    expect(grid.size + 8).toBeGreaterThan(90) // 前提：floor(180/(size+8)) 已 <2 → 命中钳制
    const sub = ctx.draws[0]!.image
    expect(sub.width).toBe(grid.size * 2 + 8 * 2)
  })

  it('jsdom 无 2d 上下文（ctx null）：仍回布局尺寸（防御早退）', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const canvas = document.createElement('canvas')
    const layout = renderQrSheet(canvas, [entry(1)])
    expect(layout).toEqual({ cols: 2, cellPx: 260, width: 520, height: 260 })
    expect(canvas.width).toBe(520)
  })
})
