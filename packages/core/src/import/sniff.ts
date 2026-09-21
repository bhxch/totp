import type { ImportFormat } from './types'

// 统一入口：re-export 同目录实现，供外部从 sniff 单点导入
export * from './types'
export * from './generic'
export * from './uriBatch'

/**
 * 格式嗅探，判定顺序：
 *   aegis → twoFas → bitwarden → proton → stratum → freeOtp → foxauth（JSON 对象特征键）
 *   → andOtp → totpAuthenticator（JSON 数组特征键）→ generic(JSON array/JSONL/单对象兜底)
 *   → winauth(XML 正则) → freeOtpLegacy(tokens.xml 正则) → uriBatch → null
 * - JSON 对象含 db / header 键 → 'aegis'
 * - 对象含 services 数组且存在条目带顶层 secret 字符串 → 'twoFas'（TwoFasImporter.java schema）
 * - 对象含 items 数组且存在条目带 login.totp 字符串，或含 encrypted 键
 *   （密码保护导出 {encrypted:true, data:{items}} 顶层无 items）→ 'bitwarden'
 * - 对象含 entries 数组且存在条目带 content 对象 → 'proton'（ProtonAuthenticatorImporter.java）
 * - 对象含 Authenticators 数组 → 'stratum'（StratumImporter.java 大写键 schema）
 * - 对象含 tokens 数组且存在条目 issuerExt 字符串 + secret 字节数组 → 'freeOtp'
 *   （FreeOtpPlusImporter.java：{tokenOrder, tokens:[{issuerExt, secret: Gson byte[], ...}]}）
 * - JSON 数组且存在条目 type/algorithm/label/secret 均字符串 → 'andOtp'（AndOtpImporter.java 明文导出）
 * - JSON 数组且存在条目 base 为整数 + key 为字符串 → 'totpAuthenticator'
 *   （TotpAuthenticatorImporter.java 条目 {base:16|32|64, key, ...}）
 * - JSON 数组 / JSONL / 其余单 JSON 对象 → 'generic'
 * - 文本含 winauth（大小写不敏感，XML 用正则判定，M1 不引入 XML 解析器）→ 'winauth'
 * - XML 含 tokenOrder 或 issuerExt → 'freeOtpLegacy'（FreeOtpImporter.java readV1：tokens.xml）
 * - 含 otpauth:// → 'uriBatch'
 * 注：Ente 明文导出即 otpauth URI 行（EnteAuthImporter 委托 GoogleAuthUriImporter），落入
 * uriBatch，不设独立判定；Ente 加密导出与未知 JSON 无可靠特征，留给手动选择（generic/uriBatch）。
 * TOTP Authenticator 外部分享为纯 base64 密文，与任意文本无可靠区分特征，不强判（手动选择）。
 * Authenticator Plus 导出为 WinZip AES 加密 zip（二进制），文本嗅探不适用——入口为
 * ImportCard 手动选择「Authenticator Plus」+ readImportFileBytes 字节通道，不加入 sniffFormat。
 */
// Aegis 特征键：明文与加密 vault 顶层均含 'header'（{slots,params}，明文 slots 为空数组）——
// 不能以 header 存在判加密；可靠区分是顶层 db 的类型：明文 db 为对象，加密 db 为密文 Base64 字符串。
// 嗅探结果包含 encrypted 标志，让 UI 调用方决定走口令页 vs 直接解析。
export interface AegisSniff {
  kind: 'aegis'
  encrypted: boolean
}

/** 对象级 Aegis 判定（仅 JSON.parse 之后的对象）；为 sniffFormat 抽出共用判定逻辑（M11） */
function sniffAegisObject(obj: Record<string, unknown>): boolean {
  return 'db' in obj || 'header' in obj
}

/** 对象级 FoxAuth 加密判定（仅 JSON.parse 之后的对象）：顶层 isEncrypted === true 即加密备份 */
function sniffFoxauthEncryptedObject(obj: Record<string, unknown>): boolean {
  return obj.isEncrypted === true
}

/**
 * FoxAuth 加密判定（顶层 isEncrypted 布尔，FoxAuth overwriteKeys 特有键）：供粘贴通道
 * （import/paste.ts）与导入页（ImportCard）拦截加密备份、引导至口令通道，口径同 sniffAegis 的
 * encrypted 标志；非对象 JSON / 解析失败一律 false（交由后续格式判定）。
 */
export function sniffFoxauthEncrypted(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    return sniffFoxauthEncryptedObject(parsed as Record<string, unknown>)
  } catch {
    return false
  }
}

/** 顶层入口：JSON.parse 失败返回 null；返回 {kind, encrypted}，其中 encrypted=true 需走口令页 */
export function sniffAegis(text: string): AegisSniff | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (!sniffAegisObject(obj)) return null
  return { kind: 'aegis', encrypted: typeof obj.db === 'string' }
}

