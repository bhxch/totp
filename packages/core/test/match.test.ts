import { describe, expect, it } from 'vitest'
import {
  baseUrlOf,
  entryMatchesUrl,
  hasNestedQuantifierRisk,
  isSafeRegexPattern,
  urlMatches,
  type MatchRule,
} from '../src/match/engine'

const rule = (strategy: MatchRule['strategy'], pattern: string): MatchRule => ({ strategy, pattern })

describe('baseUrlOf', () => {
  it.each([
    ['github.com', 'github.com'],
    ['api.github.com', 'github.com'],
    ['gist.github.com', 'github.com'],
    ['accounts.google.co.uk', 'google.co.uk'], // 例外表三段
    ['deep.sub.example.com.cn', 'example.com.cn'],
    ['localhost', 'localhost'],
    ['192.168.1.1', '192.168.1.1'], // IP 原样
    ['GitHub.COM', 'github.com'], // 小写化
  ])('%s → %s', (host, expected) => {
    expect(baseUrlOf(host)).toBe(expected)
  })

  it('I38：IPv6 主机（含括号）原样返回，不按段切分', () => {
    expect(baseUrlOf('[::1]')).toBe('[::1]')
    expect(baseUrlOf('[2001:db8::1]')).toBe('[2001:db8::1]')
  })
})

describe('urlMatches 五策略', () => {
  const url = 'https://gist.github.com/user?x=1#frag'
  it('baseDomain：子域命中，基域名不等不命中', () => {
    expect(urlMatches(url, rule('baseDomain', 'github.com'))).toBe(true)
    expect(urlMatches(url, rule('baseDomain', 'gitlab.com'))).toBe(false)
    expect(urlMatches(url, rule('baseDomain', 'https://gist.github.com/x'))).toBe(true) // pattern 先取 host
  })
  it('host：完整 host 相等（含端口），子域不命中', () => {
    expect(urlMatches('https://github.com/a', rule('host', 'github.com'))).toBe(true)
    expect(urlMatches(url, rule('host', 'github.com'))).toBe(false)
    expect(urlMatches('https://localhost:8080/x', rule('host', 'localhost:8080'))).toBe(true)
  })
  it('exact：整 URL 相等（忽略首尾空白），其余不命中', () => {
    expect(urlMatches(' https://a.com/p ', rule('exact', 'https://a.com/p'))).toBe(true)
    expect(urlMatches('https://a.com/p2', rule('exact', 'https://a.com/p'))).toBe(false)
  })
  it('startsWith：字符串前缀', () => {
    expect(urlMatches('https://a.com/p/1', rule('startsWith', 'https://a.com/p'))).toBe(true)
    expect(urlMatches('https://a.com/q/1', rule('startsWith', 'https://a.com/p'))).toBe(false)
  })
  it('regex：合法正则 test；非法正则 false 不抛', () => {
    expect(urlMatches('https://mail.a.com/x', rule('regex', '^https://mail\\.'))).toBe(true)
    expect(urlMatches('https://a.com/x', rule('regex', 'b(c'))).toBe(false)
  })
  it('URL 解析失败一律 false', () => {
    expect(urlMatches('not a url', rule('baseDomain', 'a.com'))).toBe(false)
  })
})

describe('entryMatchesUrl', () => {
  it('无规则/空规则不命中', () => {
    expect(entryMatchesUrl({}, 'https://a.com')).toBe(false)
    expect(entryMatchesUrl({ matchRules: [] }, 'https://a.com')).toBe(false)
  })
  it('任一规则命中即命中', () => {
    const e = { matchRules: [rule('host', 'x.com'), rule('baseDomain', 'y.com')] }
    expect(entryMatchesUrl(e, 'https://sub.y.com/z')).toBe(true)
    expect(entryMatchesUrl(e, 'https://z.com/z')).toBe(false)
  })
})

