import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/theme/tokens.css'), 'utf8')

// M3 字阶尺寸档(与 generate.mjs TYPESCALE 同源):mode 无关,恒载 :root;code-large 为项目自定义档
const TYPESCALE = [
  ['--md-sys-typescale-title-medium', '16px'],
  ['--md-sys-typescale-body-large', '16px'],
  ['--md-sys-typescale-body-medium', '14px'],
  ['--md-sys-typescale-body-small', '12px'],
  ['--md-sys-typescale-label-medium', '12px'],
  ['--md-sys-typescale-label-small', '11px'],
  ['--md-sys-typescale-code-large', '18px'],
] as const

describe('tokens.css 字阶 typescale 恒载块', () => {
  it(':root 选择器存在', () => {
    expect(css).toMatch(/:root\s*\{/)
  })
  it('7 个字阶变量齐全且值正确', () => {
    for (const [name, value] of TYPESCALE) {
      expect(css, name).toContain(`${name}:${value}`)
    }
  })
  it('字阶变量在 :root 块内(不随 data-mode/data-color 变化)', () => {
    const block = css.match(/:root\s*\{([^}]*)\}/)
    expect(block, ':root 块缺失').toBeTruthy()
    for (const [name] of TYPESCALE) {
      expect(block![1], name).toContain(name)
    }
  })
})
