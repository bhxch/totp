import { describe, expect, it } from 'vitest'
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
  })
  it('推荐：精确/别名/大小写', () => {
    expect(recommendBuiltinIcon('GitHub')!.id).toBe('github')
    expect(recommendBuiltinIcon('github.com')!.id).toBe('github')
    expect(recommendBuiltinIcon('谷歌')!.id).toBe('google')
    expect(recommendBuiltinIcon('不存在的服务')).toBeNull()
  })
  it('suggestIcons 前缀包含', () => {
    const s = suggestIcons('git', 5)
    expect(s.length).toBeGreaterThan(0)
    expect(s.every((i) => normalizeIssuer(i.id).includes('git') || normalizeIssuer(i.title).includes('git'))).toBe(true)
  })
})
