import { buildOtpUri, type OtpEntry } from '@totp/core'
import { colsForCount, drawQrToCanvas, qrMatrix } from '../qr/qrDraw'

/** 多选拼版列数（spec §2.5：≤4→2、≤9→3、其余 4）——表驱动规则归 qrDraw.colsForCount（Task 8），
 *  此处仅转调并收窄字面量类型供布局推导 */
export function colsFor(n: number): 2 | 3 | 4 {
  return colsForCount(n) as 2 | 3 | 4
}

export interface QrSheetLayout { cols: 2 | 3 | 4; cellPx: number; width: number; height: number }

/** 每格 = QR(module 自适应 + quiet zone 4) + 下方 issuer/label 黑字；整体白底。
 *  jsdom 等无 2d 上下文环境对 ctx null 早退（仍回布局尺寸，与 drawQrToCanvas 同防御） */
export function renderQrSheet(canvas: HTMLCanvasElement, entries: OtpEntry[]): QrSheetLayout {
  const cols = colsFor(entries.length)
  const rows = Math.ceil(entries.length / cols)
  const cellPx = 260
  const width = cols * cellPx
  const height = rows * cellPx
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return { cols, cellPx, width, height }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  entries.forEach((e, i) => {
    const cx = (i % cols) * cellPx
    const cy = Math.floor(i / cols) * cellPx
    const grid = qrMatrix(buildOtpUri({ type: e.type, issuer: e.issuer, label: e.label, secret: e.secret, algorithm: e.algorithm, digits: e.digits, period: e.period, counter: e.counter }))
    // module 尺寸按格内 QR 区(260-80=180px)自适应：长 URI 密度大时缩到下限 2 仍可扫
    const moduleSize = Math.max(2, Math.floor((cellPx - 80) / (grid.size + 8)))
    const sub = document.createElement('canvas')
    drawQrToCanvas(sub, grid, { moduleSize, marginModules: 4 })
    ctx.drawImage(sub, cx + Math.floor((cellPx - sub.width) / 2), cy + 16)
    ctx.fillStyle = '#000000'
    ctx.font = '16px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(e.issuer, cx + cellPx / 2, cy + cellPx - 46)
    ctx.font = '13px sans-serif'
    ctx.fillText(e.label, cx + cellPx / 2, cy + cellPx - 24)
    ctx.fillStyle = '#ffffff'
  })
  return { cols, cellPx, width, height }
}
