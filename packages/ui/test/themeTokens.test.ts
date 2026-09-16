import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { argbFromHex, hexFromArgb, themeFromSourceColor } from '@material/material-color-utilities'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/theme/tokens.css'), 'utf8')
const palettesCss = readFileSync(join(__dirname, '../src/theme/tokens-palettes.css'), 'utf8')
const palettes = JSON.parse(readFileSync(join(__dirname, '../src/theme/palettes.json'), 'utf8')) as { id: string; hex: string }[]

// 35 角色权威清单(与设计文档 §4.3 一致,kebab-case)
const ROLES = ['primary','on-primary','primary-container','on-primary-container',
  'secondary','on-secondary','secondary-container','on-secondary-container',
  'tertiary','on-tertiary','tertiary-container','on-tertiary-container',
  'error','on-error','error-container','on-error-container',
  'surface','on-surface','surface-variant','on-surface-variant',
  'surface-dim','surface-bright','surface-container-lowest','surface-container-low',
  'surface-container','surface-container-high','surface-container-highest','surface-tint',
  'outline','outline-variant','inverse-surface','inverse-on-surface','inverse-primary','shadow','scrim']

const DEFAULT_ID = 'blue'
const nonDefault = palettes.filter((p) => p.id !== DEFAULT_ID)

// 与 generate.mjs 同源的 35 角色期望值重算:经典角色取 scheme.props(camelCase),扩展角色按 M3 surface tone 表派生
const SURFACE_TONES = {
  light: { dim: 87, bright: 98, lowest: 100, low: 96, container: 94, high: 92, highest: 90 },
  dark: { dim: 6, bright: 24, lowest: 4, low: 10, container: 12, high: 17, highest: 22 },
} as const
function expectedRoleValues(hex: string, mode: 'light' | 'dark'): Record<string, string> {
  const theme = themeFromSourceColor(argbFromHex(hex))
  const props = (theme.schemes[mode] as unknown as { props: Record<string, number> }).props
  const neutral = theme.palettes.neutral
  const t = SURFACE_TONES[mode]
  const derived: Record<string, number> = {
    'surface-dim': neutral.tone(t.dim),
    'surface-bright': neutral.tone(t.bright),
    'surface-container-lowest': neutral.tone(t.lowest),
    'surface-container-low': neutral.tone(t.low),
    'surface-container': neutral.tone(t.container),
    'surface-container-high': neutral.tone(t.high),
    'surface-container-highest': neutral.tone(t.highest),
    'surface-tint': theme.palettes.primary.tone(mode === 'light' ? 40 : 80),
  }
  const out: Record<string, string> = {}
  for (const role of ROLES) {
    const argb = derived[role] ?? props[role.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())]!
    out[role] = hexFromArgb(argb).toLowerCase()
  }
  return out
}

describe('tokens.css 产物(base 恒载,无 [data-color] 限定的兜底块)', () => {
  it('不含任何 [data-color] 选择器块(默认种子即兜底;仅头注释可提及)', () => {
    expect(css).not.toMatch(/\[data-color="\w+"\]/)
  })
  it('color-scheme 4 声明齐全', () => {
    expect(css).toMatch(/\[data-mode="light"\]\s*\{\s*color-scheme:\s*light\s*\}/)
    expect(css).toMatch(/\[data-mode="dark"\]\s*\{\s*color-scheme:\s*dark\s*\}/)
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*\[data-mode="auto"\]\s*\{\s*color-scheme:\s*light\s*\}\s*\}/)
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*\[data-mode="auto"\]\s*\{\s*color-scheme:\s*dark\s*\}\s*\}/)
  })
  it('light/dark 无色限定块 × 35 角色齐全', () => {
    for (const mode of ['light', 'dark']) {
      // 以 --md-sys-color 开头锚定变量块,避开同选择器的 color-scheme 单行块
      const block = css.match(new RegExp(`\\[data-mode="${mode}"\\]\\s*\\{\\s*(--md-sys-color[^}]*)\\}`))
      expect(block, `${mode} 变量块缺失`).toBeTruthy()
      for (const role of ROLES) {
        expect(block![1], `${mode}/${role}`).toMatch(new RegExp(`--md-sys-color-${role}:\\s*#\\w{6}`))
      }
    }
  })
  it('auto 模式经 prefers-color-scheme 两段 media 覆盖', () => {
    const m = css.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{[^@]*\[data-mode="auto"\]\s*\{\s*--md-sys-color/)
    expect(m, 'auto-light 变量块缺失').toBeTruthy()
    const d = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[^@]*\[data-mode="auto"\]\s*\{\s*--md-sys-color/)
    expect(d, 'auto-dark 变量块缺失').toBeTruthy()
  })
  it('兜底块值 = blue 种子重算值(35 角色逐角色等值,light/dark)', () => {
    const blueHex = palettes.find((p) => p.id === DEFAULT_ID)!.hex
    for (const mode of ['light', 'dark'] as const) {
      // 以 --md-sys-color 开头锚定变量块,避开同选择器的 color-scheme 单行块
      const block = css.match(new RegExp(`\\[data-mode="${mode}"\\]\\s*\\{\\s*(--md-sys-color[^}]*)\\}`))
      expect(block, `${mode} 变量块缺失`).toBeTruthy()
      for (const [role, expected] of Object.entries(expectedRoleValues(blueHex, mode))) {
        const got = block![1]!.match(new RegExp(`--md-sys-color-${role}:\\s*(#\\w{6})`))!
        expect(got[1]!.toLowerCase(), `${mode}/${role}`).toBe(expected)
      }
    }
  })
  it('头注释含特异度说明', () => {
    expect(css).toMatch(/特异度/)
  })
})

