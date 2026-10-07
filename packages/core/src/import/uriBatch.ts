import { normalizeExtOtpauth, parseOtpUri } from '../otp/uri'
import { asObject } from './normalize'
import { importSteamGuard } from './steamGuard'
import type { ImportResult, ParsedEntry } from './types'

/**
 * otpauth URI 批量导入：按行 split、空行与 # 注释行（WinAuth 无口令导出）跳过；
 * 每行先 normalizeExtOtpauth（接受 Firefox 协议处理器 ext+otpauth:// 前缀）→ parseOtpUri → ParsedEntry；
 * 失败行进 failures（index 为原始行号，空行占位）。
 * R4-I1：WinAuth ToUrl 对 Steam 条目输出 totp scheme + `deviceid`+`data` 双特征 query
 * （WinAuthAuthenticator.cs:728-729，data 为 UrlEncode(SteamGuard JSON)）——识别后走
 * importSteamGuard 重建 steam 条目，避免被当普通 TOTP 静默导入（验证码必错）；data 缺失/
 * 损坏归入 failures 行级错误（ImportResult 无 suspect 通道，该判定属 dedup 层），绝不产出
 * 错误 TOTP 条目。issuer 为 Steam 但无该特征的行维持现状（普通 totp 解析）。
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
    const normalized = normalizeExtOtpauth(line)
    const steam = asWinAuthSteamRow(normalized)
    if (steam) {
      if ('entry' in steam) entries.push(steam.entry)
      else failures.push({ index, message: steam.message })
      return
    }
    try {
      entries.push(parseOtpUri(normalized))
    } catch (e) {
      failures.push({ index, message: e instanceof Error ? e.message : String(e) })
    }
  })
  return { entries, failures }
}

/**
 * R4-I1：WinAuth Steam 行识别与重建。返回 null = 非 WinAuth Steam 行（继续普通解析）。
 * 特征 = query 同时含 `deviceid` 与 `data`（WinAuth 仅 Steam 条目写这两个参数；
 * data 缺失即特征不成立，issuer 为 Steam 的普通 totp 行不受影响）。
 */
function asWinAuthSteamRow(uri: string): { entry: ParsedEntry } | { message: string } | null {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  const data = url.searchParams.get('data')
  if (url.searchParams.get('deviceid') === null || data === null) return null
  // data=UrlEncode(SteamGuard JSON)：WinAuth SteamData 即 Steam ITwoFactorService
  // AddAuthenticator response + steamid（含 shared_secret/serial_number/steamid），
  // 与 importSteamGuard 的字段口径一致（shared_secret base64 20 字节）
  const parsed = importSteamGuard(data)
  if (parsed.entries.length === 1) {
    const entry = parsed.entries[0]!
    // label 优先级：data JSON 显式 account_name > URI path 账户段 > importSteamGuard 兜底
    // （steamid/'Steam'）——WinAuth SteamData 不含 account_name，URI 的账户段才是用户可读名
    const label = uriLabelOf(url)
    if (label && !hasAccountName(data)) entry.label = label
    return { entry }
  }
  return { message: parsed.failures[0]?.message ?? 'Steam data 参数解析失败' }
}

/** data JSON 是否带显式非空 account_name（决定 URI 账户段是否覆盖 importSteamGuard 的 label 兜底） */
function hasAccountName(data: string): boolean {
  try {
    const o: unknown = JSON.parse(data)
    return (
      typeof o === 'object' && o !== null &&
      typeof (o as Record<string, unknown>).account_name === 'string' &&
      (o as Record<string, unknown>).account_name !== ''
    )
  } catch {
    return false // 能走到此处 data 已过 importSteamGuard 校验；防御性按无 account_name
  }
}

/** URI path 账户段（口径对齐 parseOtpUri：decodeURIComponent 后按首个 ':' 取后段） */
function uriLabelOf(url: URL): string {
  let raw: string
  try {
    raw = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    return ''
  }
  const colon = raw.indexOf(':')
  const label = (colon >= 0 ? raw.slice(colon + 1) : raw).trim()
  return label && label.toLowerCase() !== 'steam' ? label : ''
}

function throwEnteEncrypted(): never {
  throw new Error('Ente 加密导出不支持：请在 Ente Auth 中使用明文导出（otpauth URI 行文本）')
}
