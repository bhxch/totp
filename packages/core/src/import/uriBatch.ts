import { parseOtpUri } from '../otp/uri'
import type { ImportResult, ParsedEntry } from './types'

/**
 * otpauth URI 批量导入：按行 split、空行跳过；
 * 每行 parseOtpUri → ParsedEntry，失败行进 failures（index 为原始行号，空行占位）
 */
export function importUriBatch(text: string): ImportResult {
  const lines = text.split(/\r?\n/)
  const entries: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (!line) return
    try {
      entries.push(parseOtpUri(line))
    } catch (e) {
      failures.push({ index, message: e instanceof Error ? e.message : String(e) })
    }
  })
  return { entries, failures }
}
