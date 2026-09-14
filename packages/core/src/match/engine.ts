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
    case 'regex':
      try {
        return new RegExp(pattern).test(url)
      } catch {
        return false
      }
  }
}

export function entryMatchesUrl(entry: Pick<OtpEntry, 'matchRules'>, url: string): boolean {
  const rules = entry.matchRules
  if (!rules || rules.length === 0) return false
  return rules.some((r) => urlMatches(url, r))
}
