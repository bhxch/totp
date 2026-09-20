import type { OtpEntry } from '../model'

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
export const MATCH_STRATEGIES: readonly MatchStrategy[] = ['baseDomain', 'host', 'exact', 'startsWith', 'regex']
/** 每条目规则数上限 */
export const MAX_MATCH_RULES = 8
/** 单条 pattern 长度上限 */
export const MAX_MATCH_PATTERN_LENGTH = 256
/** regex 求值输入长度上限：URL 超过该长度时 regex 规则一律不命中（fail-closed，不求值）。
 *  其余 strategy 纯字符串比较无回溯，不受此限。 */
export const MAX_REGEX_INPUT_LENGTH = 2048

/**
 * F13：灾难性回溯保守筛查——识别「组体末尾原子已量词化，组再被量词化」的嵌套量词形态
 * （如 (a+)+、((a+))+、(a{2,4})+）。保守检测：宁可错杀罕见的安全形态（对匹配器可接受）。
 * 已知不覆盖（残留，见 finding F13）：跨支歧义 ((a+|b)+)、同支重叠 ((a|aa)+)、相邻量词 (a+a+)。
 */
export function hasNestedQuantifierRisk(pattern: string): boolean {
  // 栈保存各组开启前的 lastQuantified，闭组后还原父层状态
  const stack: boolean[] = []
  let lastQuantified: boolean = false // 当前分支最后一个原子是否「量词化终止」（自带量词，或是末尾量词化的组）
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '\\') { i += 2; lastQuantified = false; continue } // 转义原子（\+ 等按字面量处理）
    if (c === '[') {
      // 字符类整体视为单原子：类内 + * { 为字面量
      i++
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i++
        i++
      }
      i++
      lastQuantified = false
      continue
    }
    if (c === '(') {
      stack.push(lastQuantified)
      lastQuantified = false
      i++
      // (?: (?= (?! (?<= (?<! (?<name>：跳过引导段
      if (pattern[i] === '?') {
        if (pattern[i + 1] === '<' && pattern[i + 2] !== '=' && pattern[i + 2] !== '!') {
          const gt = pattern.indexOf('>', i + 2)
          if (gt === -1) return false // 形态非法，编译期即失败
          i = gt + 1
        } else {
          i += 2
        }
      }
      continue
    }
    if (c === ')') {
      const inner: boolean = lastQuantified
      const q = quantifierAt(pattern, i + 1)
      if (q.risky && inner) return true // 量词化的组再被（风险类）量词化 → 嵌套量词
      lastQuantified = q.len > 0 ? true : inner
      i = i + 1 + q.len
      continue
    }
    const q = quantifierAt(pattern, i)
    if (q.len > 0) {
      i += q.len
      lastQuantified = true
      continue
    }
    if (c === '|') { lastQuantified = false; i++; continue } // 组体末尾状态由末支决定
    i++
    lastQuantified = false
  }
  return false
}

/** i 处量词 token：len 为长度（0=非量词），risky 表示是否属风险类（+ * 和 {n,m}；有界 ? 不计） */
function quantifierAt(p: string, i: number): { len: number; risky: boolean } {
  const c = p[i]
  if (c === '+' || c === '*') return { len: p[i + 1] === '?' ? 2 : 1, risky: true }
  if (c === '?') return { len: p[i + 1] === '?' ? 2 : 1, risky: false }
  if (c === '{') {
    const m = /^\{\d+(,\d*)?\}/.exec(p.slice(i))
    if (!m) return { len: 0, risky: false } // 不成对 {} 按字面量
    return { len: m[0].length + (p[i + m[0].length] === '?' ? 1 : 0), risky: true }
  }
  return { len: 0, risky: false }
}

/** F13：regex pattern 求值安全检查（恢复校验与引擎边界共用）：长度上限 + 无嵌套量词形态 */
export function isSafeRegexPattern(pattern: string): boolean {
  const p = pattern.trim()
  if (!p || p.length > MAX_MATCH_PATTERN_LENGTH) return false
  return !hasNestedQuantifierRisk(p)
}

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
