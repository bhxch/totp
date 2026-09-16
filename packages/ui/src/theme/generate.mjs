// packages/ui/src/theme/generate.mjs — 构建期生成 tokens.css(产物入库,改色板后手动重跑:pnpm --filter @totp/ui theme)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { argbFromHex, hexFromArgb, themeFromSourceColor } from '@material/material-color-utilities'

// 实际用法说明:本仓库固定使用 @material/material-color-utilities@0.2.7,
// 其 Scheme 实例自带经典角色 props(scheme.props[p]),与下方 scheme.props[p] 写法一致;
// 0.3.0+/0.4.0 版本需改用 getter scheme[p],且 0.4.0 内部 ESM import 缺 .js 扩展名无法纯 Node 直跑,故不采用。
const here = dirname(fileURLToPath(import.meta.url))
const palettes = JSON.parse(readFileSync(join(here, 'palettes.json'), 'utf8'))

// MD3 扩展 surface 角色的官方 tone 表(参考 M3 色彩系统实现)
const SURFACE_TONES = {
  light: { dim: 87, bright: 98, lowest: 100, low: 96, container: 94, high: 92, highest: 90 },
  dark: { dim: 6, bright: 24, lowest: 4, low: 10, container: 12, high: 17, highest: 22 },
}

const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
// 经典 scheme 角色直接取 props;扩展角色由 neutral/primary palette tone 派生
const CLASSIC = ['primary','onPrimary','primaryContainer','onPrimaryContainer',
  'secondary','onSecondary','secondaryContainer','onSecondaryContainer',
  'tertiary','onTertiary','tertiaryContainer','onTertiaryContainer',
  'error','onError','errorContainer','onErrorContainer',
  'surface','onSurface','surfaceVariant','onSurfaceVariant',
  'outline','outlineVariant','inverseSurface','inverseOnSurface','inversePrimary','shadow','scrim']

function schemeVars(theme, mode) {
  const scheme = theme.schemes[mode]
  const neutral = theme.palettes.neutral
  const t = SURFACE_TONES[mode]
  const vars = CLASSIC.map((p) => `  --md-sys-color-${kebab(p)}:${hexFromArgb(scheme.props[p])};`)
  const derived = {
    'surface-dim': neutral.tone(t.dim),
    'surface-bright': neutral.tone(t.bright),
    'surface-container-lowest': neutral.tone(t.lowest),
    'surface-container-low': neutral.tone(t.low),
    'surface-container': neutral.tone(t.container),
    'surface-container-high': neutral.tone(t.high),
    'surface-container-highest': neutral.tone(t.highest),
    'surface-tint': theme.palettes.primary.tone(mode === 'light' ? 40 : 80),
  }
  for (const [role, argb] of Object.entries(derived)) vars.push(`  --md-sys-color-${role}:${hexFromArgb(argb)};`)
  return vars.join('\n')
}

const DEFAULT_ID = 'blue'
const header = (purpose) =>
  `/* 自动生成:pnpm --filter @totp/ui theme — 勿手改
 * ${purpose}
 * 特异度:本文件选择器为 (0,1,0);tokens-palettes.css 的 [data-color=X][data-mode=Y] 为 (0,2,0),恒胜本文件兜底。 */`

// base 恒载产物:color-scheme 4 声明 + 无 [data-color] 限定的 light/dark/auto×media 块,值=默认种子 blue(兜底)
const base = [
  header('base 恒载:无 [data-color] 限定的 light/dark/auto 块,值=默认种子 blue(未加载 palettes 时的兜底色)。'),
  '[data-mode="light"] { color-scheme: light }',
  '[data-mode="dark"] { color-scheme: dark }',
  '@media (prefers-color-scheme: light) { [data-mode="auto"] { color-scheme: light } }',
  '@media (prefers-color-scheme: dark) { [data-mode="auto"] { color-scheme: dark } }',
]
const defaultTheme = themeFromSourceColor(argbFromHex(palettes.find((p) => p.id === DEFAULT_ID).hex))
for (const mode of ['light', 'dark']) {
  base.push(`[data-mode="${mode}"] {\n${schemeVars(defaultTheme, mode)}\n}`)
  base.push(`@media (prefers-color-scheme: ${mode}) {\n[data-mode="auto"] {\n${schemeVars(defaultTheme, mode)}\n}\n}`)
}
writeFileSync(join(here, 'tokens.css'), base.join('\n\n') + '\n')
console.log(`tokens.css 已生成:base 兜底(${DEFAULT_ID})× 明/暗 × auto`)

// 懒载产物:非默认种子 × light/dark/auto×media,由 useTheme 在 color≠blue 时动态 import
const rest = palettes.filter((p) => p.id !== DEFAULT_ID)
const palettesOut = [
  header('懒载:9 个非默认种子 × light/dark/auto,[data-color=X][data-mode=Y] 限定,由 useTheme 动态 import(tokens-palettes.css)。'),
]
for (const p of rest) {
  const theme = themeFromSourceColor(argbFromHex(p.hex))
  palettesOut.push(`[data-color="${p.id}"][data-mode="light"] {\n${schemeVars(theme, 'light')}\n}`)
  palettesOut.push(`[data-color="${p.id}"][data-mode="dark"] {\n${schemeVars(theme, 'dark')}\n}`)
  palettesOut.push(`@media (prefers-color-scheme: light) {\n[data-color="${p.id}"][data-mode="auto"] {\n${schemeVars(theme, 'light')}\n}\n}`)
  palettesOut.push(`@media (prefers-color-scheme: dark) {\n[data-color="${p.id}"][data-mode="auto"] {\n${schemeVars(theme, 'dark')}\n}\n}`)
}
writeFileSync(join(here, 'tokens-palettes.css'), palettesOut.join('\n\n') + '\n')
console.log(`tokens-palettes.css 已生成:${rest.length} 非默认种子 × 明/暗 × auto`)
