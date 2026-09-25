import { describe, expect, it, vi } from 'vitest'
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
  it('pattern 空/纯空白 → 各策略一律 false（trim 后空串守卫）', () => {
    for (const strategy of ['baseDomain', 'host', 'exact', 'startsWith', 'regex'] as const) {
      expect(urlMatches('https://a.com/x', rule(strategy, ''))).toBe(false)
      expect(urlMatches('https://a.com/x', rule(strategy, '   '))).toBe(false)
    }
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

  it.each([
    ['(?<year>\\d{4})-[a-z]', false, '具名组：跳过 (?<name> 引导段后正常扫描'],
    ['(?<name>a+)+', true, '具名组组体量词化再被量化 → 风险'],
    ['(?<broken', false, '锚定：具名组无闭 > 形态非法（编译期即失败），保守返回安全'],
    ['[a\\]b]+x', false, '字符类内转义 ] 不提前结束类'],
    ['(a+|b)+', false, '锚定：跨支歧义属保守检测已知残留（F13 注释明示不覆盖）'],
    ['(?:a*?)b', false, '惰性 *? 按一个量词 token 消费，组后无量化 → 安全'],
    ['(a+?)+', true, '惰性 +? 仍属风险量词：组体量词化 + 组被量化 → 风险'],
    ['a??b', false, '有界 ? 的惰性形态无风险'],
    ['(a??)+', true, '锚定：有界量词组体 + 组被量化 → 保守判风险'],
    ['a{2,4', false, '非成对 { 按字面量'],
    ['x{,5}', false, '{,5} 非量词语法按字面量'],
    ['(?:a{2,4}?)x', false, '惰性有界量词 {n,m}? 按单 token 消费（含尾随 ?）→ 安全'],
  ])('未测形态 %s → %s（%s）', (p, expected) => {
    expect(hasNestedQuantifierRisk(p)).toBe(expected)
  })
})

describe('F13：regex 编译缓存 256 条上限', () => {
  it('超过 REGEX_CACHE_LIMIT 整体清空重建（Map set 探针观测），淘汰后求值结果仍正确', async () => {
    // 模块级 regexCache 无 reset 钩子：以「重置模块注册表 + 换入计数 Map」的全新模块实例
    // 精确观测淘汰策略（实现为 size>=256 时 clear 后再 set，非 LRU 逐条淘汰）。
    vi.resetModules()
    const sizesAfterSet: number[] = []
    const NativeMap = globalThis.Map
    class SizeProbeMap<K, V> extends NativeMap<K, V> {
      override set(key: K, value: V): this {
        super.set(key, value)
        sizesAfterSet.push(this.size)
        return this
      }
    }
    vi.stubGlobal('Map', SizeProbeMap)
    let engine: typeof import('../src/match/engine')
    try {
      engine = await import('../src/match/engine')
    } finally {
      vi.unstubAllGlobals()
    }
    // 257 个互不相同的安全 pattern：全部应正确命中（编译一次，结果不受缓存策略影响）
    for (let i = 0; i < 257; i++) {
      expect(engine.urlMatches(`https://a${i}.com/x`, { strategy: 'regex', pattern: `a${i}\\.com` })).toBe(true)
    }
    expect(Math.max(...sizesAfterSet)).toBe(256) // 上限恰为 256
    expect(sizesAfterSet[sizesAfterSet.length - 1]).toBe(1) // 第 257 次 set 前 clear，仅剩最新一条
    // 被淘汰的首个 pattern 再次求值：重新编译，结果仍正确
    expect(engine.urlMatches('https://a0.com/y', { strategy: 'regex', pattern: 'a0\\.com' })).toBe(true)
    expect(sizesAfterSet[sizesAfterSet.length - 1]).toBe(2)
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
