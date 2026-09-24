import { base32Decode } from '../encoding/base32'
import { parseOtpUri } from '../otp/uri'
import {
  asObject, collectEntries, normalizeAlgorithm, normalizeSecret, steamEntry,
  toNonNegativeNumber, toPositiveNumber,
} from './normalize'
import type { ImportResult, ParsedEntry } from './types'

// JSON 类 App 导出格式导入（2FAS / Bitwarden / Proton / Stratum）。
// 每个格式的字段口径以 Aegis 官方 Importer 源码为准（beemdevelopment/Aegis master）：
// - importers/TwoFasImporter.java
// - importers/BitwardenImporter.java
// - importers/ProtonAuthenticatorImporter.java
// - importers/StratumImporter.java
// 错误契约与 aegis.ts 一致：结构级错误（缺顶层数组等）throw；单条损坏进 failures 不阻断。
// （Ente Auth 不在此处：明文导出即 otpauth URI 行，由 uriBatch 覆盖；加密导出检测亦内建于
// uriBatch——原 importEnte 已并入，见 uriBatch.ts。）

// ---------- 共享辅助（与 generic.ts/aegis.ts 口径一致 — 多数已迁出至 ./normalize） ----------

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

/** steam://<base32 secret>（非特殊 scheme，URL 解析 host 不可靠，手动截取 authority） */
function steamAuthority(uri: string): string {
  return uri.slice('steam://'.length).split('/')[0] ?? ''
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
  if (obj.services.length === 0) throw new Error('2FAS 导出无条目：services 数组为空')

  // groups: [{id, name}]；service.groupId → name 查表（spec §4）
  const groupMap = new Map<string, string>()
  if (Array.isArray(obj.groups)) {
    for (const g of obj.groups) {
      const o = asObject(g)
      if (o && typeof o.id === 'string' && typeof o.name === 'string' && o.name.trim() !== '') {
        groupMap.set(o.id, o.name)
      }
    }
  }

  return collectEntries(obj.services, (raw, index) => {
    const service = asObject(raw)
    if (!service) return { error: `条目 ${index} 非对象` }
    const otp = asObject(service.otp)
    if (!otp) return { error: `条目 ${index} 缺少 otp 对象` }
    if (typeof service.secret !== 'string' || service.secret.trim() === '') {
      return { error: `条目 ${index} 缺少 secret` }
    }
    // GoogleAuthInfo.parseSecret 为 Base32 解码，失败即单条失败
    const secret = normalizeSecret(service.secret)
    if (!isBase32(secret)) return { error: `条目 ${index} secret 非法 base32` }

    // issuer：name 非空优先，否则 otp.issuer（convertEntry 口径）
    const issuer =
      (typeof service.name === 'string' && service.name !== '' ? service.name : undefined) ??
      (typeof otp.issuer === 'string' ? otp.issuer : '')
    const label = typeof otp.account === 'string' ? otp.account : ''
    const algorithm = normalizeAlgorithm(otp.algorithm)
    const groupName = typeof service.groupId === 'string' ? groupMap.get(service.groupId) : undefined
    const tags = groupName ? { tags: [groupName] } : {}

    const tokenType = typeof otp.tokenType === 'string' ? otp.tokenType : null
    if (tokenType === null || tokenType === 'TOTP') {
      return {
        type: 'totp',
        issuer,
        label,
        secret,
        algorithm,
        digits: toPositiveNumber(otp.digits, 6),
        period: toPositiveNumber(otp.period, 30),
        ...tags,
      }
    }
    if (tokenType === 'HOTP') {
      return {
        type: 'hotp',
        issuer,
        label,
        secret,
        algorithm,
        digits: toPositiveNumber(otp.digits, 6),
        counter: toNonNegativeNumber(otp.counter, 0),
        period: 30,
        ...tags,
      }
    }
    if (tokenType === 'STEAM') {
      return { ...steamEntry(secret, issuer, label), ...tags }
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
// name→issuer、login.username→label、notes→note。
// 密码保护导出（Bitwarden 官方形态 {encrypted:true, encKeyValidation_DO_NOT_EDIT, data:{items}}）
// 无明文 totp → 结构级报错提示改用明文导出（sniffBitwarden 已按 encrypted 键归 bitwarden）。

/** Bitwarden JSON 导出导入；totp 支持 otpauth URI / steam:// / 裸 base32 secret */
export function importBitwarden(text: string): ImportResult {
  const obj = parseJson(text, 'Bitwarden')
  if (obj.encrypted === true) {
    throw new Error('该 Bitwarden 导出已加密，请使用明文（JSON）导出后重试')
  }
  if (!Array.isArray(obj.items)) throw new Error('Bitwarden 文件结构非法：缺少 items 数组')

  // folders: [{id, name}]；item.folderId → name 查表（spec §4）
  const folderMap = new Map<string, string>()
  if (Array.isArray(obj.folders)) {
    for (const f of obj.folders) {
      const o = asObject(f)
      if (o && typeof o.id === 'string' && typeof o.name === 'string' && o.name.trim() !== '') {
        folderMap.set(o.id, o.name)
      }
    }
  }

  return collectEntries(obj.items, (raw, index) => {
    const item = asObject(raw)
    if (!item) return { error: `条目 ${index} 非对象` }
    const login = asObject(item.login)
    const totp = login && typeof login.totp === 'string' ? login.totp.trim() : ''
    if (totp === '') return { error: `条目 ${index} 缺少 login.totp` }

    const issuer = typeof item.name === 'string' ? item.name : ''
    const label = login && typeof login.username === 'string' ? login.username : ''
    const note = typeof item.notes === 'string' && item.notes !== '' ? item.notes : undefined
    const folderName = item && typeof item.folderId === 'string' ? folderMap.get(item.folderId) : undefined
    const tags = folderName ? { tags: [folderName] } : {}

    if (totp.startsWith('steam://')) {
      const secret = steamAuthority(totp)
      if (!isBase32(secret)) return { error: `条目 ${index} steam secret 非法` }
      return { ...steamEntry(secret, 'Steam', 'Steam account'), note, ...tags }
    }
    if (totp.startsWith('otpauth://')) {
      try {
        return { ...parseOtpUri(totp), issuer, label, note, ...tags }
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
        ...tags,
      }
    }
    return { error: `条目 ${index} totp 非法（非 URI 且非 base32）` }
  })
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

// ---------- FoxAuth（FoxAuth/FoxAuth src/scripts/import.js） ----------
// 顶层 overwriteKeys 白名单 {accountInfos, isEncrypted, passwordInfo, settings, dropbox}。
// 条目：localIssuer→issuer、localAccountName→label、localSecretToken→secret(base32)；
// localOTPType 'Counter based'→hotp（counter 恒 0：FoxAuth 无 counter 字段），否则 totp；
// 算法固定 SHA1（无字段）；digits/period 字符串数字，缺省 6/30。
// 加密备份（isEncrypted:true）：encryptPassword = Base64(UTF-8(口令))（官方 base64Decode 为 UTF-8 语义），
// 比对/解密口令即其解码明文；解密见 decryptFoxauth（参数依据 spec 加密参数附录）。
// 官方另支持口令仅存 sessionStorage（文件无 encryptPassword，结构合法）→ 此时提示无法解密。
export async function importFoxauth(text: string, password?: string): Promise<ImportResult> {
  const obj = parseJson(text, 'FoxAuth')
  // 加密判定先于 accountInfos 形态检查：未给口令时应报「需要口令」而非「缺少 accountInfos」
  const encrypted = obj.isEncrypted === true
  if (encrypted) {
    if (password === undefined || password === '') {
      throw new Error('FoxAuth 加密备份需要口令：请输入导出时设置的密码')
    }
    // accountInfos 两种密文形态（附录 + FoxAuth 源码 accountInfo.js __encryptAndDecrypt）：
    // - 真实导出（sync.js exportBtn = storage.local 全量 dump）：数组，各条目仅
    //   localAccountName/localSecretToken/localRecovery 三字段为密文二进制串，其余明文
    // - 整串密文（spec 附录 Task 4 口径）：非空密文二进制字符串，解密后为条目数组 JSON
    const isBlob = typeof obj.accountInfos === 'string' && obj.accountInfos !== ''
    if (!Array.isArray(obj.accountInfos) && !isBlob) {
      throw new Error('FoxAuth 文件结构非法：缺少 accountInfos')
    }
    const pwdInfo = asObject(obj.passwordInfo)
    if (!pwdInfo) throw new Error('FoxAuth 文件结构非法：加密备份缺少 passwordInfo')
    const b64pwd = pwdInfo.encryptPassword
    if (typeof b64pwd !== 'string' || b64pwd === '') {
      // FoxAuth 官方支持口令仅存 sessionStorage（此时文件只有 encryptIV，结构合法）——提示而非结构错误
      throw new Error('FoxAuth 备份不包含口令（导出时口令可能保存在浏览器会话中），无法解密')
    }
    let pwd: string
    try {
      // encryptPassword = Base64(UTF-8(口令))（FoxAuth import.js base64Decode = new TextDecoder().decode，
      // UTF-8 语义）。atob 直接得到的字符串是 UTF-8 字节的 latin1 视图，含 U+0080–U+00FF 的口令
      // （如 é/ü）必须先经 UTF-8 TextDecoder 还原明文，否则与用户输入比对必失败。
      pwd = new TextDecoder().decode(Uint8Array.from(atob(b64pwd), (c) => c.charCodeAt(0)))
    } catch {
      throw new Error('FoxAuth 文件结构非法：passwordInfo.encryptPassword 不是合法 Base64')
    }
    // FoxAuth 导出时把口令 Base64 同存于 encryptPassword（savePasswordInfo），解密口令即该值；
    // 用户输入口令与其比对：合法导出中两者一致，不一致即口令错误——解密前确定性报错
    // （FoxAuth 自身导入亦从文件还原口令，不向用户询问）
    if (pwd !== password) {
      throw new Error('FoxAuth 备份解密失败：口令错误或文件已损坏')
    }
    // IV 不在密文内，由 encryptIV（12 字节数字数组，FoxAuth accountInfo.js Array.from(iv)）携带；缺失结构级报错
    const iv = pwdInfo.encryptIV
    if (!Array.isArray(iv) || iv.length !== 12 || iv.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error('FoxAuth 文件结构非法：加密备份缺少合法的 passwordInfo.encryptIV（12 字节数组）')
    }
    return collectFoxauthRows(await decryptFoxauth(obj.accountInfos, pwd, iv))
  }
  return parseFoxauthPlaintextObject(obj)
}

/** FoxAuth 明文分支共用：accountInfos 必为条目数组（加密的整串密文形态已在 importFoxauth 分流） */
function parseFoxauthPlaintextObject(obj: Record<string, unknown>): ImportResult {
  if (!Array.isArray(obj.accountInfos)) throw new Error('FoxAuth 文件结构非法：缺少 accountInfos 数组')
  return collectFoxauthRows(obj.accountInfos)
}

/**
 * FoxAuth 明文备份同步导入。独立导出供粘贴分发（import/paste.ts 的同步契约）使用，先例
 * importTotpAuthenticatorPlaintext；加密备份由 paste 通道以 sniffFoxauthEncrypted 拦截引导至
 * 导入页口令通道，不经此处。
 */
export function importFoxauthPlaintext(text: string): ImportResult {
  return parseFoxauthPlaintextObject(parseJson(text, 'FoxAuth'))
}

function collectFoxauthRows(rows: unknown): ImportResult {
  // 解密结果（Task 4 加密分支）类型未知，先收口数组；空数组与 2FAS 同口径给「无条目」错误
  if (!Array.isArray(rows)) throw new Error('FoxAuth 文件结构非法：accountInfos 不是条目数组')
  if (rows.length === 0) throw new Error('FoxAuth 导出无条目：accountInfos 数组为空')
  return collectEntries(rows, (raw, index) => {
    const e = asObject(raw)
    if (!e) return { error: `条目 ${index} 非对象` }
    const secret = typeof e.localSecretToken === 'string' ? normalizeSecret(e.localSecretToken) : ''
    if (!secret) return { error: `条目 ${index} 缺少 secret` }
    if (!isBase32(secret)) return { error: `条目 ${index} secret 非法 base32` }
    const type = e.localOTPType === 'Counter based' ? 'hotp' as const : 'totp' as const
    return {
      type,
      issuer: typeof e.localIssuer === 'string' ? e.localIssuer : '',
      label: typeof e.localAccountName === 'string' ? e.localAccountName : '',
      secret,
      algorithm: 'SHA1' as const,
      digits: toPositiveNumber(Number(e.localOTPDigits), 6),
      ...(type === 'hotp' ? { counter: 0 } : {}),
      period: toPositiveNumber(Number(e.localOTPPeriod), 30),
    }
  })
}

// 解密实现（参数依据 spec「加密参数附录」，源码 FoxAuth/FoxAuth master@65db1142
// keychain.js L26-52/L154-197、MessageEncryption.js L19、accountInfo.js __encryptAndDecrypt，
// roundtrip 回验通过）：
// - rawSecret = 解码明文口令逐字符 charCodeAt（latin1 重编码；官方加密侧 btoa 即 charCodeAt & 0xff
//   语义，pwd 已是 UTF-8 还原的明文，两口径精确一致）
// - KDF = HKDF-SHA-256：salt 空（0 字节），info = UTF-8("encryption")，派生 128bit AES-GCM key
//   （keychain.js 中的 PBKDF2 仅用于 Firefox Send 服务端鉴权，与备份加密无关）
// - AES-GCM：tagLength 128，无 AAD；IV（12B）不在密文内，来自 encryptIV；同备份所有字段复用同一 key+IV
// - 密文编码 = 逐字节 String.fromCharCode 的二进制字符串（非 Base64）：解密逐字符 charCodeAt 还原字节
async function decryptFoxauth(accountInfos: unknown, pwd: string, iv: number[]): Promise<unknown> {
  if (typeof accountInfos !== 'string' && !Array.isArray(accountInfos)) {
    throw new Error('FoxAuth 文件结构非法：accountInfos 不是条目数组')
  }
  try {
    const rawSecret = Uint8Array.from(pwd, (c) => c.charCodeAt(0))
    const base = await crypto.subtle.importKey('raw', rawSecret as BufferSource, 'HKDF', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0) as BufferSource, info: new TextEncoder().encode('encryption') },
      base,
      { name: 'AES-GCM', length: 128 },
      false,
      ['decrypt'],
    )
    const decodeField = async (cipher: string) =>
      new TextDecoder('utf-8').decode(
        new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(iv) as BufferSource, tagLength: 128 }, key, Uint8Array.from(cipher, (c) => c.charCodeAt(0)) as BufferSource)),
      )
    if (typeof accountInfos === 'string') {
      // 整串密文形态：解密 → UTF-8 → JSON（条目数组）
      return JSON.parse(await decodeField(accountInfos))
    }
    // 数组形态（真实导出）：逐条目解密三字段；非对象条目原样透传给 collectFoxauthRows 报单条错误。
    // FoxAuth __encryptAndDecrypt 对 info[key] || '' 一律加密，字段缺失/为空解密后即空串
    return await Promise.all(
      accountInfos.map(async (raw) => {
        const e = asObject(raw)
        if (!e) return raw
        const out: Record<string, unknown> = { ...e }
        for (const k of ['localAccountName', 'localSecretToken', 'localRecovery']) {
          const v = e[k]
          out[k] = typeof v === 'string' && v !== '' ? await decodeField(v) : ''
        }
        return out
      }),
    )
  } catch {
    // 口令错误 → OperationError（GCM tag 校验失败）；密文损坏/非法 JSON 同口径收敛
    throw new Error('FoxAuth 备份解密失败：口令错误或文件已损坏')
  }
}
