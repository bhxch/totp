import type { ImportFormat } from './types'

// 统一入口：re-export 同目录实现，供外部从 sniff 单点导入
export * from './types'
export * from './generic'
export * from './uriBatch'

/**
 * 格式嗅探，判定顺序：
 *   aegis → twoFas → bitwarden → proton → stratum → freeOtp（JSON 对象特征键）
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
 */
export function sniffFormat(text: string): ImportFormat | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 1. JSON 对象族：aegis → 各 App 特征键 → generic 兜底
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>
        if ('db' in obj || 'header' in obj) return 'aegis'
        if (sniffTwoFas(obj)) return 'twoFas'
        if (sniffBitwarden(obj)) return 'bitwarden'
        if (sniffProton(obj)) return 'proton'
        if (Array.isArray(obj.Authenticators)) return 'stratum'
        if (sniffFreeOtp(obj)) return 'freeOtp'
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

// services 数组（2FAS）且存在条目带顶层 secret 字符串（空数组不判，留给 generic）
function sniffTwoFas(obj: Record<string, unknown>): boolean {
  const { services } = obj
  return (
    Array.isArray(services) &&
    services.some(
      (s) => s !== null && typeof s === 'object' && typeof (s as Record<string, unknown>).secret === 'string',
    )
  )
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
