# TOTP 工具 计划13:前端重设计(MD3 + 5页导航 + 主题系统)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按设计文档将前端从「VaultManager 九功能单页 + 硬编码配色」重构为「MD3 令牌化 + 5 页导航(桌面主窗口/扩展 options)+ 明/暗/自动主题 + 10 种子色主题色设置」,popup 与 mini 保持行为与体积不变。

**Architecture:** 主题三层——`palettes.json`(种子色单一事实源)→ 构建期 `generate.mjs`(material-color-utilities 生成 10 种子 × 明暗 × 34 角色变量,产物 `tokens.css` 入库)→ 运行时纯 CSS `data-mode`/`data-color` 属性选择器矩阵(auto 走 prefers-color-scheme);`useTheme()` 双向绑定 AppSettings 新字段并写 localStorage 镜像,入口 `index.html` 内联脚本防首帧闪。页面层:`packages/ui/src/pages/` 五页 + `NavigationShell.vue`(宽屏 Rail / 窄屏 Tabs),vue-router@4 仅桌面主窗口与扩展 options(hash),`VaultManager.vue` 拆解散场;`components/md/` 自建 11 个 MD3 展示组件。数据层零改动。

**Tech Stack:** Vue 3.5(script setup)、vue-router@4(hash)、@material/material-color-utilities(仅 devDep)、vitest + @vue/test-utils(既有)。

**Spec:** `docs/plans/2026-09-15-frontend-redesign-design.md`(本计划从该 spec 出发,执行者两份都要读)

## Global Constraints

- 组件样式**只允许**引用 `--md-sys-color-*` 变量;禁止新增任何硬编码色值(hex/rgba/named color)。存量硬编码色在 Task 4 全部替换。
- 种子色板固定 10 个,值以 `packages/ui/src/theme/palettes.json` 为单一事实源(值见 Task 2,不得改动);默认 `blue`,模式默认 `auto`。
- Token 角色 34 个/套,命名 `--md-sys-color-*`(清单见 Task 2);error 系列不随种子变化。
- vue-router 仅用于桌面主窗口与扩展 options,统一 `createWebHashHistory`;popup 与 mini 不进 router、不上 Navigation。
- popup 与 mini 行为语义与体积敏感度保持:不因 md/ 组件显著回退(验收核对构建产物体积)。
- 数据层零改动:`packages/core` 仅 AppSettings 增两字段;`packages/ui/src/store.ts`、`useOtpCodes`、各 platform 类型不动。
- 安全语义不妥协:reveal 前4+后4遮蔽、搜 secret 默认关、HOTP 复制后递增、剪贴板清除链路等既有行为逐条保持。
- 每个 Task 结束 `pnpm --filter @totp/ui test`(及涉及包)全绿 + typecheck 通过后再 commit;commit 符合 Angular 规范,先 why 后 what。
- Vue 组件一律 `<script setup lang="ts">`;测试文件放 `packages/ui/test/`(core 放 `packages/core/test/`)。

---

### Task 1: core AppSettings 增 themeMode/themeColor(TDD)

**Files:**
- Modify: `packages/core/src/storage/vaultStore.ts`(AppSettings 接口 + DEFAULT_SETTINGS + loadSettings 合并)
- Test: `packages/core/test/vaultStore.test.ts`(既有文件追加用例;若设置用例在别处,rg `loadSettings` 定位后追加)

**Interfaces:**
- Produces:
  ```ts
  export type ThemeMode = 'light' | 'dark' | 'auto'
  // AppSettings 新增字段(追加到接口末尾):
  themeMode: ThemeMode        // 默认 'auto'
  themeColor: string          // 种子色 id;core 只做「非空字符串且 ≤32」校验,色板合法性由 ui 层校验(见 Task 3 useTheme)
  ```
- Consumes: 既有 `loadSettings` 类型化合并模式(M4 注释处,逐字段 typeof 校验)。

- [ ] **Step 1: 写失败测试**(追加到既有 settings 测试)

```ts
describe('theme settings 合并兜底', () => {
  it('缺省 → auto/blue', async () => {
    adapter.set.and.resolveTo(null)  // 沿用文件内既有 adapter stub 方式
    const s = await loadSettings(adapter)
    expect(s.themeMode).toBe('auto')
    expect(s.themeColor).toBe('blue')
  })
  it('合法值透传', async () => {
    adapter.get.and.resolveTo(JSON.stringify({ themeMode: 'dark', themeColor: 'teal' }))
    const s = await loadSettings(adapter)
    expect(s.themeMode).toBe('dark')
    expect(s.themeColor).toBe('teal')
  })
  it('非法值回退默认', async () => {
    adapter.get.and.resolveTo(JSON.stringify({ themeMode: 'sepia', themeColor: 42 }))
    const s = await loadSettings(adapter)
    expect(s.themeMode).toBe('auto')
    expect(s.themeColor).toBe('blue')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** —— `pnpm --filter @totp/core test`;预期 FAIL(字段不存在,类型错误)。
- [ ] **Step 3: 最小实现**

```ts
// vaultStore.ts — AppSettings 接口追加
/** 主题模式:auto=跟随系统(prefers-color-scheme) */
themeMode: ThemeMode
/** 主题种子色 id(packages/ui theme/palettes.json 定义);core 仅做格式校验 */
themeColor: string
// DEFAULT_SETTINGS 追加
themeMode: 'auto',
themeColor: 'blue',
// loadSettings 合并处追加(typeof 校验风格与相邻字段一致)
themeMode: merged.themeMode === 'light' || merged.themeMode === 'dark' || merged.themeMode === 'auto' ? merged.themeMode : DEFAULT_SETTINGS.themeMode,
themeColor: typeof merged.themeColor === 'string' && merged.themeColor.length > 0 && merged.themeColor.length <= 32 ? merged.themeColor : DEFAULT_SETTINGS.themeColor,
```

- [ ] **Step 4: 跑测试通过 + typecheck** —— `pnpm --filter @totp/core test && pnpm --filter @totp/core typecheck`。
- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): AppSettings增themeMode/themeColor(类型化合并兜底)

why: 前端重设计(计划13)需要主题模式与主题色持久化,走既有settings合并模式可自动兜底旧数据。
what: ThemeMode类型+两字段默认auto/blue,loadSettings逐字段typeof校验回退。"
```

---

### Task 2: 主题产物管道 palettes.json + generate.mjs + tokens.css(TDD)

**Files:**
- Create: `packages/ui/src/theme/palettes.json`、`packages/ui/src/theme/generate.mjs`、`packages/ui/src/theme/tokens.css`(产物)
- Modify: `packages/ui/package.json`(devDependencies 加 `@material/material-color-utilities`;scripts 加 `"theme": "node src/theme/generate.mjs"`)
- Test: `packages/ui/test/themeTokens.test.ts`

