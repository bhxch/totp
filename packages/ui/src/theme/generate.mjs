// packages/ui/src/theme/generate.mjs — 构建期生成 tokens.css(产物入库,改色板后手动重跑:pnpm --filter @totp/ui theme)
import { readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// mcu 0.4.0 的 ESM barrel 内部相对 import 缺 .js 扩展名(上游 issue #195,open),需两处配套
// (互不替代,上游修复 #195 后均可移除):Node 直跑靠同目录 mcu-esm-loader.mjs(register hook 补 .js);
// vitest 进程靠 packages/ui/vitest.config.ts 的 server.deps.inline(esbuild 预打包容忍缺扩展名)。
// 注意:静态 import 的解析发生在本模块求值(register 执行)之前,故 mcu 必须在 hook 就位后动态 import。
register('./mcu-esm-loader.mjs', import.meta.url)
const { argbFromHex, hexFromArgb, themeFromSourceColor } = await import('@material/material-color-utilities')

// 版本说明:自 2026-10(Task 9)起 devDependency 固定 @material/material-color-utilities@0.4.0,
// 仅本脚本经 loader 直跑;0.4.0 的 Scheme 类标 DEPRECATED 但经典角色 props(scheme.props[p])运行时仍可用,
// themeFromSourceColor 返回的 schemes/palettes 结构与 0.2.7 一致,产物经 themeTokens 测试逐值断言。
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
  'background','onBackground',
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
// specificity 为各产物自视角的特异度说明,避免两文件头注释自指矛盾(都自称 (0,1,0))
const header = (purpose, specificity) =>
  `/* 自动生成:pnpm --filter @totp/ui theme — 勿手改
 * ${purpose}
 * 特异度:${specificity} */`

// M3 字阶尺寸档:mode 无关,恒载 :root(不随 data-mode/data-color 变化);code-large 为项目自定义档(验证码/密文等宽)
const TYPESCALE = [
  ['headline-small', '24px', ''],
  ['title-large', '22px', ''],
  ['title-medium', '16px', ''],
  ['title-small', '14px', ''],
  ['body-large', '16px', ''],
  ['body-medium', '14px', ''],
  ['body-small', '12px', ''],
  ['label-large', '14px', ''],
  ['label-medium', '12px', ''],
  ['label-small', '11px', ''],
  ['code-large', '18px', ' /* 项目自定义档：验证码/密文等宽 */'],
]
const typescaleBlock = `:root {\n${TYPESCALE.map(([k, v, note]) => `  --md-sys-typescale-${k}:${v};${note}`).join('\n')}\n}`
// M3 圆角档与状态层透明度:mode 无关,恒载 :root(不随 data-mode/data-color 变化)
const shapeBlock = `:root {
  --md-sys-shape-corner-extra-small:4px;
  --md-sys-shape-corner-small:8px;
  --md-sys-shape-corner-medium:12px;
  --md-sys-shape-corner-large:16px;
  --md-sys-shape-corner-extra-large:28px;
  --md-sys-shape-corner-full:9999px;
}`
const stateLayerBlock = `:root {
  --md-sys-state-layer-hover:8%;
  --md-sys-state-layer-pressed:12%;
}`
// M3 官方阴影六档:mode 无关,恒载 :root(不随 data-mode/data-color 变化);多层逗号须整串进变量,组件处 box-shadow: var(...) 整体引用
const elevationBlock = `:root {
  --md-sys-elevation-level0:none;
  --md-sys-elevation-level1:0 1px 2px 0 rgba(0,0,0,.30), 0 1px 3px 1px rgba(0,0,0,.15);
  --md-sys-elevation-level2:0 1px 2px 0 rgba(0,0,0,.30), 0 2px 6px 2px rgba(0,0,0,.15);
  --md-sys-elevation-level3:0 1px 3px 0 rgba(0,0,0,.30), 0 4px 8px 3px rgba(0,0,0,.15);
  --md-sys-elevation-level4:0 2px 3px 0 rgba(0,0,0,.30), 0 6px 10px 4px rgba(0,0,0,.15);
  --md-sys-elevation-level5:0 4px 4px 0 rgba(0,0,0,.30), 0 8px 12px 6px rgba(0,0,0,.15);
}`

// base 恒载产物:typescale/shape/state-layer/elevation :root 块 + color-scheme 4 声明 + 无 [data-color] 限定的 light/dark/auto×media 块,值=默认种子 blue(兜底)
const base = [
  header('base 恒载:typescale/shape/state-layer/elevation :root 块 + 无 [data-color] 限定的 light/dark/auto 块,色值=默认种子 blue(未加载 palettes 时的兜底色)。', '本文件 (0,1,0) 兜底,tokens-palettes.css (0,2,0) 恒胜。'),
  typescaleBlock,
  shapeBlock,
  stateLayerBlock,
  elevationBlock,
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
  header('懒载:9 个非默认种子 × light/dark/auto,[data-color=X][data-mode=Y] 限定,由 useTheme 动态 import(tokens-palettes.css)。', '本文件 (0,2,0),恒胜 base (0,1,0) 兜底。'),
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
