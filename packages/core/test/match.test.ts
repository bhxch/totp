import { describe, expect, it } from 'vitest'
import { baseUrlOf, entryMatchesUrl, urlMatches, type MatchRule } from '../src/match/engine'

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
