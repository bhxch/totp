import { Unzip, UnzipInflate } from 'fflate'
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
/** F15 成员数安全上限（与 opts.max 的「store 容量 trim」语义无关）：超出整体拒绝 */
const MAX_MEMBERS = 500

// F15 解压预算（针对不可信 zip 的资源耗尽防线）：
// - 输入字节上限：压缩炸弹在入口即被拒（不进入解压）
// - 真实产出总量预算：头声明（originalSize）可被攻击者伪造（声明小、实解大），预算只认 inflate 真实产出
// - 推送切片 16KB：fflate 按成员整体交付产出，调用方 push 粒度即单次 ondata 交付粒度——
//   16KB × deflate 极限压缩比 ≈1032:1 ⇒ 单次交付上界约 16.1MiB，预算检查永远在该粒度内触发
// 行为变化（相对 unzipSync 版本）：输入超限与成员数超限为整体拒绝；data-descriptor 流式 zip
// （Java ZipOutputStream/Go streaming 等工具产物，本地头无 sizes）与普通 zip 走同一有界路径，正常导入；
// CRC 不再校验（图标损坏仅渲染失败，无内存安全问题）。
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
 * F15 有界解压：流式 Unzip + 16KB 切片推送 + 真实产出总量预算（8MiB）+ 输入 10MB 上限 +
 * 成员数硬上限（500，超出整体拒绝）——谎言头（声明尺寸与实际不符）由真实产出拦截，
 * data-descriptor 流式 zip 与普通 zip 走同一有界路径。
 *
 * I60：成员解压完毕后按文件名字典序排序处理——同名（normalize 后）后者覆盖前者的「后者」按字典序定义，
 *     保证不同平台/不同压缩顺序下「谁覆盖谁」完全确定。
 * I63：处理所有 png 条目（即使超过 max 也累计 imported/overwritten/skipped 计数），最后才 trim pending 到 max 上限。
 *     skipped 与 skippedLarge 细分：让 UI 可分别提示「文件过大」与「超出数量上限」。
 */
/** 图标包 zip 输入字节上限（解压前拒绝） */
export const MAX_ICON_PACK_ZIP_BYTES = 10 * 1024 * 1024
/** 解压真实产出总量预算（谎言头由真实产出拦截，与声明值无关） */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 8 * 1024 * 1024
/** 流式 push 切片：单次 ondata 交付上界 = 切片 × deflate 极限压缩比（≈16.1MiB） */
const PUSH_SLICE = 16 * 1024

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** EOCD 预检（与 fflate unzipSync 的 'invalid zip data' 拒绝语义对齐）：尾部窗口扫描 EOCD 签名 */
function hasEocd(b: Uint8Array): boolean {
  if (b.length < 22) return false
  const min = Math.max(0, b.length - 22 - 65535)
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return true
  }
  return false
}

export async function importIconPackZip(
  zipBytes: Uint8Array,
  icons: Pick<IconStore, 'putMany'>,
  opts?: { max?: number; maxBytes?: number },
): Promise<IconPackResult> {
  const max = opts?.max ?? DEFAULT_MAX
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  if (zipBytes.length > MAX_ICON_PACK_ZIP_BYTES) {
    throw new Error(`图标包超过 ${Math.floor(MAX_ICON_PACK_ZIP_BYTES / 1024 / 1024)}MB 大小上限`)
  }
  if (!hasEocd(zipBytes)) throw new Error('invalid zip data')
  // F15：流式解压 + 真实产出预算。成员按序收进 members（总量受 MAX_TOTAL_UNCOMPRESSED_BYTES 约束），
  // 其后沿用既有排序/计数/trim 语义（I60/I63 不变）
  const files = new Map<string, Uint8Array>()
  let memberCount = 0
  let totalOut = 0
  let skippedLargeNow = 0
  await new Promise<void>((resolve, reject) => {
    const unzip = new Unzip((file) => {
      memberCount++
      if (memberCount > MAX_MEMBERS) {
        reject(new Error(`图标包含超过 ${MAX_MEMBERS} 个条目`))
        return
      }
      if (!file.name.toLowerCase().endsWith('.png')) return // 非 png：不 start() 即零解压成本
      let memberOut = 0
      const chunks: Uint8Array[] = []
      file.ondata = (err, chunk, final) => {
        if (err) {
          reject(err)
          return
        }
        if (chunk) {
          memberOut += chunk.length
          totalOut += chunk.length
          if (totalOut > MAX_TOTAL_UNCOMPRESSED_BYTES) {
            reject(new Error('图标包解压后超过总量上限'))
            return
          }
          if (memberOut <= maxBytes) chunks.push(chunk) // 超过单文件上限后停止留存（预算继续累计以拦截炸弹）
        }
        if (final) {
          if (memberOut > maxBytes) {
            skippedLargeNow++
          } else {
            files.set(file.name, concatChunks(chunks))
          }
        }
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    try {
      for (let i = 0; i < zipBytes.length; i += PUSH_SLICE) {
        unzip.push(zipBytes.subarray(i, i + PUSH_SLICE), i + PUSH_SLICE >= zipBytes.length)
      }
      resolve()
    } catch (e) {
      reject(e)
    }
  })
  // 超大成员与基座语义一致：skipped 与 skippedLarge 各计 1
  let skipped = skippedLargeNow
  let skippedLarge = skippedLargeNow
  let imported = 0
  let overwritten = 0
  const pending: Record<string, string> = {}
  const seen = new Set<string>()
  // I60：字典序排序保证「后者覆盖前者」的可重现性（不依赖压缩归档的成员枚举顺序）
  const sortedPaths = [...files.keys()].sort((a, b) => a.localeCompare(b))
  for (const path of sortedPaths) {
    if (!path.toLowerCase().endsWith('.png')) continue
    const bytes = files.get(path)!
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
