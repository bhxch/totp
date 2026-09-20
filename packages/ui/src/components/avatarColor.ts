import { THEME_PALETTES } from '../theme/palette'

/** FNV-1a 32bit：同 issuer 稳定选色；色板来自主题 10 子色（spec 批④ §5） */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

/** 首字母 avatar 多彩取色：trim 后空串返回 null → 沿用 .avatar 默认 primary-container；
 *  background/color 为 color-mix 字符串，由浏览器求值（纯函数只产字符串） */
export function avatarStyleOf(issuer: string): { background: string; color: string } | null {
  const name = issuer.trim()
  if (name === '') return null
  const hex = THEME_PALETTES[fnv1a(name) % THEME_PALETTES.length]!.hex
  return {
    background: `color-mix(in srgb, ${hex} 22%, var(--md-sys-color-surface))`,
    color: `color-mix(in srgb, ${hex} 55%, var(--md-sys-color-on-surface))`,
  }
}
