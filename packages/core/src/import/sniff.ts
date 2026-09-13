import type { ImportFormat } from './types'

// 统一入口：re-export 同目录实现，供外部从 sniff 单点导入
export * from './types'
export * from './generic'
export * from './uriBatch'

/**
 * 格式嗅探，判定顺序：aegis → winauth → generic(JSON array/JSONL) → uriBatch → null
 * - JSON.parse 成功且含 db / header 键 → 'aegis'
 * - 文本含 winauth（大小写不敏感，XML 用正则判定，M1 不引入 XML 解析器）→ 'winauth'
 * - JSON.parse 成功且为数组，或逐行均可解析的 JSONL → 'generic'
 * - 含 otpauth:// → 'uriBatch'
 */
export function sniffFormat(text: string): ImportFormat | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 1. aegis（完整 JSON 对象，含 db 或 header 键）
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>
        if ('db' in obj || 'header' in obj) return 'aegis'
        // 单个 JSON 对象（非 aegis）→ 通用格式
        return 'generic'
      }
    } catch {
      // 非完整 JSON，继续后续判定（可能是 JSONL）
    }
  }

  // 2. winauth（XML，正则判定）
  if (trimmed.startsWith('<') && /winauth/i.test(trimmed)) return 'winauth'

  // 3. generic：JSON 数组
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return 'generic'
    } catch {
      // 继续按行判定
    }
  }

  // 3. generic：JSONL（每行均可解析；多行，或单行且为对象）
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length > 0) {
    let allParsed = true
    for (const line of lines) {
      try {
        JSON.parse(line)
      } catch {
        allParsed = false
        break
      }
    }
    if (allParsed && lines.length > 1) return 'generic'
  }

  // 4. uriBatch
  if (trimmed.includes('otpauth://')) return 'uriBatch'

  return null
}
