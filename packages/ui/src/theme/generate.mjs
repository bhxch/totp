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

const blocks = [
  '/* 自动生成:pnpm --filter @totp/ui theme — 勿手改 */',
  '[data-mode="light"] { color-scheme: light }',
  '[data-mode="dark"] { color-scheme: dark }',
  '@media (prefers-color-scheme: light) { [data-mode="auto"] { color-scheme: light } }',
  '@media (prefers-color-scheme: dark) { [data-mode="auto"] { color-scheme: dark } }',
]
for (const p of palettes) {
  const theme = themeFromSourceColor(argbFromHex(p.hex))
  blocks.push(`[data-color="${p.id}"][data-mode="light"] {\n${schemeVars(theme, 'light')}\n}`)
  blocks.push(`[data-color="${p.id}"][data-mode="dark"] {\n${schemeVars(theme, 'dark')}\n}`)
  blocks.push(`@media (prefers-color-scheme: light) {\n[data-color="${p.id}"][data-mode="auto"] {\n${schemeVars(theme, 'light')}\n}\n}`)
  blocks.push(`@media (prefers-color-scheme: dark) {\n[data-color="${p.id}"][data-mode="auto"] {\n${schemeVars(theme, 'dark')}\n}\n}`)
}
writeFileSync(join(here, 'tokens.css'), blocks.join('\n\n') + '\n')
console.log(`tokens.css 已生成:${palettes.length} 种子 × 明/暗 × auto`)
