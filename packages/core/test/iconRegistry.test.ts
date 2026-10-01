import { describe, expect, it } from 'vitest'
import builtinData from '../src/icons/builtin.json'
import { getBuiltinIcons, normalizeIssuer, recommendBuiltinIcon, suggestIcons } from '../src/icons/registry'

describe('iconRegistry', () => {
  it('内置集 ≥64 且 GitHub path 非空', () => {
    const all = getBuiltinIcons()
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(64)
    expect(all['github']!.path).toMatch(/^M/)
    expect(all['github']!.title).toBe('GitHub')
  })
  it('normalizeIssuer', () => {
    expect(normalizeIssuer('GitHub Inc.')).toBe('githubinc')
    expect(normalizeIssuer('  Steam-Chat ')).toBe('steamchat')
    // 多连续分隔符（空白/点/连字符/下划线混排）折叠为空
    expect(normalizeIssuer('Git--Hub__..X  Y')).toBe('githubxy')
  })
  it('推荐：精确/别名/大小写', () => {
    expect(recommendBuiltinIcon('GitHub')!.id).toBe('github')
    expect(recommendBuiltinIcon('github.com')!.id).toBe('github')
    expect(recommendBuiltinIcon('谷歌')!.id).toBe('google')
    expect(recommendBuiltinIcon('不存在的服务')).toBeNull()
  })
  it('推荐：normalize 后为空（纯分隔符输入）→ null', () => {
    expect(recommendBuiltinIcon('   .-_ ')).toBeNull()
    expect(recommendBuiltinIcon('')).toBeNull()
  })
  it('suggestIcons 前缀包含', () => {
    const s = suggestIcons('git', 5)
    expect(s.length).toBeGreaterThan(0)
    expect(s.every((i) => normalizeIssuer(i.id).includes('git') || normalizeIssuer(i.title).includes('git'))).toBe(true)
  })
  it('suggestIcons：limit 参数生效、空 key 返回空数组', () => {
    const all = suggestIcons('git')
    expect(all).toHaveLength(5) // 默认 limit=5
    expect(suggestIcons('git', 2)).toHaveLength(2)
    expect(suggestIcons('git', 100).length).toBeGreaterThanOrEqual(all.length)
    expect(suggestIcons(' .-_ ')).toEqual([])
    expect(suggestIcons('')).toEqual([])
  })
  it('suggestIcons 模糊：拼写错误按莱文斯坦距离纠错', () => {
    // github 距离 1；'githb' 反向包含 'git'（距离恰为长度差 2）仍排在纠错结果之后
    expect(suggestIcons('githb').map((i) => i.id)).toEqual(['github', 'git'])
    expect(suggestIcons('gtihub').map((i) => i.id)).toEqual(['github']) // h/t 换位，距离 2
  })
  it('suggestIcons 模糊：精确命中置顶，同缀候选按距离/字母序', () => {
    // 距离：git 0、gitea/gitee 2、github/gitlab 3，同距按 id 字母序
    expect(suggestIcons('git', 5).map((i) => i.id)).toEqual(['git', 'gitea', 'gitee', 'github', 'gitlab'])
  })
  it('suggestIcons 模糊：中文别名精确与近似', () => {
    expect(suggestIcons('谷歌')[0]!.id).toBe('google')
    expect(suggestIcons('谷狗')[0]!.id).toBe('google') // 谷歌 距离 1
    expect(suggestIcons('哔哩')[0]!.id).toBe('bilibili') // 哔哩哔哩 子串包含
  })
  it('推荐：悬空别名（别名指向不存在的图标 id）防御性返回 null', () => {
    const aliases = builtinData.aliases as Record<string, string>
    // 键须不含空白/点/连字符/下划线（normalizeIssuer 会折叠分隔符，导致查不到该别名）
    aliases['zzdanglingalias'] = '__no_such_icon__'
    try {
      expect(recommendBuiltinIcon('zzDanglingAlias')).toBeNull()
    } finally {
      delete aliases['zzdanglingalias']
    }
  })
})

describe('builtin icons 扩充回归', () => {
  it('扩充后不少于 200 项且结构合法', () => {
    const entries = Object.entries(getBuiltinIcons())
    // 阈值为写死的保守下界：当前实际 218 项（候选过滤上游已下架 slug 后），上游继续移除品牌时不应轻易击穿
    expect(entries.length).toBeGreaterThanOrEqual(200)
    for (const [, v] of entries) {
      expect(typeof v.path).toBe('string')
      // simple-icons path 可能以小写 m（相对 moveto）开头，均为合法 SVG path
      expect(v.path).toMatch(/^m/i)
    }
  })

  it('高频 issuer 推荐命中不下降', () => {
    for (const issuer of ['GitHub', 'Google', 'Cloudflare', 'Discord', 'Bilibili', 'Steam', 'Bitwarden']) {
      expect(recommendBuiltinIcon(issuer)).not.toBeNull()
    }
  })

  it('别名无悬空引用：所有别名值都存在于内置图标集', () => {
    const data = builtinData as { icons: Record<string, unknown>; aliases: Record<string, string> }
    for (const [alias, id] of Object.entries(data.aliases)) {
      expect(id in data.icons, `别名 ${alias} 悬空指向不存在的图标 id: ${id}`).toBe(true)
    }
  })
})