**Interfaces:**
- Produces:
  - `palettes.json`:`[{ "id": "blue", "hex": "#0B57D0" }, ...]`(10 项,顺序即设置页展示顺序)
  - `tokens.css`:每种子 4 个变量块(light/dark/auto×media)+ 顶部 `color-scheme` 声明块
  - 后续任务只 import CSS 变量,不 import 生成器
- 消费方:Task 3(useTheme 读 palette 合法性)、Task 11(SettingsPage 色板选择器)、全部组件样式。

- [ ] **Step 1: 安装 devDependency**

```bash
pnpm --filter @totp/ui add -D @material/material-color-utilities
```

- [ ] **Step 2: 写 palettes.json**(单一事实源;值=设计文档 §4.1,不可改)

```json
[
  { "id": "blue",   "hex": "#0B57D0", "label": "蓝(默认)" },
  { "id": "indigo", "hex": "#4355B9", "label": "靛蓝" },
  { "id": "teal",   "hex": "#00796B", "label": "青绿" },
  { "id": "green",  "hex": "#2E7D32", "label": "绿" },
  { "id": "amber",  "hex": "#9A6A00", "label": "琥珀" },
  { "id": "orange", "hex": "#E8590C", "label": "橙" },
  { "id": "red",    "hex": "#C5221F", "label": "红" },
  { "id": "violet", "hex": "#6750A4", "label": "紫罗兰" },
  { "id": "pink",   "hex": "#B32784", "label": "粉" },
  { "id": "slate",  "hex": "#5F6368", "label": "石板灰" }
]
```

- [ ] **Step 3: 写失败测试**

```ts
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
          expect(block![1]).toMatch(new RegExp(`--md-sys-color-${role}:\\s*#\\w{6}`), `${p.id}/${mode}/${role}`)
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
    const got = block[1].match(/--md-sys-color-primary:\s*(#\w{6})/)![1].toLowerCase()
    expect(got).toBe(expectPrimary)
    const errs = [...css.matchAll(/--md-sys-color-primary:\s*#\w{6}/g)] // 占位防误配:error 用独立断言
    expect(errs.length).toBeGreaterThan(0)
    const errSet = new Set([...css.matchAll(/\[data-color="\w+"\]\[data-mode="(?:light|dark)"\]\s*\{([^}]*)\}/g)]
      .map((b) => b[1].match(/--md-sys-color-error:\s*(#\w{6})/)![1].toLowerCase()))
    expect(errSet.size).toBe(1) // error 不随种子变化
  })
})
```

- [ ] **Step 4: 跑测试确认失败** —— `pnpm --filter @totp/ui test -- themeTokens`;预期 FAIL(tokens.css 不存在)。
- [ ] **Step 5: 写 generate.mjs**(完整脚本)

```js
// packages/ui/src/theme/generate.mjs — 构建期生成 tokens.css(产物入库,改色板后手动重跑:pnpm --filter @totp/ui theme)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { argbFromHex, hexFromArgb, themeFromSourceColor } from '@material/material-color-utilities'

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
```

- [ ] **Step 6: 生成产物并跑测试通过** —— `pnpm --filter @totp/ui theme && pnpm --filter @totp/ui test -- themeTokens`;预期 PASS。若 `scheme.props` 缺某经典角色(库版本差异),报错会明确指出缺哪个,此时从 `theme.palettes` 按 M3 tone 表派生该角色并在脚本注释注明来源。
- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/theme packages/ui/package.json packages/ui/test/themeTokens.test.ts pnpm-lock.yaml
git commit -m "feat(ui): MD3主题产物管道(10种子色→34角色×明暗CSS变量)

why: 主题系统需要构建期静态生成方案,运行时零调色依赖(设计文档D3)。
what: palettes.json单一事实源+generate.mjs(material-color-utilities devDep)+tokens.css产物入库+产物完整性测试。"
```

---

### Task 3: useTheme + FOUC 内联脚本 + 四入口接线

**Files:**
- Create: `packages/ui/src/theme/useTheme.ts`、`packages/ui/src/theme/palette.ts`
- Modify: `packages/ui/src/index.ts`(导出)、`packages/ui/package.json`(若 css 导出需要;tokens.css 由各入口自行 import)、四个入口 html(desktop `index.html`/`mini.html`、extension `entrypoints/options/index.html`/`entrypoints/popup/index.html`)、四个入口 Vue 根组件(App.vue×2、MiniApp.vue、popup/App.vue——本任务只接 useTheme,不接 router)
- Test: `packages/ui/test/useTheme.test.ts`

**Interfaces:**
- Produces:

```ts
// palette.ts
export interface ThemePaletteEntry { id: string; hex: string; label: string }
export const THEME_PALETTES: ThemePaletteEntry[]          // 内容 = palettes.json import + label
export const DEFAULT_THEME_COLOR = 'blue'
export function isThemeColor(id: unknown): id is string   // THEME_PALETTES 内命中

// useTheme.ts
export type ThemeModeValue = 'light' | 'dark' | 'auto'
export const THEME_PREF_KEY = 'themePref'                  // localStorage 镜像 key
export function applyThemeAttributes(mode: string, color: string): void  // 写 documentElement.dataset
export function readThemeMirror(): { mode?: string; color?: string }     // 供测试/无内联脚本场景
export function useTheme(store: VueStore): {
  mode: WritableComputedRef<ThemeModeValue>    // get=store.settings.themeMode;set→校验→写 settings+commitSettings()+镜像
  color: WritableComputedRef<string>           // 非法值读侧回退 DEFAULT_THEME_COLOR
  resolvedMode: ComputedRef<'light' | 'dark'>  // auto 解析(matchMedia 监听;环境不支持时按 light)
}
```

- **调用时序约束(实现者必读)**:`useTheme(store)` 必须在 `initStore()` 完成**之后**调用(设置已加载为真实值);此前由 html 内联脚本负责首帧属性。watchEffect 只应用属性,镜像只在 set 写入,避免默认值覆盖镜像。

- [ ] **Step 1: 写失败测试**(jsdom;matchMedia 需 stub)

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { reactive } from 'vue'
import { applyThemeAttributes, isThemeColor, THEME_PALETTES, useTheme } from '../src/theme/useTheme'

const store = () => ({
  settings: reactive({ themeMode: 'auto', themeColor: 'blue' }),
  commitSettings: vi.fn(async () => {}),
})

beforeEach(() => {
  localStorage.clear()
  document.documentElement.dataset.mode = ''
  document.documentElement.dataset.color = ''
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true,
    value: vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn() }) })
})

describe('palette', () => {
  it('色板10项且 isThemeColor 校验', () => {
    expect(THEME_PALETTES).toHaveLength(10)
    expect(isThemeColor('teal')).toBe(true)
    expect(isThemeColor('nope')).toBe(false)
  })
})

