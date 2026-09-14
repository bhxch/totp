import { base32Decode, base32Encode } from '../encoding/base32'
import { base64ToBytes } from '../crypto/aesgcm'
import type { ImportResult, ParsedEntry } from './types'
import { XML_STRING_RE, hexToBytes, xmlUnescape } from './miscApps'

// SQLite 类 App 导入（计划 8 Task 3）。字段口径以 Aegis 官方 Importer 源码为准
// （beemdevelopment/Aegis master，源文件已核对并留存于报告）：
// - importers/MicrosoftAuthImporter.java：真 SQLite（SqlImporterHelper SELECT * FROM accounts）
// - importers/AuthyImporter.java：shared_prefs XML 内 JSON 令牌数组（非 SQLite，简报猜测与源码不符）
// - importers/DuoImporter.java：files/duokit/accounts.json JSON 数组（非 SQLite，与源码不符）
// - importers/BattleNetImporter.java：SharedPreferences XML + XOR 掩码（非 SQLite，与源码不符）
// - importers/AuthenticatorPlusImporter.java：口令加密 ZIP（内含 Accounts.txt = otpauth URI 行），
//   非 SQLCipher；明文导出即 URI 文本，由 uriBatch 覆盖，按裁定不实现 authPlusRowsToEntries
// 错误契约与 jsonApps.ts 一致：结构级错误 throw；单条损坏进 failures 不阻断。

// ---------- 共享辅助（与 jsonApps.ts/miscApps.ts 口径一致） ----------

