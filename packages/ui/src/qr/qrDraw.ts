import { encode } from 'uqr'

export interface QrGrid {
  size: number
  get(x: number, y: number): boolean
}

/** uqr 生成矩阵（纠错 M，spec §2.4）；border: 0 使矩阵为纯 QR 模块（(0,0) 即 finder 左上角），quiet zone 由绘制层 marginModules 保证 */
export function qrMatrix(text: string): QrGrid {
  const { size, data } = encode(text, { ecc: 'M', border: 0 })
  return { size, get: (x, y) => data[y]![x] === true }
}

export interface QrDrawOpts {
  moduleSize?: number
  marginModules?: number
}

/** 白底黑码（扫描对比度），ctx 就地绘制不清理外部内容 */
export function drawQrToCanvas(canvas: HTMLCanvasElement, grid: QrGrid, opts: QrDrawOpts = {}): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return // jsdom 等无 2d 上下文环境早退（防御；Task 9 Dialog 单测会渲染到此处）
  const moduleSize = opts.moduleSize ?? 6
  const margin = (opts.marginModules ?? 4) * moduleSize
  const total = grid.size * moduleSize + margin * 2
  if (canvas.width !== total) canvas.width = total
  if (canvas.height !== total) canvas.height = total
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, total, total)
  ctx.fillStyle = '#000000'
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (grid.get(x, y)) ctx.fillRect(margin + x * moduleSize, margin + y * moduleSize, moduleSize, moduleSize)
    }
  }
}

export interface QrColsRow {
  maxCount: number
  cols: number
}

/** 多选二维码拼版列数规则（spec §2.5）：≤4→2 列、≤9→3 列、其余 4 列 */
export const COLS_TABLE: ReadonlyArray<QrColsRow> = [
  { maxCount: 4, cols: 2 },
  { maxCount: 9, cols: 3 },
  { maxCount: Number.POSITIVE_INFINITY, cols: 4 },
]

/** 按选中条数查拼版列数（Task 10 消费） */
export function colsForCount(count: number): number {
  for (const row of COLS_TABLE) {
    if (count <= row.maxCount) return row.cols
  }
  return 4
}