describe('useTheme', () => {
  it('应用 data-mode/data-color 到根元素并写镜像(经 set)', async () => {
    const s = store()
    const t = useTheme(s)
    t.mode.value = 'dark'
    t.color.value = 'teal'
    await Promise.resolve()
    expect(document.documentElement.dataset.mode).toBe('dark')
    expect(document.documentElement.dataset.color).toBe('teal')
    expect(JSON.parse(localStorage.getItem('themePref')!)).toEqual({ mode: 'dark', color: 'teal' })
    expect(s.commitSettings).toHaveBeenCalled()
  })
  it('非法 color 读侧回退 blue', () => {
    const s = store(); s.settings.themeColor = 'nope'
    expect(useTheme(s).color.value).toBe('blue')
  })
  it('resolvedMode:auto 跟随 matchMedia(dark 系统→dark)', () => {
    const s = store(); s.settings.themeMode = 'auto'
    expect(useTheme(s).resolvedMode.value).toBe('dark')
  })
})

describe('applyThemeAttributes', () => {
  it('直接写 dataset', () => {
    applyThemeAttributes('light', 'slate')
    expect(document.documentElement.dataset).toMatchObject({ mode: 'light', color: 'slate' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败** —— `pnpm --filter @totp/ui test -- useTheme`。
- [ ] **Step 3: 实现 palette.ts + useTheme.ts**

```ts
// palette.ts
import palettesJson from './palettes.json'
export interface ThemePaletteEntry { id: string; hex: string; label: string }
export const THEME_PALETTES: ThemePaletteEntry[] = palettesJson
export const DEFAULT_THEME_COLOR = 'blue'
export function isThemeColor(id: unknown): id is string {
  return typeof id === 'string' && THEME_PALETTES.some((p) => p.id === id)
}
```

```ts
// useTheme.ts
import { computed, ref, watchEffect, type ComputedRef, type WritableComputedRef } from 'vue'
import type { VueStore } from '../store'
import { DEFAULT_THEME_COLOR, isThemeColor } from './palette'

export type ThemeModeValue = 'light' | 'dark' | 'auto'
export const THEME_PREF_KEY = 'themePref'

export function applyThemeAttributes(mode: string, color: string): void {
  document.documentElement.dataset.mode = mode
  document.documentElement.dataset.color = color
}

export function readThemeMirror(): { mode?: string; color?: string } {
  try { return JSON.parse(localStorage.getItem(THEME_PREF_KEY) ?? '{}') } catch { return {} }
}

export function useTheme(store: VueStore): { mode: WritableComputedRef<ThemeModeValue>; color: WritableComputedRef<string>; resolvedMode: ComputedRef<'light' | 'dark'> } {
  const systemDark = ref(false)
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = mq.matches
    mq.addEventListener?.('change', (e) => (systemDark.value = e.matches))
  }
  const mode = computed<ThemeModeValue>({
    get: () => (store.settings.themeMode === 'light' || store.settings.themeMode === 'dark' ? store.settings.themeMode : 'auto'),
    set(v) {
      store.settings.themeMode = v
      writeMirror(v, color.value)
      void store.commitSettings()
    },
  })
  const color = computed<string>({
    get: () => (isThemeColor(store.settings.themeColor) ? store.settings.themeColor : DEFAULT_THEME_COLOR),
    set(v) {
      if (!isThemeColor(v)) return
      store.settings.themeColor = v
      writeMirror(mode.value, v)
      void store.commitSettings()
    },
  })
  const resolvedMode = computed<'light' | 'dark'>(() => (mode.value === 'auto' ? (systemDark.value ? 'dark' : 'light') : mode.value))
  // 仅应用属性(首帧由 html 内联脚本兜底);镜像仅在 set 写,避免加载前默认值覆盖镜像
  watchEffect(() => applyThemeAttributes(mode.value, color.value))
  function writeMirror(m: string, c: string) {
    try { localStorage.setItem(THEME_PREF_KEY, JSON.stringify({ mode: m, color: c })) } catch { /* 镜像失败不影响功能 */ }
  }
  return { mode, color, resolvedMode }
}
```

> 注:`readThemeMirror`/`isThemeColor` 亦被设置页(Task 11)与测试复用。`store.settings` 类型上已有两字段(Task 1)。

- [ ] **Step 4: 跑测试通过** —— `pnpm --filter @totp/ui test -- useTheme`。
- [ ] **Step 5: 四入口接线**

各入口 Vue 根组件在 `initStore()` 成功后调用(以桌面 App.vue 为例,options/popup/mini 同理,均在那段 `try` 内 `await s.initStore()`/`await initStore()` 之后):

```ts
import { useTheme } from '@totp/ui'
// ...initStore 成功分支内:
useTheme(store.value ?? s)  // 各入口按自己的 store 变量名传入;popup/mini 传其 store 单例
```

各入口根组件样式入口 import 一次 tokens.css(桌面在 `main.ts`/`mini.ts`,扩展在 options/popup 的 `main.ts`):

```ts
import '@totp/ui/src/theme/tokens.css'
```

四个 html 的 `<head>` 最前插入内联脚本(逐字一致;`documentElement.dataset` 在 CSS 匹配前同步就位,缺镜像时默认 auto/blue):

```html
<script>try{var p=JSON.parse(localStorage.getItem('themePref')||'{}'),d=document.documentElement.dataset;d.mode=p.mode||'auto';d.color=p.color||'blue'}catch(e){document.documentElement.dataset.mode='auto';document.documentElement.dataset.color='blue'}</script>
```

- [ ] **Step 6: 全量验证 + Commit**

```bash
pnpm -r test && pnpm -r typecheck
git add packages/ui apps/desktop apps/extension
git commit -m "feat(ui,desktop,extension): useTheme主题控制器+FOUC内联脚本接线四入口

why: 主题需要类型安全的读写入口与首帧防闪(设计文档§4.5/§4.6)。
what: useTheme(mode/color双向+resolvedMode+镜像)、palette.ts、四入口initStore后接线、html内联镜像脚本、tokens.css引入。"
```

---

### Task 4: 存量样式 token 化(全局硬编码色清零)

**Files:**
- Modify(rg 定位后逐文件):`packages/ui/src/components/*.vue`(OtpListItem/SearchBar/LockScreen/EntryForm/六张卡)、`apps/desktop/src/App.vue`、`apps/desktop/src/MiniApp.vue`、`apps/extension/entrypoints/popup/App.vue`、`apps/extension/entrypoints/options/App.vue`
- Test: 既有测试全量回归(不断言色值)

**Interfaces:**
- Consumes: Task 2 tokens.css 的 34 变量。
- Produces: 全仓库 Vue `<style>` 无硬编码色;后续任务在纯变量环境上进行。

- [ ] **Step 1: 列出全部命中**

```bash
rg -n "#[0-9a-fA-F]{3,8}\b|rgba?\(" packages/ui/src apps --glob '*.vue' --glob '!**/.output/**'
```

- [ ] **Step 2: 按映射表替换**(语义映射,出现处对照上下文取近义项)

| 存量 | 替换为 |
|---|---|
| `#fff` / `white`(卡片/弹层底色) | `var(--md-sys-color-surface-container-high)`(模态/菜单)或 `var(--md-sys-color-surface-container)`(卡面) |
| `#222` / `#000` 前景 | `var(--md-sys-color-on-surface)` |
| `#d9534f` / 红色错误/危险 | `var(--md-sys-color-error)` |
| `rgba(0,0,0,.45)`(遮罩) | `color-mix(in srgb, var(--md-sys-color-scrim) 55%, transparent)` |
| `rgba(128,128,128,.4)` 等灰色边框 | `var(--md-sys-color-outline-variant)` |
| `rgba(128,128,128,.12)` 等浅灰底 | `var(--md-sys-color-surface-container-high)` |
| `rgba(0,0,0,.06)` hover | `color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)` |
| `rgba(0,0,0,.15~.25)` 阴影 | `var(--md-sys-color-shadow)`(配既有 box-shadow 结构) |
| 其余装饰灰(次级文本) | `var(--md-sys-color-on-surface-variant)` |

替换后每文件目视核对深色语义(如 hover 用 on-surface 8% 而非写死黑)。
- [ ] **Step 3: 回归** —— `pnpm -r test && pnpm -r typecheck`;再 `rg` 复查命中数为 0(排除 tokens.css 与注释)。
- [ ] **Step 4: Commit**

```bash
git add packages/ui apps
git commit -m "refactor(ui,desktop,extension): 存量样式硬编码色全量替换为MD3变量

why: 主题变量切换的前提是样式只引用token(设计文档§4.3);替换单独成提交以便回溯。
what: 按语义映射表清零全部hex/rgba硬编码色,行为与布局不变,深浅色即刻可用。"
```

---

### Task 5: md/ 基础组件 I — MdButton / MdIconButton / MdFab / MdChip / MdCard

**Files:**
- Create: `packages/ui/src/components/md/MdButton.vue`、`MdIconButton.vue`、`MdFab.vue`、`MdChip.vue`、`MdCard.vue`
- Modify: `packages/ui/src/index.ts`(导出全部 md 组件,后续任务同,不再重复写)
- Test: `packages/ui/test/md/mdButtons.test.ts`(五个组件一个文件)

**Interfaces:**
- Produces(契约,后续任务消费):

```ts
MdButton:   props { variant?: 'filled'|'tonal'|'outlined'|'text'|'elevated'(默认 filled), disabled?: boolean, type?: 'button'|'submit'(默认 button) }  // slot: 内容;emit: click(原生透传)
MdIconButton: props { variant?: 'standard'|'filled'|'tonal'|'outlined'(默认 standard), disabled?: boolean, title?: string, ariaLabel?: string }       // slot: 文本/SVG
MdFab:      props { label?: string }             // 固定 primary-container 底,slot 图标;有 label 时扩展形
MdChip:     props { selected?: boolean, label: string }  // emit: click;selected 用 secondary-container
MdCard:     props { variant?: 'outlined'|'elevated'(默认 outlined), padding?: 'compact'|'normal'(默认 normal) }  // slot 默认 + 具名 header(标题行)
```

- 视觉规格(所有 md 组件通用约束):圆角按钮 100px / 卡 12px / chip 8px;高度:按钮 40px、icon-button 40px、fab 56px(扩展形 56×高)、chip 32px;字体 14px/500(label-large 风格);hover 态一律 `color-mix(in srgb, <对应 on-* 色> 8%, transparent)` 叠加;焦点环 `outline: 3px solid var(--md-sys-color-primary)` 偏移 2px。

- [ ] **Step 1: 写失败测试**(节选 MdButton 断言模式,其余组件同构——按上表契约断言 class/属性/事件)

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MdButton from '../../src/components/md/MdButton.vue'
import MdChip from '../../src/components/md/MdChip.vue'
import MdFab from '../../src/components/md/MdFab.vue'

describe('MdButton', () => {
  it('默认 filled,variant 类名生效,click 透传', async () => {
    const w = mount(MdButton, { slots: { default: '保存' } })
    expect(w.classes()).toContain('md-btn--filled')
    await w.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })
  it('tonal/outlined/text/elevated 类名', () => {
    for (const v of ['tonal', 'outlined', 'text', 'elevated']) {
      expect(mount(MdButton, { props: { variant: v } }).classes()).toContain(`md-btn--${v}`)
    }
  })
})
describe('MdChip', () => {
  it('selected 态与 click 事件', async () => {
    const w = mount(MdChip, { props: { label: '工作', selected: true } })
    expect(w.classes()).toContain('md-chip--selected')
    expect(w.text()).toContain('工作')
    await w.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })
})
describe('MdFab', () => {
  it('扩展形渲染 label', () => {
    expect(mount(MdFab, { props: { label: '添加' } }).text()).toContain('添加')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** —— `pnpm --filter @totp/ui test -- md/mdButtons`。
- [ ] **Step 3: 实现五组件**(MdButton 全文如下;其余按契约表实现,样式全部走 token)

```vue
<!-- MdButton.vue -->
<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'filled' | 'tonal' | 'outlined' | 'text' | 'elevated'; disabled?: boolean; type?: 'button' | 'submit' }>(), { variant: 'filled', disabled: false, type: 'button' })
</script>
<template>
  <button class="md-btn" :class="`md-btn--${variant}`" :type="type" :disabled="disabled"><slot /></button>
</template>
<style scoped>
.md-btn { border: none; cursor: pointer; border-radius: 100px; padding: 0 24px; height: 40px;
  font: inherit; font-size: 14px; font-weight: 500; display: inline-flex; align-items: center; gap: 8px;
  transition: box-shadow .15s, filter .15s; position: relative; }
.md-btn:disabled { opacity: .38; cursor: default; }
.md-btn:not(:disabled):hover { filter: brightness(.96); }
.md-btn--filled { background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); }
.md-btn--tonal { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); }
.md-btn--outlined { background: transparent; color: var(--md-sys-color-primary); box-shadow: inset 0 0 0 1px var(--md-sys-color-outline); }
.md-btn--text { background: transparent; color: var(--md-sys-color-primary); padding: 0 12px; }
.md-btn--elevated { background: var(--md-sys-color-surface-container-low); color: var(--md-sys-color-primary); box-shadow: 0 1px 3px var(--md-sys-color-shadow); }
.md-btn:not(:disabled):focus-visible { outline: 3px solid var(--md-sys-color-primary); outline-offset: 2px; }
</style>
```

- [ ] **Step 4: 跑测试通过 + Commit**

```bash
pnpm --filter @totp/ui test -- md/mdButtons && pnpm --filter @totp/ui typecheck
git add packages/ui/src/components/md packages/ui/src/index.ts packages/ui/test/md
git commit -m "feat(ui): MD3基础组件I(button/icon-button/fab/chip/card)

why: 页面重构需要统一的MD3展示组件,样式全部走token(设计文档§6)。
what: 5个组件+契约测试,变体类名与视觉规格按计划Task5契约表。"
```

---

### Task 6: md/ 基础组件 II — MdTextField / MdSwitch / MdCheckbox / MdSegmentedButton

**Files:**
- Create: `packages/ui/src/components/md/MdTextField.vue`、`MdSwitch.vue`、`MdCheckbox.vue`、`MdSegmentedButton.vue`
- Test: `packages/ui/test/md/mdInputs.test.ts`

**Interfaces:**
- Produces:

```ts
MdTextField: props { modelValue: string, label: string, type?: string(默认 text), error?: string, placeholder?: string }
             emit: update:modelValue  // filled 风格:top-radius 4px,底 surface-container-highest,浮动 label
MdSwitch:    props { modelValue: boolean, disabled?: boolean }  emit: update:modelValue  // MD3 开关:轨道 52×32,thumb 24,选中 primary
MdCheckbox:  props { modelValue: boolean, label?: string }      emit: update:modelValue  // 18px 圆角2px,选中 primary 填充+on-primary 对勾
MdSegmentedButton: props { options: { value: string; label: string }[], modelValue: string } emit: update:modelValue
             // 单选分段:选中段 secondary-container 底+check 图标位;无外边框相连,段间 1px outline 分隔
```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MdTextField from '../../src/components/md/MdTextField.vue'
import MdSwitch from '../../src/components/md/MdSwitch.vue'
import MdSegmentedButton from '../../src/components/md/MdSegmentedButton.vue'

describe('MdTextField', () => {
  it('v-model 双向', async () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '名称' } })
    await w.find('input').setValue('abc')
    expect(w.emitted('update:modelValue')![0]).toEqual(['abc'])
  })
  it('error 文案渲染', () => {
    expect(mount(MdTextField, { props: { modelValue: '', label: 'x', error: '必填' } }).text()).toContain('必填')
  })
})
describe('MdSwitch', () => {
  it('点击翻转并发 update', async () => {
    const w = mount(MdSwitch, { props: { modelValue: false } })
    await w.find('input[type=checkbox]').setValue(true)
    expect(w.emitted('update:modelValue')![0]).toEqual([true])
    expect(w.classes()).toContain('md-switch--checked')
  })
})
describe('MdSegmentedButton', () => {
  it('单选切换', async () => {
    const w = mount(MdSegmentedButton, { props: { modelValue: 'auto', options: [
      { value: 'auto', label: '自动' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }] } })
    await w.findAll('button')[2].trigger('click')
    expect(w.emitted('update:modelValue')![0]).toEqual(['dark'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**;**Step 3: 实现四组件**(契约如上;MdSwitch 用原生 checkbox + 纯 CSS 轨道/thumb,`md-switch--checked` 类随 modelValue;MdSegmentedButton 选中段类 `md-seg__item--selected`)
- [ ] **Step 4: 跑测试通过 + Commit**

```bash
pnpm --filter @totp/ui test -- md/mdInputs && pnpm --filter @totp/ui typecheck
git add packages/ui/src/components/md packages/ui/src/index.ts packages/ui/test/md
git commit -m "feat(ui): MD3基础组件II(text-field/switch/checkbox/segmented-button)

why: 表单与设置页控件MD3化,主题令牌统一(设计文档§6)。
what: 4个受控组件+v-model契约测试。"
```

---

### Task 7: md/ 基础组件 III — MdDialog / MdMenu / MdList / MdListItem

**Files:**
- Create: `packages/ui/src/components/md/MdDialog.vue`、`MdMenu.vue`、`MdList.vue`、`MdListItem.vue`
- Test: `packages/ui/test/md/mdOverlays.test.ts`

**Interfaces:**
- Produces:

```ts
MdDialog: props { open: boolean, headline?: string }  emit: close        // slot: 默认内容 + actions
          // 行为:遮罩(scrim 55%)点击、Esc、actions 内 [data-md-close] 点击 → emit('close');open 期间 focus 移入对话框,关闭还原
MdMenu:   props { x: number, y: number, open: boolean } emit: close      // slot: 菜单项(用 MdListItem);fixed 定位于 (x,y),越界翻转(视口右/下边缘)
MdList:   无 props                                                        // slot: MdListItem 集合
MdListItem: props { label: string, danger?: boolean } emit: click        // danger 用 error 色;整行可点,hover state layer
```

- [ ] **Step 1: 写失败测试**(关键行为断言:Esc/遮罩关闭、菜单定位样式、danger 类)

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MdDialog from '../../src/components/md/MdDialog.vue'
import MdMenu from '../../src/components/md/MdMenu.vue'
import MdListItem from '../../src/components/md/MdListItem.vue'

describe('MdDialog', () => {
  it('open=false 不渲染', () => {
    expect(mount(MdDialog, { props: { open: false } }).find('.md-dialog').exists()).toBe(false)
  })
  it('Esc 关闭;actions 内 data-md-close 点击关闭', async () => {
    const w = mount(MdDialog, { props: { open: true, headline: '确认' }, slots: { actions: '<button data-md-close>好</button>' }, attachTo: document.body })
    await w.find('.md-dialog__scrim').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
    await w.find('[data-md-close]').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
    w.unmount()
  })
})
describe('MdMenu', () => {
  it('定位到 x/y 且 open=false 不渲染', () => {
    const closed = mount(MdMenu, { props: { open: false, x: 0, y: 0 } })
    expect(closed.find('.md-menu').exists()).toBe(false)
    const w = mount(MdMenu, { props: { open: true, x: 40, y: 60 } })
    expect(w.find('.md-menu').attributes('style')).toContain('left: 40px')
    expect(w.find('.md-menu').attributes('style')).toContain('top: 60px')
  })
})
describe('MdListItem', () => {
  it('danger 类与 click', async () => {
    const w = mount(MdListItem, { props: { label: '删除', danger: true } })
    expect(w.classes()).toContain('md-list-item--danger')
    await w.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**;**Step 3: 实现四组件**(MdDialog 用 `window.addEventListener('keydown')` 监听 Esc,`onScopeDispose` 移除;遮罩 keydown 仅为测试可达,实际在根元素监听;MdMenu 视口翻转逻辑:若 `x+菜单宽>innerWidth` 取 `innerWidth-菜单宽-8`,同 y)
- [ ] **Step 4: 跑测试通过 + Commit**

```bash
pnpm --filter @totp/ui test -- md/mdOverlays && pnpm --filter @totp/ui typecheck
git add packages/ui/src/components/md packages/ui/src/index.ts packages/ui/test/md
git commit -m "feat(ui): MD3基础组件III(dialog/menu/list)

why: 对话框与右键菜单是拆页后交互的承载体(设计文档§6)。
what: MdDialog(遮罩/Esc/close委托)、MdMenu(定位+视口翻转)、MdList/ListItem。"
```

---

### Task 8: md 导航 + NavigationShell + 路由表

**Files:**
- Create: `packages/ui/src/components/md/MdNavigationRail.vue`、`MdTabs.vue`、`packages/ui/src/pages/navIcons.ts`、`packages/ui/src/pages/NavigationShell.vue`、`packages/ui/src/pages/routes.ts`
- Modify: `apps/desktop/package.json`、`apps/extension/package.json`(dependencies 加 `vue-router@^4.4.0`;packages/ui devDependencies 同步加供类型)
- Test: `packages/ui/test/md/mdNav.test.ts`、`packages/ui/test/NavigationShell.test.ts`

**Interfaces:**
- Produces:

```ts
// navIcons.ts — 5 个 24×24 内联 SVG path(fill=currentColor,简单几何,自绘)
export const NAV_ICONS: Record<'codes' | 'import' | 'sync' | 'security' | 'settings', string>

// routes.ts
export const themeRoutes: RouteRecordRaw[] = [
  { path: '/', redirect: '/codes' },
  { path: '/codes', name: 'codes', component: () => import('./CodesPage.vue') },
  { path: '/import', name: 'import', component: () => import('./ImportPage.vue') },
  { path: '/sync', name: 'sync', component: () => import('./SyncPage.vue') },
  { path: '/security', name: 'security', component: () => import('./SecurityPage.vue') },
  { path: '/settings', name: 'settings', component: () => import('./SettingsPage.vue') },
]
// 注:本任务先建 5 个占位页面文件(仅 <template><section class="page">{{ name }}</section></template>),Task 9/11 逐个替换为真实现。

MdNavigationRail: props { items: { name: string; label: string; icon: string; to: string }[], active: string }  emit: select(name)
                  // 底部 actions 具名 slot;≥600px 由 NavigationShell 决定用 Rail 还是 Tabs(容器查询/resize 监听)
MdTabs:           props 同 Rail;横向,emit: select
NavigationShell:  props(=现 VaultManager 全量 props:store/platform/securityPlatform/cloudPlatform/syncPlatform/icons/schemesApi,均可缺省)
                  // 布局:左 Rail(宽窗口)/顶 Tabs(窄窗口,<600px),右侧 <router-view>
                  // pageProps 按 route.name 精确分发(见下),Rail 底部 actions 由 props.railActions?: { label: string; onClick: () => void }[] 传入
```

`pageProps` 分发(NavigationShell 内,类型显式):

```ts
const pageProps = computed(() => {
  const p = props
  switch (route.name) {
    case 'codes': return { store: p.store, icons: p.icons }
    case 'import': return { store: p.store, platform: p.platform, schemesApi: p.schemesApi }
    case 'sync': return { store: p.store, platform: p.platform, cloudPlatform: p.cloudPlatform, syncPlatform: p.syncPlatform }
    case 'security': return { securityPlatform: p.securityPlatform }
    case 'settings': return { store: p.store, securityPlatform: p.securityPlatform, showDesktop: (props.railActions?.length ?? 0) > 0, showExtension: p.syncPlatform != null }
    default: return {}
  }
})
```

- [ ] **Step 1: 写失败测试**

```ts
// mdNav.test.ts(节选)
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MdNavigationRail from '../../src/components/md/MdNavigationRail.vue'

const items = [
  { name: 'codes', label: '验证码', icon: 'M3 5h18v2H3zM3 11h18v2H3zM3 17h18v2H3z', to: '/codes' },
  { name: 'settings', label: '设置', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8z', to: '/settings' },
]
describe('MdNavigationRail', () => {
  it('渲染 items,active 指示,select 事件,actions slot', async () => {
    const w = mount(MdNavigationRail, { props: { items, active: 'codes' }, slots: { actions: '<button class="x">托盘</button>' } })
    expect(w.findAll('.md-rail__item')).toHaveLength(2)
    expect(w.find('.md-rail__item--active').text()).toContain('验证码')
    await w.findAll('.md-rail__item')[1].trigger('click')
    expect(w.emitted('select')![0]).toEqual(['settings'])
    expect(w.find('.x').text()).toBe('托盘')
  })
})
```

```ts
// NavigationShell.test.ts —— router stub:用 createRouter + createMemoryHistory 真路由
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import NavigationShell from '../src/pages/NavigationShell.vue'
import { themeRoutes } from '../src/pages/routes'

function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes: themeRoutes })
}
// store/platform 用最小 stub对象(空操作),只验证:Rail 渲染 5 目的地、默认重定向到 /codes、
// router.push('/settings') 后 pageProps 含 store(codes/settings 均应拿到)
describe('NavigationShell', () => {
  it('默认路由重定向 /codes 且渲染 Rail 5 项', async () => {
    const router = makeRouter()
    await router.push('/'); await router.isReady()
    const w = mount(NavigationShell, { global: { plugins: [router] }, props: { store: stubStore } })
    expect(router.currentRoute.value.path).toBe('/codes')
    expect(w.findAll('.md-rail__item')).toHaveLength(5)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**;**Step 3: 实现两导航组件 + navIcons(5 条 path 自绘,形状:列表=三横线、下载=↓托盘、云朵、盾牌、齿轮)+ routes.ts + 5 占位页 + NavigationShell**(窄窗判定:`window.matchMedia('(max-width: 599px)')` 监听,SSR/测试缺 matchMedia 时按宽窗)
- [ ] **Step 4: 跑测试通过 + Commit**

```bash
pnpm --filter @totp/ui test -- md/mdNav NavigationShell && pnpm --filter @totp/ui typecheck
git add packages/ui apps/desktop/package.json apps/extension/package.json pnpm-lock.yaml
git commit -m "feat(ui): MD3导航组件+NavigationShell+路由表(占位页)

why: 5页信息架构的布局壳与深链路由是拆页的地基(设计文档§5)。
what: Rail/Tabs响应式、5条自绘SVG图标、themeRoutes(hash深链)、pageProps按路由分发。"
```

---

### Task 9: CodesPage — 列表与交互迁移(VaultManager 拆解 1/2)

**Files:**
- Create: `packages/ui/src/pages/CodesPage.vue`
- Test: `packages/ui/test/pages/CodesPage.test.ts`(以既有 `packages/ui/test/VaultManager.test.ts` 为基,迁移列表相关用例)

**Interfaces:**
- Consumes: 现有 `OtpListItem`/`SearchBar`/`useOtpCodes`/`iconView`/store ops;MdChip、MdFab、MdMenu、MdDialog。
- Produces:

```ts
// CodesPage.vue
props { store: VueStore; icons?: IconStore | null }
emit: copy(code: string)   // 复制链路与 VaultManager 完全一致(enableCopy 语义由宿主 @copy 决定,复制后 HOTP 递增在本组件内)
// 本任务先内联迁移分组 chips(全部/各分组筛选 + 「管理分组」按钮 emit open-groups);
// GroupManagerDialog/EntryFormDialog/RevealDialog 在 Task 10 落地,本任务先用现状内联模板占位(管理分组按钮暂渲染现有分组表单弹层逻辑简版/禁用态亦可,以测试为准)
```

- 行为迁移清单(自 `VaultManager.vue`,逐条对照):pinned→order 排序、搜索(含 searchSecret 开关)、reveal 模态(前4+后4遮蔽 `maskSecret`)、右键菜单(编辑/复制 URI/置顶,URI 组装逻辑逐字符迁移)、两击确认删除(3s 超时)、HOTP 复制递增、分组筛选(`visible` 计算链上追加 `groupFilter: string | null` 过滤 `entry.groupIds.includes(groupFilter)`)。
- [ ] **Step 1: 迁移测试**(复制 VaultManager.test.ts 中列表/搜索/reveal/右键/删除用例到新文件,适配:入口从 VaultManager 改 CodesPage,新增分组筛选用例:选某 chip 后仅显示该组条目)
- [ ] **Step 2: 跑测试确认失败**(CodesPage 不存在);**Step 3: 实现 CodesPage**(逻辑照搬 + chips 行;FAB/MdFab 触发 `creating` 态)
- [ ] **Step 4: 跑测试通过 + Commit**

```bash
pnpm --filter @totp/ui test -- pages/CodesPage && pnpm --filter @totp/ui typecheck
git add packages/ui/src/pages/CodesPage.vue packages/ui/test/pages
git commit -m "feat(ui): CodesPage从VaultManager迁移列表与交互(含分组筛选chips)

why: 5页拆分第一步,验证码页是核心高频界面(设计文档§5)。
what: 排序/搜索/reveal/右键/置顶/删除确认/HOTP递增逐条迁移,新增分组筛选chips行。"
```

---

### Task 10: EntryFormDialog / GroupManagerDialog / RevealDialog 对话框化

**Files:**
- Create: `packages/ui/src/components/EntryFormDialog.vue`、`GroupManagerDialog.vue`、`RevealDialog.vue`
- Modify: `packages/ui/src/pages/CodesPage.vue`(三处占位替换为对话框)
- Test: `packages/ui/test/EntryFormDialog.test.ts`、`GroupManagerDialog.test.ts`、`RevealDialog.test.ts`

**Interfaces:**
- Produces:

```ts
EntryFormDialog:    props { open: boolean, editing: OtpEntry | null, groups: Group[], icons: EntryIcons, iconStore?: IconStore }
                    emit: save(data: EntryFormData), close
                    // save 分支逻辑(新建默认 digits/algorithm/period/counter 与 order/createdAt)自 VaultManager onSave 逐字迁移
GroupManagerDialog: props { open: boolean, store: VueStore }  emit: close
                    // 建组/重命名/删组走既有 addGroupOp/renameGroupOp/removeGroupOp;重命名行内编辑(enter 保存)
RevealDialog:       props { open: boolean, entry: OtpEntry | null }  emit: close
                    // maskSecret 前4…后4 + 提示文案,自 VaultManager reveal 模态迁移
```

- [ ] **Step 1: 写失败测试**(EntryFormDialog:save 事件载荷与 VaultManager.test.ts 既有 onSave 用例一致;GroupManagerDialog:建组/重命名调用对应 op;RevealDialog:密钥遮蔽渲染 `abcd…wxyz` 形态、不渲染完整 secret)
- [ ] **Step 2: 跑测试确认失败**;**Step 3: 实现三组件**(MdDialog 为壳;EntryForm 内嵌其默认 slot,既有 EntryForm 组件不改内部逻辑)
- [ ] **Step 4: 跑测试通过 + CodesPage 接入回归 + Commit**

```bash
pnpm --filter @totp/ui test -- EntryFormDialog GroupManagerDialog RevealDialog pages/CodesPage && pnpm --filter @totp/ui typecheck
git add packages/ui/src/components packages/ui/src/pages packages/ui/test
git commit -m "feat(ui): 表单/分组管理/密钥揭示对话框化并接入CodesPage

why: 拆页后编辑类交互收敛为MD3对话框,逻辑自VaultManager逐字迁移(设计文档§5)。
what: 三对话框组件+CodesPage替换占位,save/rename/reveal语义不变。"
```

---

### Task 11: 其余四页 — ImportPage / SyncPage / SecurityPage / SettingsPage

**Files:**
- Create: `packages/ui/src/pages/ImportPage.vue`、`SyncPage.vue`、`SecurityPage.vue`、`SettingsPage.vue`
- Modify: `packages/ui/src/pages/CodesPage.vue`(若有遗留分组表单逻辑,确认已全部走 GroupManagerDialog)
- Test: `packages/ui/test/pages/ImportPage.test.ts`、`SyncPage.test.ts`、`SecurityPage.test.ts`、`SettingsPage.test.ts`

**Interfaces:**
- Consumes: 现有 `ImportCard`(props: platform/schemesApi)、`BackupCard`/`CloudCard`(platform)、`SyncCard`(syncPlatform)、`SecurityCard`(securityPlatform)、`useTheme`、`THEME_PALETTES`。
- Produces:

```ts
ImportPage:   props { store: VueStore; platform?: BackupPlatform | null; schemesApi?: ImportSchemesApi | null }
              // platform.readImportFile 存在才渲染 ImportCard(沿用 VaultManager 的 importPlatform 派生逻辑,迁移至此)
SyncPage:     props { platform?: BackupPlatform | null; cloudPlatform?: CloudPlatform | null; syncPlatform?: SyncPlatform | null }
              // 三区块:本地备份(BackupCard+vaultJson 快照,computed(() => JSON.stringify(store.vault)) 需 store——
              // 修正:BackupCard 需 vaultJson,故 SyncPage props 增加 store: VueStore;pageProps 分发同步调整)
SecurityPage: props { securityPlatform?: SecurityPlatform | null }
SettingsPage: props { store: VueStore; securityPlatform?: SecurityPlatform | null; showDesktop: boolean; showExtension: boolean }
              // 外观区:MdSegmentedButton(自动/浅色/深色 ← useTheme(store).mode)+ 色板圆点(THEME_PALETTES 渲染,style background=entry.hex,
              // 选中环 outline 2px primary;点击写 useTheme(store).color)+ 当前生效模式展示(resolvedMode)
              // 通用区:showDesktop→失焦自动隐藏(写 store.settings.blurHideEnabled+commitSettings);
              //          showExtension→URL 过滤开关、popup 关闭延迟(number 输入,毫秒,写 settings.popupCloseDelayMs)
              //          剪贴板自动清除(securityPlatform.setClipboardClear,沿用现 SecurityCard 内开关语义,SecurityCard 保留不动、设置页同步提供一份)
```

- [ ] **Step 1: 写失败测试**(ImportPage:platform.readImportFile=null → 不渲染 ImportCard;SyncPage:三卡按 props 缺省不渲染;SettingsPage:点 teal 圆点 → settings.themeColor='teal' 且 commitSettings 调用、镜像写入;模式分段按钮 → themeMode 写入;showDesktop=false 不渲染失焦开关)
- [ ] **Step 2: 跑测试确认失败**;**Step 3: 实现四页**(前三页为「MdCard 区块 + 现有卡片组件」的薄壳;SettingsPage 为全新实现)
- [ ] **Step 4: 跑测试通过 + Commit**

```bash
pnpm --filter @totp/ui test -- pages && pnpm --filter @totp/ui typecheck
git add packages/ui/src/pages packages/ui/test/pages
git commit -m "feat(ui): 导入/同步/安全/设置四页(设置页含主题外观区)

why: 5页IA补齐;主题色/模式设置是本次重设计的用户可见入口(设计文档§5设置页)。
what: 三页薄壳复用现有卡片;SettingsPage外观区(模式分段+10色板圆点)+通用区按平台显隐。"
```

---

### Task 12: 四入口最终接线(桌面 router/shell、options 同构、popup/mini 深链)

**Files:**
- Modify: `apps/desktop/src/App.vue`、`apps/desktop/src/main.ts`、`apps/extension/entrypoints/options/App.vue`、`apps/extension/entrypoints/options/main.ts`、`apps/extension/entrypoints/popup/App.vue`、`apps/desktop/src/MiniApp.vue`
- Test: 既有各入口相关测试回归;`apps/extension/test/` 回归

**要点(实现者必读,逐入口):**
1. **桌面 App.vue**:现 291 行的平台适配器代码(backupPlatform/cloudPlatform/securityPlatform/dpapiOps/schemesApi/backupMode 等)**原样保留**;模板改为:`loadError` 错误条 → `LockScreen`(未解锁)→ `NavigationShell`(已解锁,传入全部 platform/props + `railActions=[{ label: '隐藏到托盘', onClick: () => getCurrentWindow().hide() }]`);`onFocusChanged` 失焦隐藏监听与 `copyToClipboard`/`clearer` 留在 App.vue(Shell→CodesPage `@copy` 上抛);`createWebHashHistory` router 在 main.ts 创建:`createRouter({ history: createWebHashHistory(), routes: themeRoutes })`。
2. **扩展 options/App.vue**:同构接入(store 单例来自 `../../src/store`,platform 实现保留;无 railActions);确认其现有设置控件(URL 过滤/popup 延迟等)已由 SettingsPage 承接后移除原控件。
3. **popup/App.vue**:不进 router。仅:useTheme 已接(Task 3);新增右上 `MdIconButton`(设置,齿轮 path 自 navIcons)→ `chrome.runtime.openOptionsPage()`;设置深链直达外观页改用 `chrome.tabs.create({ url: chrome.runtime.getURL('options.html#/settings') })`(openOptionsPage 不支持 hash)。
4. **MiniApp.vue**:不进 router;确认 Task 3/4 后已换肤,本任务核对 mini 窗口在深色模式下首帧无白闪(html 内联脚本已就位)。

- [ ] **Step 1: 桌面接线 + 回归**(typecheck + 桌面相关测试;`pnpm --filter @totp/desktop build` 确认产物生成)→ commit:

```bash
git add apps/desktop
git commit -m "feat(desktop): 主窗口接入NavigationShell五页路由(平台适配层保留)

why: 桌面是5页IA的主载体(设计文档§5);托盘隐藏迁移为Rail底部动作。
what: App.vue模板收敛为LockScreen/Shell分支,hash router接线,失焦隐藏与剪贴板链路不变。"
```

- [ ] **Step 2: options 接线 + popup 设置入口 + mini 核对** → commit:

```bash
pnpm --filter @totp/extension build && pnpm -r test
git add apps/extension
git commit -m "feat(extension): options同构五页接入+popup设置深链(#/settings)

why: options与桌面同构复用页面,popup保持轻量纯列表(设计文档D2/D4)。
what: options接Shell/popup加设置图标深链/mini换肤核对。"
```

---

### Task 13: 清理与验收(VaultManager 散场 + 全量矩阵)

**Files:**
- Delete: `packages/ui/src/components/VaultManager.vue`、`packages/ui/test/VaultManager.test.ts`(用例已分流至 CodesPage/各对话框测试)
- Modify: `packages/ui/src/index.ts`(移除 VaultManager 导出;rg 确认无残余引用)

- [ ] **Step 1: 删除与引用清理** —— `rg -n "VaultManager" packages apps --glob '!**/.output/**'` 清零(文档/历史提交除外)。
- [ ] **Step 2: 全量验证** —— `pnpm -r test && pnpm -r typecheck`;四入口构建(`pnpm --filter @totp/desktop build && pnpm --filter @totp/extension build`);核对 extension popup 产物体积对比 main 基线(记录在 commit message;md/ 组件 tree-shake 后 popup 引用增量应 <15KB,超出则排查 popup 误引页面组件)。
- [ ] **Step 3: 真机矩阵验收**(人工/浏览器自动化,结果回填 docs/review/):四入口 × 明/暗/auto × ≥2 种子色(blue/slate):首帧无错主题闪烁、色板切换即时生效、五页导航、reveal/右键/置顶/分组/HOTP 语义逐条过。
- [ ] **Step 4: Commit**

```bash
git add -A packages/ui
git commit -m "refactor(ui): VaultManager散场(用例已分流至CodesPage与对话框测试)

why: 五页拆分完成后单页组件完成历史使命,保留会造成双实现漂移。
what: 删除VaultManager及其导出与旧测试,索引清理,全量验证通过。"
```

---

## Self-Review 记录(计划完成后自查)

- **Spec 覆盖**:§3 架构→Task 2/3/8;§4 主题系统→Task 1/2/3;§4.3 token 化→Task 4;§5 五页→Task 8/9/10/11/12;§6 组件→Task 5/6/7/8;§7 改造清单→Task 4/9/10/12/13;§8 测试→各任务 TDD + Task 13 矩阵;§9 顺序与本任务序一致。无缺口。
- **占位符扫描**:无 TBD/TODO;所有代码步均给出实际代码或精确契约;「参照现文件」仅限迁移类任务并附逐条行为清单。
- **类型一致性**:`ThemeMode`(core)与 `ThemeModeValue`(ui)命名区分已注明;`SyncPage` 需 `store`(BackupCard 的 vaultJson)已在 Task 11 Interfaces 内修正并回写 pageProps 分发说明;md 组件 props 契约在 Task 5/6/7/8 与测试一致。
