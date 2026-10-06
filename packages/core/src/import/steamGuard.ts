import { base32Encode, STEAM_ALPHABET } from '../encoding/base32'
import type { ImportResult, ParsedEntry } from './types'

/**
 * SteamGuard / SDA(SteamDesktopAuthenticator) 明文 JSON 粘贴导入（P2，对齐 WinAuth 粘贴通道）。
 * 格式事实依据 winauth/winauth 源码调研：SteamGuard JSON 必含 shared_secret(base64)+serial_number
 * （AddSteamAuthenticator.cs:497-511）；SDA maFile 含 device_id/shared_secret/account_name
 * （AddSteamAuthenticator.cs:534-580）。加密 maFile（base64(AES-256-CBC)）非明文 JSON，嗅探不命中，
 * 不在本通道（文件+口令范畴）。
 * secret 语义：shared_secret base64 解码后的字节 → STEAM_ALPHABET base32（core steam 条目统一语义）。
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
  const label =
    typeof obj.account_name === 'string' && obj.account_name
      ? obj.account_name
      : typeof obj.steamid === 'string' && obj.steamid
        ? obj.steamid
        : 'Steam'
  const note = [obj.serial_number, obj.device_id, obj.revocation_code]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' / ')
  const entry: ParsedEntry = {
    type: 'steam',
    issuer: 'Steam',
    label,
    secret: base32Encode(bytes, STEAM_ALPHABET),
    algorithm: 'SHA1',
    digits: 5,
    period: 30,
    ...(note ? { note } : {}),
  }
  return { entries: [entry], failures: [] }
}