function asObject(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

/** Java org.json optString：null/缺失 → ''，其余 toString */
function optString(raw: unknown): string {
  return raw === null || raw === undefined ? '' : String(raw)
}

/** Aegis JsonUtils.optString：缺失/JSON null → null（Authy sanitize 依赖 null 判定） */
function jsonOptString(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null
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

// ---------- Microsoft Authenticator（MicrosoftAuthImporter.java：SQLite accounts 表） ----------
// 源码口径：SqlImporterHelper.read(SELECT * FROM accounts) → Entry(account_type/oath_secret_key/name/username)。
// type 0(TOTP)：secret = GoogleAuthInfo.parseSecret（trim + 去 '-'/' ' 后 Base32），digits 6；
// type 1(Microsoft)：secret = Base64.decode，digits 8；其他 type 在 convert() 静默跳过（不记 error）。
// 均为 TotpInfo(secret, SHA1, digits, 30)。简报猜测的 tokens 表与 misc 密码 PBKDF2 均与源码不符
// （源码无任何解密逻辑），故 msAuthRowsToEntries 无 password 参数。

export function msAuthRowsToEntries(rows: Array<Record<string, unknown>>): ImportResult {
  const entries: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  rows.forEach((row, index) => {
    const type = Number(row.account_type)
    if (row.account_type === null || row.account_type === undefined || !Number.isInteger(type)) {
      failures.push({ index, message: '缺少 account_type' })
      return
    }
    // 对齐 Aegis State.convert：TYPE_TOTP(0)/TYPE_MICROSOFT(1) 之外的 type 静默跳过
    if (type !== 0 && type !== 1) return
    if (typeof row.oath_secret_key !== 'string') {
      failures.push({ index, message: '缺少 secret（oath_secret_key）' })
      return
    }
    let bytes: Uint8Array
    try {
      if (type === 0) {
        // GoogleAuthInfo.parseSecret：s.trim().replace("-", "").replace(" ", "") → Base32.decode
        bytes = base32Decode(row.oath_secret_key.trim().replace(/-/g, '').replace(/ /g, ''))
      } else {
        bytes = base64ToBytes(row.oath_secret_key)
      }
    } catch {
      failures.push({ index, message: `type ${type} secret 解码失败` })
      return
    }
    if (bytes.length === 0) {
      failures.push({ index, message: 'secret 为空' })
      return
    }
    entries.push({
      type: 'totp',
      issuer: optString(row.name), // 列 name → issuer
      label: optString(row.username), // 列 username → label
      secret: base32Encode(bytes),
      algorithm: 'SHA1', // OtpInfo.DEFAULT_ALGORITHM
      digits: type === 1 ? 8 : 6,
      period: 30, // TotpInfo.DEFAULT_PERIOD
    })
  })
  return { entries, failures }
}

/**
 * SQLite 已知表名探测清单（Task 5 ImportCard 字节入口）：sqlite_master 表名 → 行转换。
 * 源码核实（Task 3）：Aegis SQLite 类导入仅 MicrosoftAuthImporter（SELECT * FROM accounts）
 * 为真 SQLite；Duo（duokit accounts.json）/Authy/Battle.net（shared_prefs XML）均为文本格式，
 * 走各自文本入口（importDuo/importAuthy/importBattleNet），不在此列。
 */
export const SQLITE_TABLE_PROBES: ReadonlyArray<{
  table: string
  toEntries: (rows: Array<Record<string, unknown>>) => ImportResult
}> = [{ table: 'accounts', toEntries: msAuthRowsToEntries }]

// ---------- Duo（DuoImporter.java：files/duokit/accounts.json，非 SQLite） ----------
// 源码口径：条目 {name, otpGenerator:{otpSecret(base32), counter?}}；
// counter 存在 → HotpInfo(secret, counter)，否则 TotpInfo(secret)（SHA1/6/30）；
// issuer 恒 ''、label=name。简报猜测的 duo_accounts/projects/accounts_devices 表与源码不符。

function convertDuoEntry(row: Record<string, unknown>): ParsedEntry | { error: string } {
  const label = optString(row.name) // optString("name")
  const otpData = asObject(row.otpGenerator)
  if (!otpData) return { error: '缺少 otpGenerator' }
  if (typeof otpData.otpSecret !== 'string') return { error: '缺少 secret（otpSecret）' }
  let bytes: Uint8Array
  try {
    bytes = base32Decode(otpData.otpSecret)
  } catch {
    return { error: 'otpSecret 解码失败（非法 base32）' }
  }
  if (bytes.length === 0) return { error: 'secret 为空' }
  // has("counter") ? getLong("counter") : null
  if ('counter' in otpData && otpData.counter !== null) {
    const counter = Number(otpData.counter)
    if (!Number.isInteger(counter) || counter < 0) return { error: 'counter 非法' }
    return { type: 'hotp', issuer: '', label, secret: base32Encode(bytes), algorithm: 'SHA1', digits: 6, period: 30, counter }
  }
  return { type: 'totp', issuer: '', label, secret: base32Encode(bytes), algorithm: 'SHA1', digits: 6, period: 30 }
}

/** Duo 行转换（duokit accounts.json 的 JSON 数组条目） */
export function duoRowsToEntries(rows: Array<Record<string, unknown>>): ImportResult {
  return collectEntries(rows, (raw) => {
    const row = asObject(raw)
    return row ? convertDuoEntry(row) : { error: '条目非对象' }
  })
}

/** Duo 导入（files/duokit/accounts.json 明文 JSON 数组；DuoImporter.read：JSONArray 解析失败 → 结构级错误） */
export function importDuo(text: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Duo 文件结构非法：不是合法 JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('Duo 文件结构非法：顶层不是 JSON 数组')
  return duoRowsToEntries(parsed)
}

// ---------- Authy（AuthyImporter.java：shared_prefs XML 内 JSON 令牌数组，非 SQLite） ----------
// 源码口径（read(InputStream) 读单个 XML，取 com.authy.storage.tokens.authenticator[.authy].key 的值）：
// - 加密判定 read(JSONArray)：任一条目无 decryptedSecret 且无 secretSeed → EncryptedState
// - EncryptedState.decrypt：对每条 JsonUtils.optString("encryptedSecret") 非空的条目，
//   salt=getString("salt")（缺 → 结构级错误），PBKDF2WithHmacSHA1(口令, UTF8(salt), 1000 iter, 256bit)
//   → AES/CBC/PKCS5Padding（IV=16 字节零）解密 → decryptedSecret = UTF8(明文)
// - convertEntry：originalName/originalIssuer/accountType=JsonUtils.optString（可为 null）、
//   name=optString（''兜底）；isAuthy = has("secretSeed")：secretSeed hex 解码，否则 decryptedSecret base32；
//   digits=getInt（必需）；TotpInfo(secret, SHA1, digits, isAuthy ? 10 : 30)
// - sanitizeEntryInfo（非 authy）：issuer 取 originalIssuer；否则 originalName 含 ":" → 冒号前段（sep=":"）；
//   否则 name 含 " - " → 前段（sep=" - "）；否则 capitalize(accountType)（null → 单条失败）；
//   name = name.replace(issuer+sep, "")（字面全量替换）；末尾 name 以 ": " 开头再剥 2 字符。
//   authy：issuer=name、name=''
// 简报猜测的 accounts 表 original_name/dec_secret 与源码不符。

function authySanitize(
  originalName: string | null,
  originalIssuer: string | null,
  accountType: string | null,
  name: string,
  isAuthy: boolean,
): { issuer: string; label: string } | { error: string } {
  let issuer: string
  let separator = ''
  if (isAuthy) {
    issuer = name
    name = ''
  } else if (originalIssuer !== null) {
    issuer = originalIssuer
  } else if (originalName !== null && originalName.includes(':')) {
    issuer = originalName.slice(0, originalName.indexOf(':'))
    separator = ':'
  } else if (name.includes(' - ')) {
    issuer = name.slice(0, name.indexOf(' - '))
    separator = ' - '
  } else {
    // AccountType.substring → null 时 NPE → DatabaseImporterEntryException（单条失败）
    if (accountType === null) return { error: '缺少 accountType' }
    issuer = accountType.substring(0, 1).toUpperCase() + accountType.substring(1)
  }
  let label = name.split(issuer + separator).join('') // Java String.replace：字面全量替换
  if (label.startsWith(': ')) label = label.slice(2)
  return { issuer, label }
}

function convertAuthyEntry(row: Record<string, unknown>): ParsedEntry | { error: string } {
  const originalName = jsonOptString(row.originalName)
  const originalIssuer = jsonOptString(row.originalIssuer)
  const accountType = jsonOptString(row.accountType)
  const name = optString(row.name)
  const isAuthy = 'secretSeed' in row

  let bytes: Uint8Array
  try {
    if (isAuthy) {
      if (typeof row.secretSeed !== 'string') return { error: '缺少 secretSeed' }
      const decoded = hexToBytes(row.secretSeed)
      if (!decoded || decoded.length === 0) return { error: 'secretSeed 解码失败（非法 hex）' }
      bytes = decoded
    } else {
      if (typeof row.decryptedSecret !== 'string') return { error: '缺少 secret（decryptedSecret）' }
      bytes = base32Decode(row.decryptedSecret)
      if (bytes.length === 0) return { error: 'secret 为空' }
    }
  } catch {
    return { error: 'secret 解码失败' }
  }

  if (row.digits === null || row.digits === undefined || !Number.isFinite(Number(row.digits))) {
    return { error: '缺少 digits' } // getInt("digits") 抛 JSONException → 单条失败
  }
  const digits = Number(row.digits)

  const sanitized = authySanitize(originalName, originalIssuer, accountType, name, isAuthy)
  if ('error' in sanitized) return sanitized

  return {
    type: 'totp',
    issuer: sanitized.issuer,
    label: sanitized.label,
    secret: base32Encode(bytes),
    algorithm: 'SHA1',
    digits,
    period: isAuthy ? 10 : 30,
  }
}

const AUTHY_PBKDF2_ITERATIONS = 1000 // AuthyImporter.java ITERATIONS
const AUTHY_IV = new Uint8Array(16) // 源码硬编码 IV（16 字节全零）

/** EncryptedState.decrypt：PBKDF2WithHmacSHA1(1000/256bit) + AES-CBC(IV=0) 就地解密（返回副本，不改入参） */
async function authyDecrypt(
  rows: Array<Record<string, unknown>>,
  password: string,
): Promise<Array<Record<string, unknown>>> {
  const passBytes = new TextEncoder().encode(password)
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('raw', passBytes as BufferSource, 'PBKDF2', false, ['deriveKey'])
  } catch {
    throw new Error('Authy 口令错误或文件已损坏')
  }
  const out: Array<Record<string, unknown>> = []
  for (const row of rows) {
    const encryptedSecret = jsonOptString(row.encryptedSecret) // JsonUtils.optString → null 跳过
    if (encryptedSecret === null) {
      out.push(row)
      continue
    }
    if (typeof row.salt !== 'string') {
      throw new Error('Authy 文件结构非法：加密条目缺少 salt')
    }
    let cipherBytes: Uint8Array
    try {
      cipherBytes = base64ToBytes(encryptedSecret)
    } catch {
      throw new Error('Authy 口令错误或文件已损坏')
    }
    let plain: ArrayBuffer
    try {
      const derived = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-1', salt: new TextEncoder().encode(row.salt) as BufferSource, iterations: AUTHY_PBKDF2_ITERATIONS },
        key,
        { name: 'AES-CBC', length: 256 },
        false,
        ['decrypt'],
      )
      plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: AUTHY_IV as BufferSource }, derived, cipherBytes as BufferSource)
    } catch {
      throw new Error('Authy 口令错误或文件已损坏')
    }
    // obj.remove(encryptedSecret/salt) + obj.put(decryptedSecret)；副本承载，不改入参
    const { encryptedSecret: _e, salt: _s, ...rest } = row
    out.push({ ...rest, decryptedSecret: new TextDecoder().decode(plain) })
  }
  return out
}

