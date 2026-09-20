import { colsFor, renderQrSheet } from '../src/components/qrSheet'
import { describe, expect, it, vi } from 'vitest'
import type { OtpEntry } from '@totp/core'

// jsdom 无 2d 上下文：stub 为 null（renderQrSheet 对 ctx null 早退只回布局；drawQrToCanvas 同，
// 与 OtpQrDialog.test.ts 同款防御，避免虚拟控制台打「Not implemented」噪声）
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)

function entry(i: number): OtpEntry {
  return {
    uuid: `u${i}`, type: 'totp', issuer: `Svc${i}`, label: `user${i}`, secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: i, createdAt: 0,
  }
}

describe('colsFor（spec §2.5 列数自适应）', () => {
  it('≤4→2 列、≤9→3 列、更多→4 列', () => {
    expect(colsFor(1)).toBe(2); expect(colsFor(4)).toBe(2)
    expect(colsFor(5)).toBe(3); expect(colsFor(9)).toBe(3)
    expect(colsFor(10)).toBe(4); expect(colsFor(60)).toBe(4)
  })
})

describe('renderQrSheet（布局即所得：白底画布 = cols×rows 格）', () => {
  it('1 条：2 列 1 行，宽=2×cellPx、高=1×cellPx', () => {
    const canvas = document.createElement('canvas')
    const layout = renderQrSheet(canvas, [entry(1)])
    expect(layout.cols).toBe(2)
    expect(layout.width).toBe(layout.cols * layout.cellPx)
    expect(layout.height).toBe(layout.cellPx)
    expect(canvas.width).toBe(layout.width)
    expect(canvas.height).toBe(layout.height)
  })

  it('5 条：3 列 2 行', () => {
    const layout = renderQrSheet(document.createElement('canvas'), [1, 2, 3, 4, 5].map(entry))
    expect(layout.cols).toBe(3)
    expect(layout.height).toBe(2 * layout.cellPx)
  })

  it('10 条：4 列 3 行', () => {
    const layout = renderQrSheet(document.createElement('canvas'), Array.from({ length: 10 }, (_, i) => entry(i + 1)))
    expect(layout.cols).toBe(4)
    expect(layout.height).toBe(3 * layout.cellPx)
  })
})
