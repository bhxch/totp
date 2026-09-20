import { decodeQrPixels, decodeQrToUri, type ImagePixels } from '../src/qr/decodeQr'
import { qrMatrix } from '../src/qr/qrDraw'
import { describe, expect, it } from 'vitest'

function gridToPixels(text: string, margin = 4): ImagePixels {
  const g = qrMatrix(text)
  const w = g.size + margin * 2
  const data = new Uint8ClampedArray(w * w * 4).fill(255)
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.get(x, y)) continue
      const i = ((y + margin) * w + (x + margin)) * 4
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255
    }
  }
  return { data, width: w, height: w }
}

describe('decodeQrPixels', () => {
  it('round-trip：otpauth URI 生成→解码恒等', () => {
    const uri = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
    expect(decodeQrPixels(gridToPixels(uri))).toBe(uri)
  })
  it('非二维码像素返回 null', () => {
    const blank = new Uint8ClampedArray(100 * 100 * 4).fill(255)
    expect(decodeQrPixels({ data: blank, width: 100, height: 100 })).toBeNull()
  })
  it('decodeQrToUri：非法码文本给中文错误', () => {
    const r = decodeQrToUri({ data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 })
    expect(r).toHaveProperty('error')
  })
})