/**
 * Authy 令牌数组行转换（shared_prefs .key 值的 JSON 数组）。
 * 任一条目无 decryptedSecret 且无 secretSeed（EncryptedState）时必须提供口令，否则结构级报错。
 */
export async function authyRowsToEntries(rows: Array<Record<string, unknown>>, password?: string): Promise<ImportResult> {
  // AuthyImporter.read：任一条目 !has(decryptedSecret) && !has(secretSeed) → EncryptedState
  const encrypted = rows.some((row) => !('decryptedSecret' in row) && !('secretSeed' in row))
  let target = rows
  if (encrypted) {
    if (!password) throw new Error('Authy 导出受口令保护：请输入导出口令')
    target = await authyDecrypt(rows, password)
  }
  return collectEntries(target, (raw) => {
    const row = asObject(raw)
    return row ? convertAuthyEntry(row) : { error: '条目非对象' }
  })
}

const AUTHY_AUTH_KEY = 'com.authy.storage.tokens.authenticator.key'
const AUTHY_AUTHY_KEY = 'com.authy.storage.tokens.authy.key'

/**
 * Authy 导入（shared_prefs XML 文本；AuthyImporter.read(InputStream)：取首个 .key 条目的值）。
 * 未找到 .key 键 → 空结果（源码 JSONArray 保持空）；值非合法 JSON → 结构级报错。
 * password：EncryptedState（任一条目无 decryptedSecret 且无 secretSeed）时必填，缺省 → 结构级报错。
 */
