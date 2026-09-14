import type { ImportFormat } from './types'

// 统一入口：re-export 同目录实现，供外部从 sniff 单点导入
export * from './types'
export * from './generic'
export * from './uriBatch'

/**
 * 格式嗅探，判定顺序：
 *   aegis → twoFas → bitwarden → proton → stratum（JSON 对象特征键）
 *   → generic(JSON array/JSONL/单对象兜底) → winauth(XML 正则) → uriBatch → null
 * - JSON 对象含 db / header 键 → 'aegis'
 * - 对象含 services 数组且存在条目带顶层 secret 字符串 → 'twoFas'（TwoFasImporter.java schema）
 * - 对象含 items 数组且存在条目带 login.totp 字符串，或含 encrypted 键
 *   （密码保护导出 {encrypted:true, data:{items}} 顶层无 items）→ 'bitwarden'
 * - 对象含 entries 数组且存在条目带 content 对象 → 'proton'（ProtonAuthenticatorImporter.java）
 * - 对象含 Authenticators 数组 → 'stratum'（StratumImporter.java 大写键 schema）
 * - JSON 数组 / JSONL / 其余单 JSON 对象 → 'generic'
 * - 文本含 winauth（大小写不敏感，XML 用正则判定，M1 不引入 XML 解析器）→ 'winauth'
 * - 含 otpauth:// → 'uriBatch'
 * 注：Ente 明文导出即 otpauth URI 行（EnteAuthImporter 委托 GoogleAuthUriImporter），落入
 * uriBatch，不设独立判定；Ente 加密导出与未知 JSON 无可靠特征，留给手动选择（generic/uriBatch）。
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
        // 单个 JSON 对象（非以上格式）→ 通用格式
        return 'generic'
      }
    } catch {
      // 非完整 JSON，继续后续判定（可能是 JSONL）
    }
  }

  // 2. generic：JSON 数组
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return 'generic'
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

  // 4. uriBatch
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
