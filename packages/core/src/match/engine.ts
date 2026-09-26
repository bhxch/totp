import type { OtpEntry } from '../model'
import { isSafeRegexPattern } from './regexSafety'

// R16②：正则安全器（MAX_MATCH_PATTERN_LENGTH/hasNestedQuantifierRisk/isSafeRegexPattern）
// 纯拆至 './regexSafety'，此处 `export *` 再导出——'@totp/core' 顶层导入面（parseVaultJson/
// entryForm 消费）与既有深路径导入（storage/vaultStore 等）均不变
export * from './regexSafety'

// 常见二级域例外表：末两段命中时基域名取末三段（Bitwarden 同款简化语义）
const SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'co.jp', 'ne.jp', 'or.jp',
  'com.au', 'net.au', 'org.au', 'co.nz',
  'com.br', 'com.mx', 'co.in', 'co.kr', 'com.tw', 'com.hk', 'com.sg', 'com.tr',
])

export type MatchStrategy = 'baseDomain' | 'host' | 'exact' | 'startsWith' | 'regex'

export interface MatchRule {
  strategy: MatchStrategy
  pattern: string
}

// F13：matchRules 限额常量——恢复校验（parseVaultJson）与引擎边界兜底共用
// （MAX_MATCH_PATTERN_LENGTH 属 pattern 安全检查，已随 R16② 落 regexSafety.ts 并经上方 export * 再导出）
export const MATCH_STRATEGIES: readonly MatchStrategy[] = ['baseDomain', 'host', 'exact', 'startsWith', 'regex']
/** 每条目规则数上限 */
export const MAX_MATCH_RULES = 8
/** regex 求值输入长度上限：URL 超过该长度时 regex 规则一律不命中（fail-closed，不求值）。
 *  其余 strategy 纯字符串比较无回溯，不受此限。 */
export const MAX_REGEX_INPUT_LENGTH = 2048

export function baseUrlOf(host: string): string {
  const h = host.toLowerCase()
  // IPv6 主机形如 [::1] 或 [::1]:8080；url.host 含端口时由调用方先剥离（含括号内的 IPv6）
  // 含 '[' 即 IPv6 字面量，原样返回
  if (h.startsWith('[')) return h
  const parts = h.split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  // IPv4（各段均为数字）原样返回，不当普通多段域名截取
  if (parts.every((p) => /^\d+$/.test(p))) return h
  const lastTwo = parts.slice(-2).join('.')
  if (SECOND_LEVEL.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}

function hostOf(input: string): string {
  try {
    return new URL(input).host
  } catch {
    return ''
  }
}

// pattern 可能是完整 URL 也可能是裸 host：优先按 URL 解析取 host，失败则视为裸 host
function patternHostOf(pattern: string): string {
  return hostOf(pattern) || pattern
}

// F13：正则编译缓存——popup 渲染路径每次打开都对同一批规则重复求值；null 表示不安全/无法编译
const regexCache = new Map<string, RegExp | null>()
const REGEX_CACHE_LIMIT = 256

function compileRegex(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern) ?? null
  let re: RegExp | null = null
  if (isSafeRegexPattern(pattern)) {
    try {
      re = new RegExp(pattern)
    } catch {
      re = null
    }
  }
  if (regexCache.size >= REGEX_CACHE_LIMIT) regexCache.clear()
  regexCache.set(pattern, re)
  return re
}

export function urlMatches(url: string, rule: MatchRule): boolean {
  const pattern = rule.pattern.trim()
  if (!pattern) return false
  switch (rule.strategy) {
    case 'baseDomain': {
      const host = hostOf(url)
      if (!host) return false
      return baseUrlOf(host) === baseUrlOf(patternHostOf(pattern))
    }
    case 'host': {
      const host = hostOf(url)
      return host !== '' && host.toLowerCase() === pattern.toLowerCase()
    }
    case 'exact':
      return url.trim() === pattern
    case 'startsWith':
      return url.startsWith(pattern)
    case 'regex': {
      // F13：引擎边界兜底——同步/旧 vault 通道可能未经 parseVaultJson 校验，不安全 pattern（超长/
      // 嵌套量词回溯形态/无法编译）一律不执行。残留见 hasNestedQuantifierRisk。
      // URL 超长时 fail-closed 直接不命中：截断求值会构造合成前缀，尾锚定规则（如 \.php$）
      // 可被攻击者把锚点垫到截断点从 miss 翻转为 hit，误导 popup 的匹配条目展示。
      if (url.length > MAX_REGEX_INPUT_LENGTH) return false
      const re = compileRegex(pattern)
      if (!re) return false
      return re.test(url)
    }
  }
}

export function entryMatchesUrl(entry: Pick<OtpEntry, 'matchRules'>, url: string): boolean {
  const rules = entry.matchRules
  if (!rules || rules.length === 0) return false
  return rules.some((r) => urlMatches(url, r))
}
