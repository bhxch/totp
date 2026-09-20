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
    expect(r).toEqual({ error: '未识别到二维码' })
  })
  // 注：'hello world' 生成版本 1 最小矩阵，jsQR 识别不出（实测 null），故用可解码的较长非 otpauth 文本
  it('解码成功但非 otpauth 内容：精确中文错误', () => {
    expect(decodeQrToUri(gridToPixels('otpauth-x: //not-valid'))).toEqual({ error: '二维码内容不是有效的 otpauth 链接' })
  })
})
