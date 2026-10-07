import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/theme/tokens.css'), 'utf8')

describe('MD3 token 体系完整性（spec §2.8）', () => {
  it('typescale 补齐 4 档', () => {
    for (const k of ['label-large:14px', 'title-small:14px', 'title-large:22px', 'headline-small:24px']) {
      expect(css).toContain(`--md-sys-typescale-${k}`)
    }
  })
  it('background/on-background role 存在（MiniApp 断链修复）', () => {
    expect(css).toMatch(/--md-sys-color-background:#/)
    expect(css).toMatch(/--md-sys-color-on-background:#/)
    // dark 块内也要有（background 是 mode 相关色）
    expect(css).toContain('--md-sys-color-surface:#1b1b1f') // dark 兜底块 sanity
  })
  it('shape token 系存在', () => {
    for (const k of ['extra-small:4px', 'small:8px', 'medium:12px', 'large:16px', 'extra-large:28px', 'full:9999px']) {
      expect(css).toContain(`--md-sys-shape-corner-${k}`)
    }
  })
  it('state-layer token 存在', () => {
    expect(css).toContain('--md-sys-state-layer-hover:8%')
    expect(css).toContain('--md-sys-state-layer-pressed:12%')
  })
})
