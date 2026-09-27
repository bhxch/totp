import { importAegisPlaintext } from './aegis'
import { importAndOtp, importFreeOtp, importFreeOtpLegacy, importTotpAuthenticator, importTotpAuthenticatorPlaintext } from './miscApps'
import { importBitwarden, importFoxauth, importFoxauthPlaintext, importProton, importStratum, importTwoFas } from './jsonApps'
import { importUriBatch } from './uriBatch'
import type { ImportResult } from './types'

// 导入格式单一注册表（R5）：ImportFormat 全集 → 描述符。新增一种格式 = 在 IMPORT_REGISTRY
// 加一个条目；嗅探（sniffFormat 查表）、粘贴白名单（paste.ts 派生）、导入页直接解析族
// （ImportCard TEXT_PARSERS 派生）与两端口令判定（needsPasswordFor）均由本表派生，不再散落。
//
// 描述符字段与既有两态语义的对应（嗅探判定顺序文档见 IMPORT_REGISTRY 键序注释）：
// - sniffObject/sniffArray/sniffText：格式特征谓词，输入形态三通道（JSON 对象 / JSON 数组 /
//   文本正则），由 sniffFormat 按注册表键序在对应通道内调用；
// - paste：粘贴白名单（文本可直接同步解析）。parsePastedText 为同步契约（ui clipboardImport
//   直接消费返回值不做 await），故 paste 槽只接受同步实现——totpAuthenticator/foxauth 在此
//   登记明文同步变体，加密态由 needsPassword 谓词先行拦截引导口令通道；
// - parse：统一解析入口（导入页直接解析族派生源），签名统一为「可 await」，同步实现与加密
//   感知异步实现（totpAuthenticator/foxauth）均可登记；调用点 await 两态兼容；
// - needsPassword：内容谓词 (text) => boolean。「是否走口令页」是文本内容函数而非格式静态
//   属性——加密 aegis（db 为密文串）、密文 totpAuthenticator（非 '[' 开头的 Base64 分享）
//   两种既有两态行为（foxauth 加密态经 D1 免口令，不设谓词），静态布尔无法派生两态路由，禁用（方案 §6）。
//   仅两态格式登记；恒进口令页的格式（winauth/authy/authenticatorPlus）由导入页显式分支表达
//   （口令页交互分支差异真实存在，不做表格化），不经此谓词。

/** 统一解析签名：同步实现直接登记、异步实现同样登记，调用点 await 两态兼容 */
export type ImportParse = (text: string) => ImportResult | Promise<ImportResult>

/** 粘贴通道解析器：parsePastedText 为同步契约，只接受同步实现（明文变体） */
export type ImportPasteParse = (text: string) => ImportResult

export interface ImportFormatDescriptor {
  /** JSON 对象通道特征谓词（'{ '开头且 JSON.parse 成功为对象时，依注册表键序调用） */
  sniffObject?: (obj: Record<string, unknown>) => boolean
  /** JSON 数组通道特征谓词（'[' 开头且 JSON.parse 成功为数组时，依注册表键序调用） */
  sniffArray?: (rows: unknown[]) => boolean
  /** 文本通道特征谓词（前缀/正则/包含判定，依注册表键序调用） */
  sniffText?: (text: string) => boolean
  /** 粘贴白名单：文本可直接同步解析（paste 通道分派源）；缺省 = 引导导入页 */
  paste?: ImportPasteParse
  /** 统一解析入口（导入页直接解析族派生源）；异步加密感知实现登记于此 */
  parse?: ImportParse
  /**
   * 内容谓词：该文本需走口令页（两端口令判定统一派生源 needsPasswordFor 的依据）。
   * 必须是文本内容函数；静态布尔禁用（会丢加密/明文两态路由，方案 §6 剔除项）。
   */
  needsPassword?: (text: string) => boolean
}

// ---------- 嗅探特征判定（自 sniff.ts 迁入，格式知识归注册表单点持有） ----------

// Aegis 特征键：明文与加密 vault 顶层均含 'header'（{slots,params}，明文 slots 为空数组）——
// 不能以 header 存在判加密；可靠区分是顶层 db 的类型：明文 db 为对象，加密 db 为密文 Base64 字符串。
/** 对象级 Aegis 判定（仅 JSON.parse 之后的对象） */
function sniffAegisObject(obj: Record<string, unknown>): boolean {
  return 'db' in obj || 'header' in obj
}

