import { base32Encode } from '../encoding/base32'
import type { ImportResult, ParsedEntry } from './types'

/**
 * SteamGuard / SDA(SteamDesktopAuthenticator) 明文 JSON 粘贴导入（P2，对齐 WinAuth 粘贴通道）。
 * 格式事实依据 winauth/winauth 源码调研：SteamGuard JSON 必含 shared_secret(base64)+serial_number
 * （AddSteamAuthenticator.cs:497-511）；SDA maFile 含 device_id/shared_secret/account_name
 * （AddSteamAuthenticator.cs:534-580）。加密 maFile（base64(AES-256-CBC)）非明文 JSON，嗅探不命中，
 * 不在本通道（文件+口令范畴）。
 * secret 语义：shared_secret base64 解码后的字节 → RFC4648 标准 base32（默认字母表）——core steam
 * 条目统一按 RFC4648 解码路径还原字节（otp/uri.ts C2；STEAM_ALPHABET 26 字符码表仅限 steamCode
 * 取模输出，不是 base32 编码码表，误用作编码表索引 26..31 出码表会产生损坏 secret）。
 */
export function importSteamGuard(text: string): ImportResult {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(text.trim()) as Record<string, unknown>
  } catch {
    return { entries: [], failures: [{ index: 0, message: '不是合法的 SteamGuard/SDA JSON' }] }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.shared_secret !== 'string' || !obj.shared_secret) {
    return { entries: [], failures: [{ index: 0, message: '缺少 shared_secret 字段（SteamGuard/SDA JSON 必含）' }] }
  }
  let bytes: Uint8Array
  try {
    const bin = atob(obj.shared_secret)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch {
    return { entries: [], failures: [{ index: 0, message: 'shared_secret 不是合法 base64' }] }
  }
  // Steam shared_secret 固定 20 字节（160bit，对齐 WinAuth AddSteamAuthenticator.cs 的 SteamAuth 数据口径）；
  // 非 20 字节说明数据损坏/被截断，按失败引导而非生成损坏条目
  if (bytes.length !== 20) {
    return { entries: [], failures: [{ index: 0, message: 'shared_secret 解码后须为 20 字节（Steam 固定长度）' }] }
  }
  // R4-M1：官方宽松解析对 serial_number/device_id/steamid 的数字形态同样接受
  // （AddSteamAuthenticator.cs:497-511/541-563，getInt/getOptLong），数字归一为 string——
  // label 回退与 note 拼接不再漏掉数字型字段（sniff 层 registry.sniffSteamGuard 同口径放行）
  const asText = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v !== '') return v
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    return undefined
  }
  const label = asText(obj.account_name) ?? asText(obj.steamid) ?? 'Steam'
  const note = [asText(obj.serial_number), asText(obj.device_id), asText(obj.revocation_code)]
    .filter((v): v is string => v !== undefined)
    .join(' / ')
  const entry: ParsedEntry = {
    type: 'steam',
    issuer: 'Steam',
    label,
    secret: base32Encode(bytes),
    algorithm: 'SHA1',
    digits: 5,
    period: 30,
    ...(note ? { note } : {}),
  }
  return { entries: [entry], failures: [] }
}