export async function importAuthy(text: string, password?: string): Promise<ImportResult> {
  const rows: Array<Record<string, unknown>> = []
  for (const m of text.matchAll(XML_STRING_RE)) {
    const name = m[1] ?? ''
    if (name === AUTHY_AUTH_KEY || name === AUTHY_AUTHY_KEY) {
      let parsed: unknown
      try {
        parsed = JSON.parse(xmlUnescape(m[2] ?? ''))
      } catch {
        throw new Error('Authy 文件结构非法：令牌值不是合法 JSON')
      }
      if (!Array.isArray(parsed)) throw new Error('Authy 文件结构非法：令牌值不是 JSON 数组')
      rows.push(...(parsed as Array<Record<string, unknown>>))
      break
    }
  }
  return authyRowsToEntries(rows, password)
}

// ---------- Battle.net（BattleNetImporter.java：SharedPreferences XML + XOR 掩码，非 SQLite） ----------
// 源码口径：键 com.blizzard.messenger.AUTHENTICATOR_SERIAL / AUTHENTICATOR_DEVICE_SECRET；
// 值 = hex(UTF8(明文) 按字节 XOR 硬编码 60B key)；secret=Hex.decode(unmask(secret))，
// TotpInfo(secret, SHA1, 8 digits, 30)；issuer 恒 "Battle.net"、label=unmask(serial)（serial 缺省 "" 不 unmask）。
// 缺 DEVICE_SECRET 键 → DatabaseImporterException（结构级）；unmask 超出 key 长度（Java AIOOBE）或
// hex 非法 → 单条失败。简报猜测的 SQLite 表与源码不符。

