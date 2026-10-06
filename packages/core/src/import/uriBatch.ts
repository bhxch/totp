import { normalizeExtOtpauth, parseOtpUri } from '../otp/uri'
import { asObject } from './normalize'
import type { ImportResult, ParsedEntry } from './types'

/**
 * otpauth URI 批量导入：按行 split、空行与 # 注释行（WinAuth 无口令导出）跳过；
 * 每行先 normalizeExtOtpauth（接受 Firefox 协议处理器 ext+otpauth:// 前缀）→ parseOtpUri → ParsedEntry；
 * 失败行进 failures（index 为原始行号，空行占位）。
 * Ente Auth 明文导出即 otpauth URI 行（Aegis EnteAuthImporter.java 委托 GoogleAuthUriImporter），
 * 由本入口覆盖；Ente 加密导出（{version, kdfParams, encryptedData, encryptionNonce}，Argon2id+
 * XChaCha20-Poly1305，WebCrypto 无法解密）有可靠特征键 → 结构级报错提示改用明文导出，
 * 避免用户手动选择本格式时收到逐行「invalid otpauth uri」误导（原 importEnte 检测逻辑迁入）。
 */
export function importUriBatch(text: string): ImportResult {
  // Ente 加密导出检测：完整 JSON 且同时含 encryptedData+kdfParams → 结构级报错；
  // 截断 JSON（解析失败）但含特征字段字面量 → 同口径报错；其余文本照常逐行解析
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      if (/\bkdfParams\b|\bencryptedData\b/.test(trimmed)) throwEnteEncrypted()
    }
    const obj = parsed !== undefined ? asObject(parsed) : null
    if (obj && 'encryptedData' in obj && 'kdfParams' in obj) throwEnteEncrypted()
  }

  const lines = text.split(/\r?\n/)
  const entries: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  lines.forEach((rawLine, index) => {
    let line = rawLine.trim()
    // WinAuth 无口令导出 txt：# 注释行跳过（WinAuthHelper.cs:577-582）
    if (!line || line.startsWith('#')) return
    // WinAuth 导出在 label 含 # 时不做 URL 编码，? 前的 # 会被 new URL() 当 fragment 截断
    // ——还原为 %23（对齐 WinAuth 导入侧 WinAuthHelper.cs:584-590 的互逆处理）
    const q = line.indexOf('?')
    if (q > 0) line = line.slice(0, q).replaceAll('#', '%23') + line.slice(q)
    try {
      entries.push(parseOtpUri(normalizeExtOtpauth(line)))
    } catch (e) {
      failures.push({ index, message: e instanceof Error ? e.message : String(e) })
    }
  })
  return { entries, failures }
}

function throwEnteEncrypted(): never {
  throw new Error('Ente 加密导出不支持：请在 Ente Auth 中使用明文导出（otpauth URI 行文本）')
}
