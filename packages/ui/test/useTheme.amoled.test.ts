import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyThemeAttributes } from '../src/theme/useTheme'
import { describe, expect, it } from 'vitest'

describe('applyThemeAttributes contrast', () => {
  it('写入 data-contrast；缺省 standard 不残留 amoled', () => {
    applyThemeAttributes('dark', 'blue', 'amoled')
    expect(document.documentElement.dataset.contrast).toBe('amoled')
    applyThemeAttributes('dark', 'blue')
    expect(document.documentElement.dataset.contrast).toBe('standard')
  })
})

// jsdom 不应用 CSS：覆盖层变量与选择器结构以源码文本断言（同 themeTokens.test.ts 模式）
describe('amoled.css 覆盖层', () => {
  const css = readFileSync(join(__dirname, '../src/theme/amoled.css'), 'utf8')
  it('dark/auto 双块覆盖全部暗色表面系变量（含 brief 漏项 surface-variant），primary 系不动', () => {
    const surfaceVars = [
      '--md-sys-color-surface', '--md-sys-color-surface-dim', '--md-sys-color-surface-bright',
      '--md-sys-color-surface-container-lowest', '--md-sys-color-surface-container-low',
      '--md-sys-color-surface-container', '--md-sys-color-surface-container-high',
      '--md-sys-color-surface-container-highest', '--md-sys-color-surface-variant',
      '--md-sys-color-outline-variant',
    ]
    expect(css.match(/html\[data-contrast='amoled'\]\[data-mode='dark'\]/)).toBeTruthy()
    expect(css.match(/html\[data-contrast='amoled'\]\[data-mode='auto'\]/)).toBeTruthy()
    for (const v of surfaceVars) expect(css.split(v + ':').length - 1).toBe(2) // dark 块 + auto 块各一次（含冒号避免前缀误配）
    expect(css).not.toContain('--md-sys-color-primary:')
    expect(css).not.toContain('--md-sys-color-on-surface:')
    expect(css).not.toContain('--md-sys-color-surface-tint:')
  })
})