export function sniffFormat(text: string): ImportFormat | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 1. JSON 对象族：aegis → 各 App 特征键 → generic 兜底
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>
        if (sniffAegisObject(obj)) return 'aegis' // 加密/明文均判 aegis；加密区分走 sniffAegis
        const twoFas = sniffTwoFas(obj)
        if (twoFas === 'ok' || twoFas === 'empty') return 'twoFas' // 'empty' 由 importTwoFas 给出明确「无条目」错误
        if (sniffBitwarden(obj)) return 'bitwarden'
        if (sniffProton(obj)) return 'proton'
        if (Array.isArray(obj.Authenticators)) return 'stratum'
        if (sniffFreeOtp(obj)) return 'freeOtp'
        if (sniffFoxauth(obj)) return 'foxauth'
        // 单个 JSON 对象（非以上格式）→ 通用格式
        return 'generic'
      }
    } catch {
      // 非完整 JSON，继续后续判定（可能是 JSONL）
    }
  }

  // 2. generic：JSON 数组（数组特征 App 格式优先：andOtp → totpAuthenticator）
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        if (sniffAndOtp(parsed)) return 'andOtp'
        if (sniffTotpAuthenticator(parsed)) return 'totpAuthenticator'
        return 'generic'
      }
    } catch {
      // 继续按行判定
    }
  }

  // 2. generic：JSONL（每行均可解析；多行，或单行且为对象）
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

  // 3. winauth（XML，正则判定）
  if (trimmed.startsWith('<') && /winauth/i.test(trimmed)) return 'winauth'

  // 4. 旧版 FreeOTP tokens.xml（FreeOtpImporter.java readV1）：
  // Android 机器生成，必含 tokenOrder 或条目 JSON 内的 issuerExt 键（转义后仍含该字面量）
  if (trimmed.startsWith('<') && /tokenOrder|issuerExt/.test(trimmed)) return 'freeOtpLegacy'

  // 5. uriBatch
  if (trimmed.includes('otpauth://')) return 'uriBatch'

  return null
}

// services 数组（2FAS）探测结果：
// - 'ok'：存在条目带顶层 secret 字符串（典型 2FAS 明文导出）
// - 'empty'：存在 services 数组但无任何条目符合 schema（空数组 / 条目无 secret），
//   返回 'empty' 让 sniffFormat 显式走 twoFas 解析，importTwoFas 给出「无条目」错误
// - false：没有 services 数组
type TwoFasSniff = 'ok' | 'empty' | false
function sniffTwoFas(obj: Record<string, unknown>): TwoFasSniff {
  const { services } = obj
  if (!Array.isArray(services)) return false
  if (services.length === 0) return 'empty'
  const hasSecretEntry = services.some(
    (s) => s !== null && typeof s === 'object' && typeof (s as Record<string, unknown>).secret === 'string',
  )
  return hasSecretEntry ? 'ok' : 'empty'
}

// Bitwarden 导出：明文为 items 数组（存在条目带 login.totp 字符串）；
// 密码保护导出为 {encrypted:true, encKeyValidation_DO_NOT_EDIT, data:{items:[...]}}，
// 顶层无 items，故 encrypted 键单独判 bitwarden（导入时给出明确加密错误）
function sniffBitwarden(obj: Record<string, unknown>): boolean {
  if ('encrypted' in obj) return true
  const { items } = obj
  if (!Array.isArray(items)) return false
  return items.some((it) => {
    if (it === null || typeof it !== 'object') return false
    const login = (it as Record<string, unknown>).login
    return (
      login !== null &&
      typeof login === 'object' &&
      typeof (login as Record<string, unknown>).totp === 'string'
    )
  })
}

// entries 数组（Proton）且存在条目带 content 对象
function sniffProton(obj: Record<string, unknown>): boolean {
  const { entries } = obj
  return (
    Array.isArray(entries) &&
    entries.some((e) => {
      const content = e !== null && typeof e === 'object' ? (e as Record<string, unknown>).content : null
      return content !== null && typeof content === 'object'
    })
  )
}

// tokens 数组（FreeOTP+）且存在条目 issuer 字符串（兼容旧版 `issuer` 键）+ secret 字节数组（Gson byte[]）；
// 空数组不判，留给 generic
function sniffFreeOtp(obj: Record<string, unknown>): boolean {
  const { tokens } = obj
  return (
    Array.isArray(tokens) &&
    tokens.some((t) => {
      if (t === null || typeof t !== 'object') return false
      const entry = t as Record<string, unknown>
      // 兼容 issuerExt（FreeOTP+）与旧版 issuer 键名（部分 fork / 历史导出）
      const issuerName = entry.issuerExt ?? entry.issuer
      return typeof issuerName === 'string' && Array.isArray(entry.secret)
    })
  )
}

// FoxAuth 备份（FoxAuth/FoxAuth src/scripts/import.js overwriteKeys 白名单）：
// 顶层 isEncrypted 布尔 + accountInfos：明文为数组，加密备份为密文二进制字符串。
// 密文形态一并判 foxauth（对齐 aegis 明文/加密同判口径），未给口令时由 importFoxauth
// 给出「需要口令」明确报错引导；两键组合为 FoxAuth overwriteKeys 特有，其余格式判定键
// 均不同名（aegis db/header、bitwarden encrypted 键等），foxauth 判定先于 generic 兜底，无误伤。
function sniffFoxauth(obj: Record<string, unknown>): boolean {
  if (typeof obj.isEncrypted !== 'boolean') return false
  return Array.isArray(obj.accountInfos) || typeof obj.accountInfos === 'string'
}

// JSON 数组（andOTP 明文导出）且存在条目 type/algorithm/label/secret 均字符串（AndOtpImporter.java）
function sniffAndOtp(rows: unknown[]): boolean {
  return rows.some((r) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return false
    const e = r as Record<string, unknown>
    return (
      typeof e.type === 'string' &&
      typeof e.algorithm === 'string' &&
      typeof e.label === 'string' &&
      typeof e.secret === 'string'
    )
  })
}

// JSON 数组（TOTP Authenticator 明文条目）且存在条目 base 整数 + key 字符串
// （TotpAuthenticatorImporter.java convertEntry：getInt("base") + getString("key")）
function sniffTotpAuthenticator(rows: unknown[]): boolean {
  return rows.some((r) => {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) return false
    const e = r as Record<string, unknown>
    return Number.isInteger(e.base) && typeof e.key === 'string'
  })
}