describe('tokens-palettes.css 产物(9 非默认种子懒载)', () => {
  it('不含 blue(blue 由 base 兜底,专属块已删)', () => {
    expect(palettesCss).not.toMatch(/\[data-color="blue"\]/)
  })
  it('9 种子 × light/dark × 35 角色齐全', () => {
    expect(nonDefault).toHaveLength(9)
    for (const p of nonDefault) {
      for (const mode of ['light', 'dark']) {
        const block = palettesCss.match(new RegExp(`\\[data-color="${p.id}"\\]\\[data-mode="${mode}"\\]\\s*\\{([^}]*)\\}`))
        expect(block, `${p.id}/${mode} 块缺失`).toBeTruthy()
        for (const role of ROLES) {
          expect(block![1], `${p.id}/${mode}/${role}`).toMatch(new RegExp(`--md-sys-color-${role}:\\s*#\\w{6}`))
        }
      }
    }
  })
  it('auto 模式经 prefers-color-scheme 两段 media 覆盖每种子', () => {
    for (const p of nonDefault) {
      const m = palettesCss.match(new RegExp(`@media\\s*\\(prefers-color-scheme:\\s*light\\)\\s*\\{[^@]*\\[data-color="${p.id}"\\]\\[data-mode="auto"\\]\\s*\\{`))
      expect(m, `${p.id} auto-light 缺失`).toBeTruthy()
      const d = palettesCss.match(new RegExp(`@media\\s*\\(prefers-color-scheme:\\s*dark\\)\\s*\\{[^@]*\\[data-color="${p.id}"\\]\\[data-mode="auto"\\]\\s*\\{`))
      expect(d, `${p.id} auto-dark 缺失`).toBeTruthy()
    }
  })
  it('teal/light primary 抽查 = material-color-utilities 重算值;error 全种子一致(跨 base+palettes)', () => {
    const tealHex = palettes.find((p) => p.id === 'teal')!.hex
    const expectPrimary = hexFromArgb(themeFromSourceColor(argbFromHex(tealHex)).schemes.light.primary).toLowerCase()
    const block = palettesCss.match(/\[data-color="teal"\]\[data-mode="light"\]\s*\{([^}]*)\}/)!
    const got = block![1]!.match(/--md-sys-color-primary:\s*(#\w{6})/)![1]!.toLowerCase()
    expect(got).toBe(expectPrimary)
    // error 不随种子变化:base 兜底 + 9 种子在同一 mode 下 error 值全一致(明暗两 mode 的 error 本身允许不同)
    for (const mode of ['light', 'dark']) {
      const errSet = new Set([
        ...css.matchAll(new RegExp(`\\[data-mode="${mode}"\\]\\s*\\{\\s*(--md-sys-color[^}]*)\\}`, 'g')),
        ...palettesCss.matchAll(new RegExp(`\\[data-color="\\w+"\\]\\[data-mode="${mode}"\\]\\s*\\{([^}]*)\\}`, 'g')),
      ].map((b) => b[1]!.match(/--md-sys-color-error:\s*(#\w{6})/)![1]!.toLowerCase()))
      expect(errSet.size, `error 在 ${mode} 下应全种子一致`).toBe(1)
    }
  })
  it('头注释含特异度说明', () => {
    expect(palettesCss).toMatch(/特异度/)
  })
})
