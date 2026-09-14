import { unzipSync } from 'fflate'
import { normalizeIssuer } from '@totp/core'
import type { IconStore } from './iconStore'

export interface IconPackResult {
  /** 新增条目数（首次出现的 normalize id） */
  imported: number
  /** 覆盖既有条目的次数（同 normalize id 重复出现，后者覆盖前者） */
  overwritten: number
  /** 跳过的条目数：非 png / 超 maxBytes / 超出 max 限制 */
  skipped: number
  /** [可选] skippedLarge：跳过中属于「单文件超 maxBytes」的数量，便于 UI 单独提示 */
  skippedLarge: number
  /** normalize 后的 stored id 列表（仅首次出现的 id） */
  names: string[]
}

const DEFAULT_MAX = 500
const DEFAULT_MAX_BYTES = 50 * 1024

function bytesToDataUrl(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:image/png;base64,${btoa(bin)}`
}

/**
 * aegis-icons 风格 zip 导入：任意层级下 *.png（大小写不敏感），
 * 文件名（去扩展名）normalizeIssuer 后作 stored id——控制器裁定：不自动映射 builtin，
 * 用户包可管理可删除。
 *
 * I60：unzipSync 后按文件名字典序排序处理——同名（normalize 后）后者覆盖前者的「后者」按字典序定义，
 *     保证不同平台/不同压缩顺序下「谁覆盖谁」完全确定。
 * I63：处理所有 png 条目（即使超过 max 也累计 imported/overwritten/skipped 计数），最后才 trim pending 到 max 上限。
 *     skipped 与 skippedLarge 细分：让 UI 可分别提示「文件过大」与「超出数量上限」。
 */
export async function importIconPackZip(
  zipBytes: Uint8Array,
  icons: Pick<IconStore, 'putMany'>,
  opts?: { max?: number; maxBytes?: number },
): Promise<IconPackResult> {
  const max = opts?.max ?? DEFAULT_MAX
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const files = unzipSync(zipBytes)
  let imported = 0
  let overwritten = 0
  let skipped = 0
  let skippedLarge = 0
  const pending: Record<string, string> = {}
  const seen = new Set<string>()
  // I60：字典序排序保证「后者覆盖前者」的可重现性（不依赖 unzipSync 的对象枚举顺序）
  const sortedPaths = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([p]) => p)
  for (const path of sortedPaths) {
    if (!path.toLowerCase().endsWith('.png')) continue
    const bytes = files[path]!
    if (bytes.length > maxBytes) {
      skipped++
      skippedLarge++
      continue
    }
    const base = path.slice(path.lastIndexOf('/') + 1, -4)
    const id = normalizeIssuer(base)
    const dataUrl = bytesToDataUrl(bytes)
    if (seen.has(id)) {
      // I63：覆盖计 1，overwritten 而非 skipped
      overwritten++
      pending[id] = dataUrl
    } else {
      imported++
      seen.add(id)
      pending[id] = dataUrl
    }
  }
  // I63：处理完所有条目后再 trim pending 到 max 上限；超出部分计入 skipped
  // 规则：seen 中保留前 max 个 id 作为「导入」；其余唯一 id 与 overwrite 都计入 skipped
  // pending 的最终值就是处理完所有条目后的最新值（已包含 overwrite），无需额外合并
  if (seen.size > max) {
    const keep = new Set<string>()
    let kept = 0
    for (const id of seen) {
      if (kept < max) { keep.add(id); kept++ } else { skipped++ }
    }
    // pending 中非 keep 的条目移除（不写入 store）
    for (const id of Object.keys(pending)) {
      if (!keep.has(id)) delete pending[id]
    }
  }
  if (Object.keys(pending).length > 0) await icons.putMany(pending) // 一次落盘，避免逐条 put 的 O(n²) 写放大
  return { imported, overwritten, skipped, skippedLarge, names: [...seen] }
}

/**
 * 用户上传缩放：canvas 缩放至长边 ≤size（不放大）保持比例，PNG 输出。
 * jsdom 等无 canvas 环境下 getContext 为 null，抛 Error('canvas 不可用')——
 * 真实缩放路径在浏览器手工验收。
 */
export async function fileToScaledDataUrl(file: Blob, size = 128): Promise<string> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('图片加载失败'))
      image.src = url
    })
    const scale = Math.min(1, size / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    canvas.width = w
    canvas.height = h
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}
