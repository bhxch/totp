import { drawQrToCanvas, qrMatrix, colsForCount, COLS_TABLE } from '../src/qr/qrDraw'
import { describe, expect, it } from 'vitest'

describe('qrMatrix', () => {
  it('uri 生成方阵且三个定位角为黑（find pattern）', () => {
    const g = qrMatrix('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP')
    expect(g.size).toBeGreaterThan(20)
    for (const [ox, oy] of [[0, 0], [g.size - 7, 0], [0, g.size - 7]] as const) {
      expect(g.get(ox, oy)).toBe(true)          // 左上角模块黑
      expect(g.get(ox + 6, oy)).toBe(true)      // 定位框右缘黑
    }
  })
})

describe('COLS_TABLE', () => {
  it('拼版列数按条数自适应（spec §2.5：≤4→2、≤9→3、其余 4）', () => {
    expect(colsForCount(1)).toBe(2)
    expect(colsForCount(4)).toBe(2)
    expect(colsForCount(5)).toBe(3)
    expect(colsForCount(9)).toBe(3)
    expect(colsForCount(10)).toBe(4)
    expect(colsForCount(25)).toBe(4)
    for (const row of COLS_TABLE) {
      expect(row.maxCount).toBeGreaterThan(0)
      expect(row.cols).toBeGreaterThan(0)
    }
  })
})
