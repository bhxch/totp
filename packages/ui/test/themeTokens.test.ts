import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { argbFromHex, hexFromArgb, themeFromSourceColor } from '@material/material-color-utilities'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/theme/tokens.css'), 'utf8')
const palettes = JSON.parse(readFileSync(join(__dirname, '../src/theme/palettes.json'), 'utf8')) as { id: string; hex: string }[]

// 34 角色权威清单(与设计文档 §4.3 一致,kebab-case)
const ROLES = ['primary','on-primary','primary-container','on-primary-container',
  'secondary','on-secondary','secondary-container','on-secondary-container',
  'tertiary','on-tertiary','tertiary-container','on-tertiary-container',
  'error','on-error','error-container','on-error-container',
  'surface','on-surface','surface-variant','on-surface-variant',
  'surface-dim','surface-bright','surface-container-lowest','surface-container-low',
  'surface-container','surface-container-high','surface-container-highest','surface-tint',
  'outline','outline-variant','inverse-surface','inverse-on-surface','inverse-primary','shadow','scrim']

describe('tokens.css 产物', () => {
  it('每种子 × light/dark × 34 角色齐全', () => {
    for (const p of palettes) {
      for (const mode of ['light', 'dark']) {
        const block = css.match(new RegExp(`\\[data-color="${p.id}"\\]\\[data-mode="${mode}"\\]\\s*\\{([^}]*)\\}`))
        expect(block, `${p.id}/${mode} 块缺失`).toBeTruthy()
        for (const role of ROLES) {
          expect(block![1], `${p.id}/${mode}/${role}`).toMatch(new RegExp(`--md-sys-color-${role}:\\s*#\\w{6}`))
        }
      }
    }
  })
  it('auto 模式经 prefers-color-scheme 两段 media 覆盖每种子', () => {
    for (const p of palettes) {
      const m = css.match(new RegExp(`@media\\s*\\(prefers-color-scheme:\\s*light\\)\\s*\\{[^@]*\\[data-color="${p.id}"\\]\\[data-mode="auto"\\]\\s*\\{`))
      expect(m, `${p.id} auto-light 缺失`).toBeTruthy()
      const d = css.match(new RegExp(`@media\\s*\\(prefers-color-scheme:\\s*dark\\)\\s*\\{[^@]*\\[data-color="${p.id}"\\]\\[data-mode="auto"\\]\\s*\\{`))
      expect(d, `${p.id} auto-dark 缺失`).toBeTruthy()
    }
  })
  it('蓝/浅 primary 抽查 = material-color-utilities 重算值;error 全种子一致', () => {
    const expectPrimary = hexFromArgb(themeFromSourceColor(argbFromHex('#0B57D0')).schemes.light.primary).toLowerCase()
    const block = css.match(/\[data-color="blue"\]\[data-mode="light"\]\s*\{([^}]*)\}/)!
    const got = block![1]!.match(/--md-sys-color-primary:\s*(#\w{6})/)![1]!.toLowerCase()
    expect(got).toBe(expectPrimary)
    const errs = [...css.matchAll(/--md-sys-color-primary:\s*#\w{6}/g)] // 占位防误配:error 用独立断言
    expect(errs.length).toBeGreaterThan(0)
    // error 不随种子变化:同一 mode 下 10 种子的 error 值全一致(明暗两 mode 的 error 本身允许不同)
    for (const mode of ['light', 'dark']) {
      const errSet = new Set([...css.matchAll(new RegExp(`\\[data-color="\\w+"\\]\\[data-mode="${mode}"\\]\\s*\\{([^}]*)\\}`, 'g'))]
        .map((b) => b[1]!.match(/--md-sys-color-error:\s*(#\w{6})/)![1]!.toLowerCase()))
      expect(errSet.size, `error 在 ${mode} 下应全种子一致`).toBe(1)
    }
  })
})
