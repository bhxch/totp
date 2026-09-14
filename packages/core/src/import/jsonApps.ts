import { base32Decode } from '../encoding/base32'
import { parseOtpUri } from '../otp/uri'
import type { ImportResult, ParsedEntry } from './types'

// JSON 类 App 导出格式导入（2FAS / Bitwarden / Ente / Proton / Stratum）。
// 每个格式的字段口径以 Aegis 官方 Importer 源码为准（beemdevelopment/Aegis master）：
// - importers/TwoFasImporter.java
// - importers/BitwardenImporter.java
// - importers/EnteAuthImporter.java（委托 importers/GoogleAuthUriImporter.java）
// - importers/ProtonAuthenticatorImporter.java
// - importers/StratumImporter.java
// 错误契约与 aegis.ts 一致：结构级错误（缺顶层数组等）throw；单条损坏进 failures 不阻断。

// ---------- 共享辅助（与 generic.ts/aegis.ts 口径一致） ----------

function normalizeSecret(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, '')
    .toUpperCase()
}

function normalizeAlgorithm(raw: unknown): ParsedEntry['algorithm'] {
  const s = String(raw ?? '').toUpperCase()
  return s === 'SHA256' || s === 'SHA512' ? s : 'SHA1'
}

function toPositiveNumber(raw: unknown, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function toNonNegativeNumber(raw: unknown, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

function parseJson(text: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${label} 文件结构非法：不是合法 JSON`)
  }
  const obj = asObject(parsed)
  if (!obj) throw new Error(`${label} 文件结构非法：顶层不是 JSON 对象`)
  return obj
}

function isBase32(raw: string): boolean {
  try {
    return base32Decode(raw).length > 0
  } catch {
    return false
  }
}

function collectEntries(rows: unknown[], parse: (row: unknown, index: number) => ParsedEntry | { error: string }): ImportResult {
  const entries: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  rows.forEach((row, index) => {
    const res = parse(row, index)
    if ('error' in res) failures.push({ index, message: res.error })
    else entries.push(res)
  })
  return { entries, failures }
}

/** steam://<base32 secret>（非特殊 scheme，URL 解析 host 不可靠，手动截取 authority） */
function steamAuthority(uri: string): string {
  return uri.slice('steam://'.length).split('/')[0] ?? ''
}

function steamEntry(secret: string, issuer: string, label: string): ParsedEntry {
  return {
    type: 'steam',
    issuer,
    label,
    secret: normalizeSecret(secret),
    algorithm: 'SHA1',
    digits: 5, // SteamInfo.DIGITS = 5
    period: 30, // TotpInfo.DEFAULT_PERIOD
  }
}

// ---------- 2FAS（importers/TwoFasImporter.java） ----------
// 源码口径：顶层 { schemaVersion, services: [...], servicesEncrypted? }（>4 抛 Unsupported schema version）。
// 每条 service：secret 为顶层字符串；issuer/account/digits/period/algorithm/tokenType/counter 在 otp 子对象。
// issuer = service.name 非空优先，否则 otp.issuer（convertEntry：optString("name") → otp.optString("issuer")）；
// label = otp.account；tokenType 缺省/'TOTP' → TotpInfo（period 默认 30），'HOTP' → HotpInfo（counter 默认 0），
// 'STEAM' → SteamInfo，其他 tokenType 抛 DatabaseImporterEntryException（单条失败）。
// 简报猜测的平铺 schema（services[].account/issuer/...）与源码不符，以源码为准；无 otpAudience 字段。
// 加密导出（servicesEncrypted = Base64(data):Base64(salt):Base64(iv)，PBKDF2+AES-GCM 口令解密）不支持 → 结构级报错。

/** 2FAS 明文导出导入；加密导出（servicesEncrypted）与 schemaVersion>4 抛结构级错误 */
export function importTwoFas(text: string): ImportResult {
  const obj = parseJson(text, '2FAS')

  const version = Number(obj.schemaVersion)
  if (Number.isFinite(version) && version > 4) {
    throw new Error(`2FAS 文件结构非法：不支持的 schemaVersion ${version}（Aegis 口径仅支持 ≤4）`)
  }
  if (typeof obj.servicesEncrypted === 'string' && obj.servicesEncrypted !== '') {
    throw new Error('2FAS 加密导出不支持：请使用不加密导出（无 servicesEncrypted 字段）')
  }
  if (!Array.isArray(obj.services)) throw new Error('2FAS 文件结构非法：缺少 services 数组')

  return collectEntries(obj.services, (raw, index) => {
    const service = asObject(raw)
    if (!service) return { error: `条目 ${index} 非对象` }
    const otp = asObject(service.otp)
    if (!otp) return { error: `条目 ${index} 缺少 otp 对象` }
    if (typeof service.secret !== 'string' || service.secret.trim() === '') {
      return { error: `条目 ${index} 缺少 secret` }
    }

    // issuer：name 非空优先，否则 otp.issuer（convertEntry 口径）
    const issuer =
      (typeof service.name === 'string' && service.name !== '' ? service.name : undefined) ??
      (typeof otp.issuer === 'string' ? otp.issuer : '')
    const label = typeof otp.account === 'string' ? otp.account : ''
    const algorithm = normalizeAlgorithm(otp.algorithm)

    const tokenType = typeof otp.tokenType === 'string' ? otp.tokenType : null
    if (tokenType === null || tokenType === 'TOTP') {
      return {
        type: 'totp',
        issuer,
        label,
        secret: normalizeSecret(service.secret),
        algorithm,
        digits: toPositiveNumber(otp.digits, 6),
        period: toPositiveNumber(otp.period, 30),
      }
    }
    if (tokenType === 'HOTP') {
      return {
        type: 'hotp',
        issuer,
        label,
        secret: normalizeSecret(service.secret),
        algorithm,
        digits: toPositiveNumber(otp.digits, 6),
        counter: toNonNegativeNumber(otp.counter, 0),
        period: 30,
      }
    }
    if (tokenType === 'STEAM') {
      return steamEntry(service.secret, issuer, label)
    }
    return { error: `条目 ${index} 未知 tokenType: ${tokenType}` }
  })
}

// ---------- Bitwarden（importers/BitwardenImporter.java） ----------
// 源码口径：顶层 { items: [...] }；每条 login.totp 字符串：
// - otpauth:// → GoogleAuthInfo.parseUri
// - steam://（scheme === 'steam'）→ authority 为 Base32 secret，issuer/label 固定 'Steam'/'Steam account'
// - 空串跳过；login.totp 缺键时 Aegis 整体抛错，本实现按单条失败处理（贴合本仓库错误契约）
// 本工具扩展（简报要求）：totp 为裸 base32 secret（解码成功即接受）→ 默认 totp/6/30/SHA1，
// name→issuer、login.username→label、notes→note；加密导出（encrypted:true）无明文 totp → 逐条失败。

/** Bitwarden JSON 导出导入；totp 支持 otpauth URI / steam:// / 裸 base32 secret */
export function importBitwarden(text: string): ImportResult {
  const obj = parseJson(text, 'Bitwarden')
  if (!Array.isArray(obj.items)) throw new Error('Bitwarden 文件结构非法：缺少 items 数组')

  return collectEntries(obj.items, (raw, index) => {
    const item = asObject(raw)
    if (!item) return { error: `条目 ${index} 非对象` }
    const login = asObject(item.login)
    const totp = login && typeof login.totp === 'string' ? login.totp.trim() : ''
    if (totp === '') return { error: `条目 ${index} 缺少 login.totp` }

    const issuer = typeof item.name === 'string' ? item.name : ''
    const label = login && typeof login.username === 'string' ? login.username : ''
    const note = typeof item.notes === 'string' && item.notes !== '' ? item.notes : undefined

    if (totp.startsWith('steam://')) {
      const secret = steamAuthority(totp)
      if (!isBase32(secret)) return { error: `条目 ${index} steam secret 非法` }
      return { ...steamEntry(secret, 'Steam', 'Steam account'), note }
    }
    if (totp.startsWith('otpauth://')) {
      try {
        return { ...parseOtpUri(totp), issuer, label, note }
      } catch {
        return { error: `条目 ${index} totp 非法 otpauth URI` }
      }
    }
    // 裸 base32 secret（解码成功即接受；Aegis 不支持此形态，为本工具扩展）
    if (isBase32(totp)) {
      return {
        type: 'totp',
        issuer,
        label,
        secret: normalizeSecret(totp),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        note,
      }
    }
    return { error: `条目 ${index} totp 非法（非 URI 且非 base32）` }
  })
}

// ---------- Ente Auth（importers/EnteAuthImporter.java → importers/GoogleAuthUriImporter.java） ----------
// 源码口径：Aegis 的 EnteAuthImporter 自引入起即把输入整体委托 GoogleAuthUriImporter——
// Ente 明文导出就是每行一条 otpauth:// URI 的纯文本（ente 仓库 export_widget.dart
// _getAuthDataForExport：code.rawData 按行拼接），并非 JSON。
// 简报猜测的 { enc: false, data: { assets: [...] } } JSON 结构在 Aegis 源码与 Ente 官方
// 源码/文档（docs/docs/auth/migration/export.md、models/export/ente.dart）中均不存在，不实现。
// Ente 加密导出（{version, kdfParams, encryptedData, encryptionNonce}，Argon2id+XChaCha20-Poly1305）
// WebCrypto 无法解密 → 结构级报错提示改用明文导出（URI 行由 uriBatch/sniff 覆盖）。

/** Ente Auth 明文导出导入：otpauth URI 每行一条，坏行进 failures */
export function importEnte(text: string): ImportResult {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const obj = asObject(JSON.parse(trimmed))
      if (obj && 'encryptedData' in obj && 'kdfParams' in obj) {
        throw new Error('Ente 加密导出不支持：请在 Ente Auth 中使用明文导出（otpauth URI 行文本）')
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Ente')) throw e
      // 非完整 JSON → 按行解析，坏行进 failures
    }
  }

  const entries: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  text.split(/\r?\n/).forEach((rawLine, index) => {
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

// ---------- Proton Authenticator（importers/ProtonAuthenticatorImporter.java） ----------
// 源码口径：顶层对象（非数组，简报猜测有误）；明文 { entries: [...] }，
// 每条 { content: { name?, uri } }：uri 为 otpauth://（issuer 取 URI issuer，label 取 content.name，
// VaultEntry(info, name, info.getIssuer())）或 steam://<base32>（issuer 固定 'Steam'，label 取 name）。
// 加密导出 { version:1, salt, content }（Argon2id+AES-GCM）不支持 → 结构级报错。

/** Proton Authenticator 明文导出导入；加密导出（salt+content）抛结构级错误 */
export function importProton(text: string): ImportResult {
  const obj = parseJson(text, 'Proton Authenticator')
  if (typeof obj.salt === 'string' && typeof obj.content === 'string') {
    throw new Error('Proton Authenticator 加密导出不支持：请使用明文导出')
  }
  if (!Array.isArray(obj.entries)) throw new Error('Proton Authenticator 文件结构非法：缺少 entries 数组')

  return collectEntries(obj.entries, (raw, index) => {
    const entry = asObject(raw)
    if (!entry) return { error: `条目 ${index} 非对象` }
    const content = asObject(entry.content)
    if (!content) return { error: `条目 ${index} 缺少 content 对象` }
    if (typeof content.uri !== 'string' || content.uri.trim() === '') {
      return { error: `条目 ${index} 缺少 content.uri` }
    }

    const name = typeof content.name === 'string' ? content.name : ''
    const uri = content.uri.trim()
    if (uri.startsWith('steam://')) {
      const secret = steamAuthority(uri)
      if (!isBase32(secret)) return { error: `条目 ${index} steam secret 非法` }
      return steamEntry(secret, 'Steam', name)
    }
    try {
      const info = parseOtpUri(uri)
      // convertEntry 口径：label 取 content.name（覆盖 URI 中的 label），issuer 取 URI 的 issuer
      return { ...info, label: name }
    } catch {
      return { error: `条目 ${index} uri 非法 otpauth URI` }
    }
  })
}

// ---------- Stratum / Authenticator Pro（importers/StratumImporter.java） ----------
// 源码口径：JSON 明文导出顶层 { "Authenticators": [...] }（简报猜测的 db/items/conf 为 Aegis 自身
// vault 结构，与 Stratum 无关）。每条大写键：
// - Type（int）：1=HOTP、2=TOTP、4=Steam（parseOtpInfo），其他 → 单条失败
// - Issuer（string 必需）、Username（nullable → ''）、Secret（Base32 字符串）、
//   Algorithm（int 序号 0=SHA1/1=SHA256/2=SHA512，越界 → 单条失败）
// - Digits/Period/Counter（int 必需；Counter 仅 HOTP 使用，但 Aegis 对所有条目均读取）
// 加密导出为二进制（'AUTHENTICATORPRO'/'AuthenticatorPro' 头），JSON.parse 必失败 → 结构级报错。

const STRATUM_ALGORITHMS: ParsedEntry['algorithm'][] = ['SHA1', 'SHA256', 'SHA512']

/** Stratum JSON 明文导出导入；二进制加密导出经 JSON.parse 失败 → 结构级报错 */
export function importStratum(text: string): ImportResult {
  const obj = parseJson(text, 'Stratum')
  if (!Array.isArray(obj.Authenticators)) {
    throw new Error('Stratum 文件结构非法：缺少 Authenticators 数组')
  }

  return collectEntries(obj.Authenticators, (raw, index) => {
    const entry = asObject(raw)
    if (!entry) return { error: `条目 ${index} 非对象` }

    const issuer = typeof entry.Issuer === 'string' ? entry.Issuer : null
    if (issuer === null) return { error: `条目 ${index} 缺少 Issuer` }
    const usernameRaw = entry.Username
    const label = usernameRaw === null || usernameRaw === undefined ? '' : String(usernameRaw)

    if (typeof entry.Secret !== 'string' || entry.Secret.trim() === '') {
      return { error: `条目 ${index} 缺少 Secret` }
    }
    const secret = normalizeSecret(entry.Secret)
    if (!isBase32(secret)) return { error: `条目 ${index} Secret 非法 base32` }

    const algoIndex = Number(entry.Algorithm)
    if (!Number.isInteger(algoIndex) || algoIndex < 0 || algoIndex >= STRATUM_ALGORITHMS.length) {
      return { error: `条目 ${index} 非法 Algorithm: ${entry.Algorithm}` }
    }
    const algorithm = STRATUM_ALGORITHMS[algoIndex]!

    const type = Number(entry.Type)
    if (!Number.isInteger(type)) return { error: `条目 ${index} 缺少 Type` }
    if (type === 1) {
      return {
        type: 'hotp',
        issuer,
        label,
        secret,
        algorithm,
        digits: toPositiveNumber(entry.Digits, 6),
        period: 30,
        counter: toNonNegativeNumber(entry.Counter, 0),
      }
    }
    if (type === 2) {
      return {
        type: 'totp',
        issuer,
        label,
        secret,
        algorithm,
        digits: toPositiveNumber(entry.Digits, 6),
        period: toPositiveNumber(entry.Period, 30),
      }
    }
    if (type === 4) {
      return steamEntry(secret, issuer, label)
    }
    return { error: `条目 ${index} 不支持的 Type: ${entry.Type}` }
  })
}
