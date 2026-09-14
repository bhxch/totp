import { base64ToBytes, bytesToBase64 } from '../crypto/aesgcm'

export interface SyncChunk {
  rev: number
  updatedAt: number
  part: number
  total: number
  /** 该片 UTF-8 字节的 base64 */
  data: string
}

export interface SyncMeta {
  rev: number
  updatedAt: number
  total: number
}

/**
 * 默认每片原始数据字节数。约束：单片存储值 = base64(data)（×4/3 ≈ 7336 字符）
 * + JSON 包装（约 70 字符）≈ 7.4KB，须低于 chrome.storage.sync.QUOTA_BYTES_PER_ITEM（8192）并留余量。
 */
export const DEFAULT_MAX_DATA_BYTES = 5500

/** 标准 base64 字母表，padding 仅允许末尾至多 2 个 '='（拒绝空白与任意非法字符） */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

function isStandardBase64(s: string): boolean {
  return BASE64_RE.test(s) && s.length % 4 === 0
}

export function chunkKey(part: number, total: number): string {
  return `sync:v1:${part}/${total}`
}

/**
 * 将 payload 按 UTF-8 字节切分为若干片，每片独立 base64。
 * 空 payload → 单个 data='' 片（total=1）。
 */
export function splitIntoChunks(payload: string, rev: number, updatedAt: number, maxDataBytes: number = DEFAULT_MAX_DATA_BYTES): SyncChunk[] {
  if (!Number.isInteger(maxDataBytes) || maxDataBytes < 1) throw new Error('maxDataBytes must be a positive integer')
  const bytes = new TextEncoder().encode(payload)
  if (bytes.length === 0) return [{ rev, updatedAt, part: 0, total: 1, data: '' }]
  const total = Math.ceil(bytes.length / maxDataBytes)
  const chunks: SyncChunk[] = []
  for (let part = 0; part < total; part++) {
    const slice = bytes.slice(part * maxDataBytes, (part + 1) * maxDataBytes)
    chunks.push({ rev, updatedAt, part, total, data: bytesToBase64(slice) })
  }
  return chunks
}

/**
 * 校验 part 覆盖 0..total-1、rev/updatedAt/total 全等、data 全为合法标准 base64，
 * 按 part 序解码各片 base64 拼接字节后解码 UTF-8；任何不一致/缺失/可疑 → null。
 */
export function mergeChunks(chunks: SyncChunk[]): string | null {
  if (!Array.isArray(chunks) || chunks.length === 0) return null
  const first = chunks[0]
  if (!first) return null
  const { rev, updatedAt, total } = first
  if (!Number.isInteger(total) || total < 1) return null
  const byPart = new Map<number, string>()
  for (const c of chunks) {
    if (typeof c.data !== 'string') return null
    // 前置校验：data 含空白时 atob(forgiving-base64) 会静默剥离产生截断 payload，故拒绝之
    if (!isStandardBase64(c.data)) return null
    if (c.rev !== rev || c.updatedAt !== updatedAt || c.total !== total) return null
    if (!Number.isInteger(c.part) || c.part < 0 || c.part >= total) return null
    if (byPart.has(c.part)) return null
    byPart.set(c.part, c.data)
  }
  if (byPart.size !== total) return null
  // 每片 base64 独立含 padding，须逐片解码后拼字节，不可拼 base64 字符串
  try {
    let byteLength = 0
    const parts: Uint8Array[] = []
    for (let part = 0; part < total; part++) {
      const data = byPart.get(part)
      if (data === undefined) return null
      const bytes = base64ToBytes(data)
      parts.push(bytes)
      byteLength += bytes.length
    }
    const combined = new Uint8Array(byteLength)
    let offset = 0
    for (const bytes of parts) {
      combined.set(bytes, offset)
      offset += bytes.length
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(combined)
  } catch {
    return null
  }
}

export function chunksToMeta(chunks: SyncChunk[]): SyncMeta {
  const first = chunks[0]
  if (!first) throw new Error('chunks must not be empty')
  return { rev: first.rev, updatedAt: first.updatedAt, total: first.total }
}

/**
 * 返回 fresh 全量写入后应删除的多余旧键。
 * 键名含 total，fresh 覆盖的同名键会被覆写、无需删除；其余旧键全部返回。
 */
export function staleChunkKeys(existing: SyncChunk[], fresh: SyncChunk[]): string[] {
  const freshKeys = new Set(fresh.map((c) => chunkKey(c.part, c.total)))
  const stale = new Set<string>()
  for (const c of existing) {
    const key = chunkKey(c.part, c.total)
    if (!freshKeys.has(key)) stale.add(key)
  }
  return [...stale]
}
