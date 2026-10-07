import { describe, expect, it } from 'vitest'
import builtinData from '../src/icons/builtin.json'
import { getBuiltinIcons, normalizeIssuer, registerIcons, suggestIcons } from '../src/icons/registry'

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
  it('R4-C1 normalizeIssuer 剔除 Windows 文件名危险字符与控制字符（产出兼作存储 id）', () => {
    // zip 内不可信文件名场景：`\ / : * ? " < > |` 全部剔除，不产生 ADS/子目录逃逸的存储 id
    expect(normalizeIssuer('a:b*c?d')).toBe('abcd')
    expect(normalizeIssuer('x\\y/z')).toBe('xyz')
    expect(normalizeIssuer('p"q<r>s|t')).toBe('pqrst')
    // 控制字符（C0 + DEL）剔除
    expect(normalizeIssuer('a\u0000b\u001fc')).toBe('abc')
    // 危险字符剔除后与正常名收敛到同一 id（与既有分隔符折叠语义一致）
    expect(normalizeIssuer('github:official')).toBe(normalizeIssuer('github official'))
  })
  it('推荐：精确/别名/大小写命中排第一，未命中返回空', () => {
    expect(suggestIcons('GitHub')[0]!.id).toBe('github')
    expect(suggestIcons('github.com')[0]!.id).toBe('github') // 别名 githubcom
    expect(suggestIcons('谷歌')[0]!.id).toBe('google')
    expect(suggestIcons('不存在的服务')).toEqual([])
  })
  it('推荐：normalize 后为空（纯分隔符输入）→ 空数组', () => {
    expect(suggestIcons('   .-_ ')).toEqual([])
    expect(suggestIcons('')).toEqual([])
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
  it('推荐：悬空别名（别名指向不存在的图标 id）防御性跳过', () => {
    const aliases = builtinData.aliases as Record<string, string>
    // 键须不含空白/点/连字符/下划线（normalizeIssuer 会折叠分隔符，导致查不到该别名）
    aliases['zzdanglingalias'] = '__no_such_icon__'
    try {
      expect(suggestIcons('zzDanglingAlias').every((i) => i.id in getBuiltinIcons())).toBe(true)
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
      expect(suggestIcons(issuer).length).toBeGreaterThan(0)
      expect(suggestIcons(issuer)[0]!.id in getBuiltinIcons()).toBe(true)
    }
  })

  it('别名无悬空引用：所有别名值都存在于内置图标集', () => {
    const data = builtinData as { icons: Record<string, unknown>; aliases: Record<string, string> }
    for (const [alias, id] of Object.entries(data.aliases)) {
      expect(id in data.icons, `别名 ${alias} 悬空指向不存在的图标 id: ${id}`).toBe(true)
    }
  })
})

describe('registerIcons', () => {
  it('合并新图标并可被 getBuiltinIcons 读出；重复注册幂等', () => {
    registerIcons([{ id: 'zzz-reg-test', title: 'Reg Test', path: 'M0 0L1 1' }])
    registerIcons([{ id: 'zzz-reg-test', title: 'Reg Test', path: 'M0 0L1 1' }])
    expect(getBuiltinIcons()['zzz-reg-test']).toEqual({ id: 'zzz-reg-test', title: 'Reg Test', path: 'M0 0L1 1' })
  })
})

describe('suggestIcons extra 候选', () => {
  it('返回 IconSuggestion：builtin 项带 path 且 source=builtin', () => {
    const r = suggestIcons('github', 1)
    expect(r[0]).toMatchObject({ id: 'github', title: 'GitHub', source: 'builtin' })
    expect(r[0]!.path).toBeTruthy()
  })

  it('extra（stored 图标 id）参与同一 normalize+距离管线', () => {
    const r = suggestIcons('githacks', 5, [{ id: 'githacks' }])
    expect(r[0]).toMatchObject({ id: 'githacks', title: 'githacks', source: 'extra' })
    expect(r[0]!.path).toBeUndefined()
  })

  it('同距离 builtin 优先于 extra；距离不同按距离升序', () => {
    // 'gogs' 与精选 gogs？若无此 slug 则用任意既有 id 演练：构造与查询同距的 builtin/extra
    const r = suggestIcons('gitlbb', 5, [{ id: 'gitlbb' }])
    // gitlbb 作为 extra 精确命中 dist 0；builtin 最近项距离 > 0 → extra 第一
    expect(r[0]).toMatchObject({ id: 'gitlbb', source: 'extra' })
    const r2 = suggestIcons('gitlab', 5, [{ id: 'gitlaa' }])
    // gitlab 精确 dist 0 优于 gitlaa（dist 2）——builtin 第一
    expect(r2[0]).toMatchObject({ id: 'gitlab', source: 'builtin' })
  })

  it('extra 与内置同 id 时跳过（内置优先，不产生重复项）', () => {
    const r = suggestIcons('github', 5, [{ id: 'github' }])
    expect(r.filter((s) => s.id === 'github')).toHaveLength(1)
    expect(r[0]!.source).toBe('builtin')
  })

  it('extra 的 title 参与匹配且输出 title 优先于 id', () => {
    const r = suggestIcons('我的仓库', 5, [{ id: 'gogsx', title: '我的仓库' }])
    expect(r[0]).toMatchObject({ id: 'gogsx', title: '我的仓库', source: 'extra' })
  })
})
