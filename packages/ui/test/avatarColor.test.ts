import { avatarStyleOf } from '../src/components/avatarColor'
import { describe, expect, it } from 'vitest'

describe('avatarStyleOf', () => {
  it('同 issuer 稳定，异 issuer 有分布（10 色哈希桶）', () => {
    expect(avatarStyleOf('GitHub')).toEqual(avatarStyleOf('GitHub'))
    const set = new Set(['GitHub', 'GitLab', 'Google', 'Amazon', 'Steam', '微信', 'Discord', 'Stripe', 'Cloudflare', 'Baidu', 'Twitter'].map((s) => avatarStyleOf(s)!.background))
    expect(set.size).toBeGreaterThan(3)
  })
  it('空白 issuer 返回 null（保留默认样式）', () => {
    expect(avatarStyleOf('')).toBeNull()
    expect(avatarStyleOf('   ')).toBeNull()
  })
  it('产出含 color-mix 与具体色值', () => {
    const s = avatarStyleOf('GitHub')!
    expect(s.background).toMatch(/^color-mix\(in srgb, #/)
    expect(s.color).toMatch(/^color-mix\(in srgb, #/)
  })
})