describe('F13：hasNestedQuantifierRisk 嵌套量词保守筛查', () => {
  it.each([
    ['(a+)+$', true],
    ['((a+))+', true],
    ['(?:\\d+)+x', true],
    ['(a{2,4})+b', true],
    ['((a+)b?)+', true],
    ['(?=a+)+', true],
  ])('%s → 有风险', (p, expected) => {
    expect(hasNestedQuantifierRisk(p)).toBe(expected)
  })
  it.each([
    ['^https://github\\.com/.*', '常见 URL 匹配'],
    ['(?:\\d{1,3}\\.){3}\\d{1,3}', 'IPv4 形态（组体末尾为字面量）'],
    ['(sub\\.)?example\\.com', '可选字面量组'],
    ['[a-z]+', '字符类内量词'],
    ['\\d+(?:\\.\\d+)?', '有界可选组'],
    ['(a+)?', '? 为有界量词不计风险'],
    ['a+literal)+', '不成对括号按字面量，不误报'],
  ])('%s → 安全（%s）', (p) => {
    expect(hasNestedQuantifierRisk(p)).toBe(false)
  })
})

describe('F13：isSafeRegexPattern', () => {
  it('安全 pattern 放行', () => {
    expect(isSafeRegexPattern('^https://mail\\.')).toBe(true)
    expect(isSafeRegexPattern('  ')).toBe(false)
  })
  it('长度超 256 / 嵌套量词拒绝', () => {
    expect(isSafeRegexPattern('a'.repeat(257))).toBe(false)
    expect(isSafeRegexPattern('(a+)+$')).toBe(false)
  })
})

describe('F13：urlMatches 引擎边界兜底（覆盖同步通道）', () => {
  it('不安全 regex 规则一律不执行，返回 false', () => {
    expect(urlMatches('https://a.com/x', rule('regex', '(a+)+$'))).toBe(false)
    expect(urlMatches('https://a.com/x', rule('regex', 'a'.repeat(300)))).toBe(false)
    expect(urlMatches('https://a.com/x', rule('regex', 'b(c'))).toBe(false)
  })
  it('安全 regex 规则照常命中（含缓存后二次求值）', () => {
    expect(urlMatches('https://mail.a.com/x', rule('regex', '^https://mail\\.'))).toBe(true)
    expect(urlMatches('https://mail.a.com/y', rule('regex', '^https://mail\\.'))).toBe(true)
  })
  it('混入不安全 regex 规则不影响其他规则命中', () => {
    const e = { matchRules: [rule('regex', '(a+)+$'), rule('baseDomain', 'y.com')] }
    expect(entryMatchesUrl(e, 'https://sub.y.com/z')).toBe(true)
  })
  it('regex 输入超 2048 fail-closed：不求值、一律不命中（含前缀本可命中的规则）', () => {
    const over = 'https://a.com/' + 'x'.repeat(3000)
    expect(over.length).toBeGreaterThan(2048)
    // 前缀匹配形态规则：截断求值会误命中（hit 翻转），fail-closed 必须为 false
    expect(urlMatches(over, rule('regex', '^https://a\\.com/x+$'))).toBe(false)
    expect(urlMatches(over, rule('regex', '^https://a\\.com/x{3000}$'))).toBe(false)
  })
  it('regex 输入 ≤2048 行为不变：恰在 2048 边界仍求值', () => {
    const boundary = 'https://a.com/' + 'x'.repeat(2034)
    expect(boundary.length).toBe(2048)
    expect(urlMatches(boundary, rule('regex', '^https://a\\.com/x+$'))).toBe(true)
    const over = boundary + 'x' // 2049：立即 fail-closed
    expect(urlMatches(over, rule('regex', '^https://a\\.com/x+$'))).toBe(false)
  })
  it('尾锚定规则 + 垫长 URL 不因截断翻转（钓鱼误导场景）', () => {
    const tail = rule('regex', '\\.php$')
    const boundary = 'x'.repeat(2044) + '.php' // 锚点恰落在 2048 边界：本就命中
    expect(urlMatches(boundary, tail)).toBe(true)
    const padded = boundary + 'y'.repeat(100) // 完整 URL 不以 .php 结尾；截断求值会把锚点垫进前 2048 字符而误命中
    expect(padded.length).toBeGreaterThan(2048)
    expect(urlMatches(padded, tail)).toBe(false)
  })
  it('非 regex strategy 不受 URL 长度限制（纯字符串比较无回溯）', () => {
    const long = 'https://work.com/' + 'y'.repeat(3000)
    expect(urlMatches(long, rule('startsWith', 'https://work.com/'))).toBe(true)
    expect(urlMatches(long, rule('host', 'work.com'))).toBe(true)
  })
})