/** 对象级 FoxAuth 加密判定（仅 JSON.parse 之后的对象）：顶层 isEncrypted === true 即加密备份 */
function sniffFoxauthEncryptedObject(obj: Record<string, unknown>): boolean {
  return obj.isEncrypted === true
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
// 密文形态一并判 foxauth（对齐 aegis 明文/加密同判口径），D1 后明文/加密均免口令直接解析；
// 两键组合为 FoxAuth overwriteKeys 特有，其余格式判定键均不同名（aegis db/header、bitwarden
// encrypted 键等），foxauth 判定先于 generic 兜底，无误伤。
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

/** 文本级 JSON 对象解析外壳：trim 后 '{' 开头且整体 parse 成功为对象才返回，否则 null
 * （sniffFormat 对象通道 / aegis·foxauth 两态谓词共用；非对象防御分支与既有实现一致） */
function parseJsonObjectText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * FoxAuth 加密判定（顶层 isEncrypted 布尔）：口径同 sniffAegis 的 encrypted 标志。
 * D1 后注册表 foxauth 条目不再设 needsPassword 谓词（明文/加密均免口令直接解析），
 * 本函数保留出包导出（sniff.ts 单点 re-export）与加密判定语义。
 * 非对象 JSON / 解析失败一律 false（交由后续格式判定）。
 */
export function sniffFoxauthEncrypted(text: string): boolean {
  const obj = parseJsonObjectText(text)
  return obj !== null && sniffFoxauthEncryptedObject(obj)
}

// 嗅探结果包含 encrypted 标志，让 UI 调用方决定走口令页 vs 直接解析
export interface AegisSniff {
  kind: 'aegis'
  encrypted: boolean
}

/** 顶层入口：JSON.parse 失败返回 null；返回 {kind, encrypted}，其中 encrypted=true 需走口令页 */
export function sniffAegis(text: string): AegisSniff | null {
  const obj = parseJsonObjectText(text)
  if (!obj || !sniffAegisObject(obj)) return null
  return { kind: 'aegis', encrypted: typeof obj.db === 'string' }
}

// ---------- 注册表：键序 = 嗅探优先序（行为契约，test/importSniffOrder.test.ts 快照锁定） ----------
//
// 嗅探优先序显式为元组（ImportFormat 由其派生）：对象族 → 数组族 → 文本族 → generic 收尾。
// 嗅探通道与键序的对应：
// - JSON 对象族（'{ '开头）：aegis → twoFas → bitwarden → proton → stratum → freeOtp → foxauth
//   → generic（无特征键兜底，无 sniff 谓词，兜底逻辑在 sniffFormat 骨架内）
// - JSON 数组族（'[' 开头）：andOtp → totpAuthenticator → generic（数组兜底）
// - JSONL（多行全可解析）：generic
// - 文本族：winauth（'<'+winauth 正则）→ freeOtpLegacy（'<'+tokenOrder|issuerExt）→ uriBatch（含 otpauth://）
// IMPORT_REGISTRY 以 Record<ImportFormat, …> 注解与元组互锁：新增/删改格式须同步元组与条目，
// 漏一侧即编译错。Ente/TOTP Authenticator 外部分享/Authenticator Plus 不设嗅探判定的原因见
// sniffFormat 注释。
export const IMPORT_FORMAT_ORDER = [
  'aegis', 'twoFas', 'bitwarden', 'proton', 'stratum', 'freeOtp', 'foxauth',
  'andOtp', 'totpAuthenticator', 'winauth', 'freeOtpLegacy', 'uriBatch', 'generic',
] as const

/** ImportFormat 全集由优先序元组派生；新增格式 = 元组加键 + 注册表加条目（编译期互锁） */
export type ImportFormat = (typeof IMPORT_FORMAT_ORDER)[number]

export const IMPORT_REGISTRY: Record<ImportFormat, ImportFormatDescriptor> = {
  aegis: {
    sniffObject: sniffAegisObject,
    paste: importAegisPlaintext,
    parse: importAegisPlaintext,
    // 两态：顶层 db 为密文 Base64 字符串 → 加密（口令页）；明文 db 为对象 → 直解（口径同 sniffAegis.encrypted）
    needsPassword: (text: string): boolean => {
      const obj = parseJsonObjectText(text)
      return obj !== null && sniffAegisObject(obj) && typeof obj.db === 'string'
    },
  },
  twoFas: {
    // 'empty'（services 空数组/条目无 secret）同样判 twoFas：importTwoFas 给出明确「无条目」错误
    sniffObject: (obj: Record<string, unknown>): boolean => sniffTwoFas(obj) !== false,
    paste: importTwoFas,
    parse: importTwoFas,
  },
  bitwarden: { sniffObject: sniffBitwarden, paste: importBitwarden, parse: importBitwarden },
  proton: { sniffObject: sniffProton, paste: importProton, parse: importProton },
  stratum: {
    sniffObject: (obj: Record<string, unknown>): boolean => Array.isArray(obj.Authenticators),
    paste: importStratum,
    parse: importStratum,
  },
  freeOtp: { sniffObject: sniffFreeOtp, paste: importFreeOtp, parse: importFreeOtp },
  foxauth: {
    sniffObject: sniffFoxauth,
    paste: importFoxauthPlaintext,
    parse: importFoxauth,
    // 明文/加密均免口令直接解析(D1):解密口令取自文件内 encryptPassword，口令页不再拦截
  },
  andOtp: { sniffArray: sniffAndOtp, paste: importAndOtp, parse: importAndOtp },
  totpAuthenticator: {
    sniffArray: sniffTotpAuthenticator,
    // 粘贴通道只可能嗅探到明文 JSON 数组（密文分享无可靠特征不强判），同步明文变体足够；
    parse: importTotpAuthenticator,
    paste: importTotpAuthenticatorPlaintext,
    // 两态：外部分享为 Base64 密文（非 '[' 开头明文数组）→ 口令页；粘贴通道嗅探恒判明文，谓词恒 false 不影响
    needsPassword: (text: string): boolean => !text.trim().startsWith('['),
  },
  winauth: {
    // 文本通道 winauth 先于 freeOtpLegacy/uriBatch（XML 且含 winauth 字样优先）
    sniffText: (text: string): boolean => text.startsWith('<') && /winauth/i.test(text),
    // 无 paste/parse 槽：文件惯例格式，粘贴不强解；口令页（口令可选 + DPAPI 解密通道）由导入页显式分支
  },
  freeOtpLegacy: {
    // 旧版 FreeOTP tokens.xml：Android 机器生成，必含 tokenOrder 或条目 JSON 内的 issuerExt 键
    sniffText: (text: string): boolean => text.startsWith('<') && /tokenOrder|issuerExt/.test(text),
    paste: importFreeOtpLegacy,
    parse: importFreeOtpLegacy,
  },
  uriBatch: {
    sniffText: (text: string): boolean => text.includes('otpauth://'),
    paste: importUriBatch,
    parse: importUriBatch,
  },
  // generic 兜底格式：无 sniff 特征谓词（对象/数组/JSONL 三通道兜底在 sniffFormat 骨架内）；
  // 需交互字段映射，无粘贴/直解通道（导入页映射页分支显式处理）
  generic: {},
}

/** 注册表键序数组（= 嗅探优先序）；sniffFormat 通道遍历与顺序契约测试共用 */
export const IMPORT_FORMATS: readonly ImportFormat[] = IMPORT_FORMAT_ORDER

// 嗅探通道序列：按注册表键序过滤出各通道有特征谓词的格式（模块级派生一次）
const OBJECT_SNIFF_FORMATS = IMPORT_FORMATS.filter((f) => IMPORT_REGISTRY[f].sniffObject !== undefined)
const ARRAY_SNIFF_FORMATS = IMPORT_FORMATS.filter((f) => IMPORT_REGISTRY[f].sniffArray !== undefined)
const TEXT_SNIFF_FORMATS = IMPORT_FORMATS.filter((f) => IMPORT_REGISTRY[f].sniffText !== undefined)

/**
 * 格式嗅探：骨架只承载输入形态分通道（JSON 对象 → JSON 数组 → JSONL → 文本正则），
 * 格式特征判定查 IMPORT_REGISTRY，通道内依注册表键序返回首个命中。
 * 注：Ente 明文导出即 otpauth URI 行（EnteAuthImporter 委托 GoogleAuthUriImporter），落入
 * uriBatch，不设独立判定；Ente 加密导出与未知 JSON 无可靠嗅探特征，留给手动选择
 * （手动选 uriBatch 时由其内建特征检测给出明确加密报错）。
 * TOTP Authenticator 外部分享为纯 base64 密文，与任意文本无可靠区分特征，不强判（手动选择）。
 * Authenticator Plus 导出为 WinZip AES 加密 zip（二进制），文本嗅探不适用——入口为
 * ImportCard 手动选择「Authenticator Plus」+ readImportFileBytes 字节通道，不加入嗅探。
 */
export function sniffFormat(text: string): ImportFormat | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 1. JSON 对象族：parse 失败继续后续判定（可能是 JSONL）；parse 成功无特征键 → generic 兜底
  if (trimmed.startsWith('{')) {
    const obj = parseJsonObjectText(trimmed)
    if (obj) {
      for (const f of OBJECT_SNIFF_FORMATS) {
        if (IMPORT_REGISTRY[f].sniffObject!(obj)) return f
      }
      return 'generic'
    }
  }

  // 2. JSON 数组族（数组特征 App 格式优先）：parse 失败继续按行判定
  if (trimmed.startsWith('[')) {
    let rows: unknown[] | null = null
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) rows = parsed
    } catch {
      // 继续按行判定
    }
    if (rows) {
      for (const f of ARRAY_SNIFF_FORMATS) {
        if (IMPORT_REGISTRY[f].sniffArray!(rows)) return f
      }
      return 'generic'
    }
  }

  // 3. JSONL（每行均可解析；多行，或单行且为对象——单行对象已在 1 判定）
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

  // 4. 文本族（winauth → freeOtpLegacy → uriBatch，依注册表键序）
  for (const f of TEXT_SNIFF_FORMATS) {
    if (IMPORT_REGISTRY[f].sniffText!(trimmed)) return f
  }

  return null
}

/**
 * 两端口令判定统一入口（粘贴通道 + 导入页）：按格式查注册表 needsPassword 内容谓词。
 * 未登记谓词的格式恒 false（不存在两态路由）；谓词必须基于文本内容（见描述符注释）。
 */
export function needsPasswordFor(format: ImportFormat, text: string): boolean {
  return IMPORT_REGISTRY[format].needsPassword?.(text) ?? false
}
