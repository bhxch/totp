import { sniffAegis, sniffFormat } from './sniff'
import { importAegisPlaintext } from './aegis'
import { importAndOtp, importFreeOtp, importFreeOtpLegacy, importTotpAuthenticatorPlaintext } from './miscApps'
import { importBitwarden, importProton, importStratum, importTwoFas } from './jsonApps'
import { importUriBatch } from './uriBatch'
import type { ImportFormat, ImportResult } from './types'

// 粘贴场景白名单（spec 批② C0）：文本可直接解析的格式。generic 需交互映射、winauth 为文件惯例、
// aegis 加密需口令页——三者引导走导入页，不在此强解。
// totpAuthenticator 走同步明文解析：sniffFormat 仅对明文 JSON 数组判 totpAuthenticator
// （外部分享为纯 base64 密文，无可靠特征不强判），口令解密路径仍归导入页；
// importTotpAuthenticator 因加密分支依赖 WebCrypto 为 async，不满足本分发的同步契约。
const DISPATCH: Partial<Record<ImportFormat, (text: string) => ImportResult>> = {
  uriBatch: importUriBatch,
  aegis: importAegisPlaintext,
  andOtp: importAndOtp,
  twoFas: importTwoFas,
  bitwarden: importBitwarden,
  proton: importProton,
  stratum: importStratum,
  freeOtp: importFreeOtp,
  freeOtpLegacy: importFreeOtpLegacy,
  totpAuthenticator: importTotpAuthenticatorPlaintext,
}

export type PasteParseResult = ImportResult | { unsupported: string }

export function parsePastedText(text: string): PasteParseResult {
  const fmt = sniffFormat(text)
  if (fmt === null) return { unsupported: '无法识别粘贴内容格式' }
  if (fmt === 'aegis' && sniffAegis(text)?.encrypted === true) {
    return { unsupported: '加密 Aegis 文件请走导入页（需输入口令）' }
  }
  if (fmt === 'generic') return { unsupported: '通用 JSON 请走导入页配置字段映射' }
  if (fmt === 'winauth') return { unsupported: 'WinAuth 请在导入页选择文件导入' }
  const parse = DISPATCH[fmt]
  if (!parse) return { unsupported: '无法识别粘贴内容格式' }
  return parse(text)
}