const BATTLENET_KEY = hexToBytes(
  '398e27fc50276a656065b0e525f4c06c04c61075286b8e7aeda59da9813b5dd6c80d2fb38068773fa59ba47c17ca6c6479015c1d5b8b8f6b9a',
)!
const BATTLENET_SERIAL = 'com.blizzard.messenger.AUTHENTICATOR_SERIAL'
const BATTLENET_SECRET = 'com.blizzard.messenger.AUTHENTICATOR_DEVICE_SECRET'

/** BattleNetImporter.unmask：hex 解码后逐字节 XOR 硬编码 key（超出 key 长度 → Java AIOOBE 口径报错） */
function battleNetUnmask(s: string): string {
  const ds = hexToBytes(s)
  if (!ds) throw new Error('掩码值非法 hex')
  const out: number[] = []
  for (let i = 0; i < ds.length; i++) {
    const k = BATTLENET_KEY[i]
    if (k === undefined) throw new Error('掩码值超出长度') // Java ArrayIndexOutOfBoundsException
    out.push(ds[i]! ^ k)
  }
  return String.fromCharCode(...out)
}

/** Battle.net 导入（SharedPreferences XML 文本；单文件单条目） */
export function importBattleNet(text: string): ImportResult {
  let serial: string | null = null
  let secretValue: string | null = null
  for (const m of text.matchAll(XML_STRING_RE)) {
    const name = m[1] ?? ''
    if (name === BATTLENET_SECRET) secretValue = m[2] ?? ''
    else if (name === BATTLENET_SERIAL) serial = m[2] ?? ''
  }
  if (secretValue === null) {
    // BattleNetImporter.read：Key not found → DatabaseImporterException（结构级）
    throw new Error(`Battle.net 文件结构非法：Key not found: ${BATTLENET_SECRET}`)
  }
  try {
    // !Strings.isNullOrEmpty(serial) 时才 unmask
    const label = serial ? battleNetUnmask(serial) : ''
    const bytes = hexToBytes(battleNetUnmask(secretValue))
    if (!bytes || bytes.length === 0) throw new Error('secret 解码失败（unmask 结果非法 hex）')
    return {
      entries: [
        {
          type: 'totp',
          issuer: 'Battle.net',
          label,
          secret: base32Encode(bytes),
          algorithm: 'SHA1',
          digits: 8, // TotpInfo(secret, DEFAULT_ALGORITHM, 8, DEFAULT_PERIOD)
          period: 30,
        },
      ],
      failures: [],
    }
  } catch (e) {
    // convertEntry 异常 → DatabaseImporterEntryException（单条失败，本格式仅一条）
    return { entries: [], failures: [{ index: 0, message: e instanceof Error ? e.message : String(e) }] }
  }
}
