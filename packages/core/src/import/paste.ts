import { IMPORT_REGISTRY, needsPasswordFor, sniffFormat, type ImportFormat } from './registry'
import type { ImportResult } from './types'

// 粘贴通道（R5 起由注册表派生）：可解析白名单即 IMPORT_REGISTRY 各条目的 paste 槽（同步
// 明文实现；parsePastedText 为同步契约），本文件不再维护格式→parser 分派表。generic 需交互
// 映射、winauth 为文件惯例，无 paste 槽，以引导文案拦截；两态格式（加密 aegis / foxauth
// 加密态 / 密文 totpAuthenticator）由 needsPasswordFor 内容谓词统一拦截引导口令通道——
// totpAuthenticator 谓词（非 '[' 开头）在本通道恒 false：sniffFormat 仅对明文 JSON 数组判
// totpAuthenticator（外部分享密文无可靠特征不强判，落到「无法识别」）。

/** 有 paste 通道但命中口令谓词时的引导文案（按格式区分现状两文案；新登记两态格式时补格） */
const PASTE_PASSWORD_GUIDE: Partial<Record<ImportFormat, string>> = {
  aegis: '加密 Aegis 文件请走导入页（需输入口令）',
  foxauth: '加密 FoxAuth 备份请走导入页（需输入口令）',
}

/** 无 paste 通道格式的引导文案（格式差异真实存在：映射交互 vs 文件惯例） */
const PASTE_GUIDE: Partial<Record<ImportFormat, string>> = {
  generic: '通用 JSON 请走导入页配置字段映射',
  winauth: 'WinAuth 请在导入页选择文件导入',
}

export type PasteParseResult = ImportResult | { unsupported: string }

export function parsePastedText(text: string): PasteParseResult {
  const fmt = sniffFormat(text)
  if (fmt === null) return { unsupported: '无法识别粘贴内容格式' }
  const descriptor = IMPORT_REGISTRY[fmt]
  if (descriptor.paste) {
    // 两端口令判定统一派生：内容谓词命中 → 引导导入页口令通道（不走明文解析）
    if (needsPasswordFor(fmt, text)) {
      return { unsupported: PASTE_PASSWORD_GUIDE[fmt] ?? '加密备份请走导入页（需输入口令）' }
    }
    return descriptor.paste(text)
  }
  return { unsupported: PASTE_GUIDE[fmt] ?? '无法识别粘贴内容格式' }
}
