# 全量图标库与选择器标签/来源筛选 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内置图标全量收录 Simple Icons（精选同步+全量懒加载），选择器格子加可见标签、按来源（内置/上传/各导入包）筛选，包导入改为命名对话框（快捷填入覆盖），服务商推荐纳入包图标。

**Architecture:** 精选 218 项继续同步打包在 core（`builtin.json`）；全量 3460 项由 gen 脚本产出 `packages/ui/src/assets/icons-full.json`，ui 层 `fullIcons.ts` 打开选择器时 fetch 并经 `registerIcons` 合并进 core 注册表。iconStore 新增 `iconpacks` 注册表（normKey→{name,iconIds}）承载按包筛选/替换/删除，来源归属派生判定零迁移。`suggestIcons` 返回类型演进为 `IconSuggestion`（含 source）并接受 extra 候选，使 stored 图标进入推荐与搜索。

**Tech Stack:** TypeScript / Vue 3 `<script setup>` / vitest（core、ui 各自 vitest run；scripts 走根 vitest）/ Vite `?url` 资产导入（WXT 与桌面端同机制）/ 无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-05-full-icons-picker-design.md`

## Global Constraints

- 不新增任何 npm 依赖；大列表窗口化手写实现。
- Simple Icons CC0 单色 path；gen 脚本「上游下架 slug 警告跳过」机制保留。
- 精选集形状不变：218 项 + 58 别名（上游 pinned 16.31.0；若未来有意改白名单，同步改测试断言）。
- 来源归属为**派生判定**（id ∈ 包 iconIds → 该包；否则「上传」），不写迁移数据。
- 测试命令：`pnpm --filter @totp/core test`、`pnpm --filter @totp/ui test`、根 `pnpm test`、`pnpm typecheck`、`pnpm check:i18n`；最终 `pnpm test:coverage` 过 CI gate（statements 71 / branches 54）。
- i18n zh/en 同步新增词条（`pnpm check:i18n` 校验）。
- commit 用 Angular 规范中文，why 先行，逐任务原子提交。
- jsdom 无布局：选择器窗口化在容器高为 0 时回退渲染 30 项，滚动容器挂 `data-total` 供测试断言全量数。
- 已知项目坑位：App 层组装形状变化须同步 store.shape/导出快照守卫测试；测试中模块单例用 `vi.resetModules()`；Vue Boolean prop 走 withDefaults。

---

### Task 1: gen 脚本产出全量 icons-full.json

**Files:**
- Modify: `scripts/gen-builtin-icons.mjs`
- Create: `scripts/gen-builtin-icons.test.mjs`
- Generate（产物入库）: `packages/ui/src/assets/icons-full.json`

**Interfaces:**
- Consumes: `simple-icons`（@totp/core devDependency，createRequire 从 core 包解析）。
- Produces: `packages/ui/src/assets/icons-full.json`，形状 `{ icons: Record<slug, { id, title, path }> }`，全量（含精选 218）；`builtin.json` 输出不变形状不变。Task 3 的 `fullIcons.ts` 按此形状 fetch+parse。

- [ ] **Step 1: 写失败测试**

```js
// scripts/gen-builtin-icons.test.mjs
// gen-builtin-icons 自动化测试：产物形状/数量/幂等此前零测试。真实子进程跑脚本，
// 断言 builtin.json（精选 218+58 别名）与 icons-full.json（全量，含精选）形状，
// 并重跑一次断言字节级幂等。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const GEN = fileURLToPath(new URL('./gen-builtin-icons.mjs', import.meta.url))
const CORE_JSON = fileURLToPath(new URL('../packages/core/src/icons/builtin.json', import.meta.url))
const FULL_JSON = fileURLToPath(new URL('../packages/ui/src/assets/icons-full.json', import.meta.url))

const run = () => execFileSync('node', [GEN], { encoding: 'utf8' })

describe('gen-builtin-icons', () => {
  it('builtin.json：218 项精选 + 58 条别名，形状 {id,title,path}', () => {
    run()
    const data = JSON.parse(readFileSync(CORE_JSON, 'utf8'))
    expect(Object.keys(data.icons)).toHaveLength(218)
    expect(Object.keys(data.aliases)).toHaveLength(58)
    for (const icon of Object.values(data.icons)) {
      expect(Object.keys(icon).sort()).toEqual(['id', 'path', 'title'])
      expect(icon.path).toMatch(/^M/)
    }
  })

  it('icons-full.json：全量（≥3400 项）且包含全部精选 id', () => {
    run()
    const full = JSON.parse(readFileSync(FULL_JSON, 'utf8'))
    const curated = JSON.parse(readFileSync(CORE_JSON, 'utf8'))
    const ids = Object.keys(full.icons)
    expect(ids.length).toBeGreaterThanOrEqual(3400)
    for (const id of Object.keys(curated.icons)) expect(full.icons[id]).toBeDefined()
    for (const icon of Object.values(full.icons)) {
      expect(Object.keys(icon).sort()).toEqual(['id', 'path', 'title'])
    }
  })

  it('幂等：连续两次运行产物字节一致', () => {
    run()
    const coreA = readFileSync(CORE_JSON)
    const fullA = readFileSync(FULL_JSON)
    run()
    expect(readFileSync(CORE_JSON).equals(coreA)).toBe(true)
    expect(readFileSync(FULL_JSON).equals(fullA)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:scripts -- gen-builtin-icons`
Expected: FAIL——`icons-full.json` 不存在（ENOENT），builtin.json 断言可能先过。

- [ ] **Step 3: 实现脚本改动**

在 `scripts/gen-builtin-icons.mjs` 的 `main()` 中，`writeFileSync(outPath, ...)` 之后追加（`mkdirSync` 复用既有导入）：

```js
  // 全量集：simple-icons 全部图标（含精选），供 ui 层懒加载（spec 2026-10-05 §1）。
  // 断言 <5MB 防上游体积膨胀失控。
  const full = {}
  for (const slug of bySlug.keys()) {
    const { title, path } = bySlug.get(slug)
    full[slug] = { id: slug, title, path }
  }
  const fullJson = JSON.stringify({ icons: full }, null, 2) + '\n'
  if (fullJson.length > 5 * 1024 * 1024) throw new Error(`icons-full 超过 5MB：${fullJson.length}`)
  const fullOutPath = resolve(root, 'packages/ui/src/assets/icons-full.json')
  mkdirSync(dirname(fullOutPath), { recursive: true })
  writeFileSync(fullOutPath, fullJson)
  console.log(`icons-full.json 已生成: ${Object.keys(full).length} 个图标`)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test:scripts -- gen-builtin-icons`
Expected: PASS（3 个用例）。同时 `git status` 应只新增 `packages/ui/src/assets/icons-full.json`，`builtin.json` 无 diff（精选逻辑未动）。

- [ ] **Step 5: 提交**

```bash
git add scripts/gen-builtin-icons.mjs scripts/gen-builtin-icons.test.mjs packages/ui/src/assets/icons-full.json
git commit -m "feat(scripts): gen 脚本产出全量 icons-full.json 并补自动化测试

为什么：全量收录 Simple Icons 需要独立懒加载资产（精选 218 同步、全量 3460 懒加载），
此前 gen 脚本零测试，产物形状与幂等无门禁。"
```

---

### Task 2: core registry — registerIcons 与 suggestIcons 演进

**Files:**
- Modify: `packages/core/src/icons/registry.ts`
- Test: `packages/core/test/iconRegistry.test.ts`

**Interfaces:**
- Consumes: Task 1 无直接依赖（registerIcons 由 Task 3 调用）。
- Produces（Task 3/7/8 依赖的精确签名）:
  - `registerIcons(icons: ReadonlyArray<BuiltinIcon>): void` —— 合并进内部 ICONS map，幂等。
  - `interface IconSuggestion { id: string; title: string; source: 'builtin' | 'extra'; path?: string }`
  - `suggestIcons(issuer: string, limit?: number, extra?: ReadonlyArray<{ id: string; title?: string }>): IconSuggestion[]` —— extra 候选与内置同管线排名；同距离 builtin 优先；extra 与内置同 id 时跳过（内置优先）。返回 builtin 项带 `path`、`source: 'builtin'`；extra 项 `title` 回退为 id、无 path。
  - 既有 `getBuiltinIcons` / `normalizeIssuer` / `IconRef` / `BuiltinIcon` 不变。导出经 `packages/core/src/index.ts` 的 `export * from './icons/registry'` 自动生效。

- [ ] **Step 1: 写失败测试**（追加到 `packages/core/test/iconRegistry.test.ts`，沿用文件内既有 import；先读该文件确认现有 describe 结构）

```ts
describe('registerIcons', () => {
  it('合并新图标并可被 getBuiltinIcons 读出；重复注册幂等', () => {
    registerIcons([{ id: 'zzz-reg-test', title: 'Reg Test', path: 'M0 0L1 1' }])
    registerIcons([{ id: 'zzz-reg-test', title: 'Reg Test', path: 'M0 0L1 1' }])
    expect(getBuiltinIcons()['zzz-reg-test']).toEqual({ id: 'zzz-reg-test', title: 'Reg Test', path: 'M0 0L1 1' })
  })
})

describe('suggestIcons extra 候选', () => {
  it('返回 IconSuggestion：builtin 项带 path 且 source=builtin', () => {
    const r = suggestIcons('github', 1)
    expect(r[0]).toMatchObject({ id: 'github', title: 'GitHub', source: 'builtin' })
    expect(r[0]!.path).toBeTruthy()
  })

  it('extra（stored 图标 id）参与同一 normalize+距离管线', () => {
    const r = suggestIcons('githacks', 5, [{ id: 'githacks' }])
    expect(r[0]).toMatchObject({ id: 'githacks', title: 'githacks', source: 'extra' })
    expect(r[0]!.path).toBeUndefined()
  })

  it('同距离 builtin 优先于 extra；距离不同按距离升序', () => {
    // 'gogs' 与精选 gogs？若无此 slug 则用任意既有 id 演练：构造与查询同距的 builtin/extra
    const r = suggestIcons('gitlbb', 5, [{ id: 'gitlbb' }])
    // gitlbb 作为 extra 精确命中 dist 0；builtin 最近项距离 > 0 → extra 第一
    expect(r[0]).toMatchObject({ id: 'gitlbb', source: 'extra' })
    const r2 = suggestIcons('gitlab', 5, [{ id: 'gitlaa' }])
    // gitlab 精确 dist 0 优于 gitlaa（dist 2）——builtin 第一
    expect(r2[0]).toMatchObject({ id: 'gitlab', source: 'builtin' })
  })

  it('extra 与内置同 id 时跳过（内置优先，不产生重复项）', () => {
    const r = suggestIcons('github', 5, [{ id: 'github' }])
    expect(r.filter((s) => s.id === 'github')).toHaveLength(1)
    expect(r[0]!.source).toBe('builtin')
  })

  it('extra 的 title 参与匹配且输出 title 优先于 id', () => {
    const r = suggestIcons('我的仓库', 5, [{ id: 'gogsx', title: '我的仓库' }])
    expect(r[0]).toMatchObject({ id: 'gogsx', title: '我的仓库', source: 'extra' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/core test -- iconRegistry`
Expected: FAIL——`registerIcons` 未导出；suggestIcons 返回对象无 `source` 字段。

- [ ] **Step 3: 实现 registry.ts 改动**

`registry.ts` 全量替换为：

```ts
import data from './builtin.json'

export type IconRef =
  | { kind: 'builtin'; id: string }
  | { kind: 'stored'; id: string }
  | { kind: 'url'; id: string; url: string }

export interface BuiltinIcon {
  id: string
  title: string
  /** Simple Icons 24x24 path data */
  path: string
}

/** 推荐候选：builtin 项带 path；extra（stored 图标 id 等）无 path */
export interface IconSuggestion {
  id: string
  title: string
  source: 'builtin' | 'extra'
  path?: string
}

const ICONS = data.icons as Record<string, BuiltinIcon>
const ALIASES = data.aliases as Record<string, string>

/** 全部内置图标，键为图标 id（Simple Icons slug） */
export function getBuiltinIcons(): Record<string, BuiltinIcon> {
  return ICONS
}

/** 全量集（icons-full.json）加载后合并进注册表；幂等（同 id 覆盖） */
export function registerIcons(icons: ReadonlyArray<BuiltinIcon>): void {
  for (const icon of icons) ICONS[icon.id] = icon
}

/** 小写并去除空白/点/连字符/下划线，用于发行方匹配 */
export function normalizeIssuer(name: string): string {
  return name.toLowerCase().replace(/[\s._-]+/g, '')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = curr
  }
  return prev[b.length]!
}

/**
 * 图标推荐：normalize 后按莱文斯坦距离升序（含精确命中 dist 0），同距 builtin 优先、
 * 再按 id 字典序。候选含内置 id/title/别名键 + extra 候选（stored 图标 id，已 normalize）；
 * 子串包含免距离阈值（前缀搜索补全），默认 5 条。
 * extra 与内置同 id 时跳过（内置优先）。阈值随输入长度放宽（3 字符容差 1、6 字符容差 2），上限 3。
 */
export function suggestIcons(
  issuer: string,
  limit: number = 5,
  extra: ReadonlyArray<{ id: string; title?: string }> = [],
): IconSuggestion[] {
  const key = normalizeIssuer(issuer)
  if (!key) return []
  const maxDist = Math.min(3, Math.max(1, Math.floor(key.length / 3)))
  interface Hit {
    title: string
    path?: string
    /** 包含命中时恰为长度差，与纠错距离同轴可比 */
    dist: number
    builtin: boolean
  }
  const best = new Map<string, Hit>()
  const consider = (text: string, iconId: string, title: string, path: string | undefined, builtin: boolean) => {
    const norm = normalizeIssuer(text)
    if (!norm) return
    const included = norm.includes(key) || key.includes(norm)
    const dist = levenshtein(key, norm)
    if (!included && dist > maxDist) return
    const prev = best.get(iconId)
    if (!prev || dist < prev.dist) best.set(iconId, { title, path, dist, builtin })
  }
  for (const icon of Object.values(ICONS)) {
    consider(icon.id, icon.id, icon.title, icon.path, true)
    consider(icon.title, icon.id, icon.title, icon.path, true)
  }
  for (const [alias, id] of Object.entries(ALIASES)) {
    const icon = ICONS[id]
    if (icon) consider(alias, id, icon.title, icon.path, true)
  }
  for (const cand of extra) {
    if (ICONS[cand.id]) continue
    consider(cand.id, cand.id, cand.title ?? cand.id, undefined, false)
  }
  return [...best.entries()]
    .map(([id, h]) => ({ id, title: h.title, source: h.builtin ? ('builtin' as const) : ('extra' as const), ...(h.path ? { path: h.path } : {}) }))
    .sort((a, b) => {
      const ha = best.get(a.id)!, hb = best.get(b.id)!
      return ha.dist - hb.dist || (ha.builtin ? 0 : 1) - (hb.builtin ? 0 : 1) || a.id.localeCompare(b.id)
    })
    .slice(0, limit)
}
```

- [ ] **Step 4: 跑测试并修复受返回类型影响的既有断言**

Run: `pnpm --filter @totp/core test`
Expected: 新用例 PASS；若既有 suggestIcons 断言对返回对象做**深比较**（如 `toEqual({ id, title, path })`），在期望对象上补 `source: 'builtin'`（例如 `expect(suggestIcons('github', 1)[0]).toEqual({ id: 'github', title: 'GitHub', path: expect.any(String), source: 'builtin' })`）；仅取 `.id`/`.title` 的断言无需改。直至 core 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/icons/registry.ts packages/core/test/iconRegistry.test.ts
git commit -m "feat(core): registerIcons 全量合并 + suggestIcons 支持 extra 候选

为什么：全量懒加载后需把 icons-full 合并进注册表；服务商推荐要纳入
stored 包图标（spec 2026-10-05 修订二），返回类型演进为 IconSuggestion
（含 source），同距离 builtin 优先。"
```

---

### Task 3: ui 全量懒加载器 fullIcons.ts

**Files:**
- Create: `packages/ui/src/fullIcons.ts`
- Modify（仅当 typecheck 报缺声明）: `packages/ui/src/env.d.ts`
- Test: `packages/ui/test/fullIcons.test.ts`

**Interfaces:**
- Consumes: Task 1 的资产 `../assets/icons-full.json`（形状 `{ icons: Record<slug, BuiltinIcon> }`）；Task 2 的 `registerIcons`。
- Produces（Task 7/9 依赖）:
  - `ensureFullIcons(): Promise<void>` —— 一次性 fetch + registerIcons；ready 后短路；失败清缓存并置 `fullIconsError=true` 允许重试。
  - `fullIconsReady: Ref<boolean>`、`fullIconsError: Ref<boolean>`（模块级单例响应式标志）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/ui/test/fullIcons.test.ts
// 模块级单例（ready 标志 + in-flight promise）：每用例 vi.resetModules + 动态 import
// 取全新实例，避免跨用例状态污染；fetch 用 vi.stubGlobal 注入。
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function fresh() {
  vi.resetModules()
  return import('../src/fullIcons')
}

const okJson = () =>
  new Response(JSON.stringify({ icons: { zzzfull: { id: 'zzzfull', title: 'Full Test', path: 'M0 0' } } }), {
    status: 200,
  })

describe('ensureFullIcons', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('首次调用 fetch 资产并注册进 core 注册表，置 ready', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson())
    vi.stubGlobal('fetch', fetchMock)
    const mod = await fresh()
    await mod.ensureFullIcons()
    expect(mod.fullIconsReady.value).toBe(true)
    expect(mod.fullIconsError.value).toBe(false)
    const { getBuiltinIcons } = await import('@totp/core')
    expect(getBuiltinIcons()['zzzfull']?.title).toBe('Full Test')
  })

  it('ready 后短路：不再发起 fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson())
    vi.stubGlobal('fetch', fetchMock)
    const mod = await fresh()
    await mod.ensureFullIcons()
    await mod.ensureFullIcons()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('失败置 error、清 in-flight，重试可成功', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(okJson())
    vi.stubGlobal('fetch', fetchMock)
    const mod = await fresh()
    await expect(mod.ensureFullIcons()).rejects.toThrow('boom')
    expect(mod.fullIconsError.value).toBe(true)
    await mod.ensureFullIcons()
    expect(mod.fullIconsReady.value).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('HTTP 非 2xx 视为失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 404 })))
    const mod = await fresh()
    await expect(mod.ensureFullIcons()).rejects.toThrow('HTTP 404')
    expect(mod.fullIconsReady.value).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- fullIcons`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 fullIcons.ts**

```ts
// packages/ui/src/fullIcons.ts
// 全量图标集懒加载（spec 2026-10-05 §1）：精选 218 项随包同步，全量 3460 项为独立
// 资产（gen 脚本产出），打开选择器时一次性 fetch + registerIcons 合并进 core 注册表。
// ready/error 为模块级响应式标志：依赖 builtin path 解析的计算属性（CodesPage/popup
// 的 entryIcons）纳入 fullIconsReady 依赖，加载完成后非精选 builtin 引用自动补渲染。
import { ref } from 'vue'
import { registerIcons, type BuiltinIcon } from '@totp/core'
import fullIconsUrl from '../assets/icons-full.json?url'

export const fullIconsReady = ref(false)
export const fullIconsError = ref(false)
let inflight: Promise<void> | null = null

export function ensureFullIcons(): Promise<void> {
  if (fullIconsReady.value) return Promise.resolve()
  if (!inflight) {
    fullIconsError.value = false
    inflight = fetch(fullIconsUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<{ icons: Record<string, BuiltinIcon> }>
      })
      .then((data) => {
        registerIcons(Object.values(data.icons))
        fullIconsReady.value = true
      })
      .catch((e) => {
        inflight = null
        fullIconsError.value = true
        throw e
      })
  }
  return inflight
}
```

- [ ] **Step 4: typecheck（按需补 `?url` 模块声明）**

Run: `pnpm --filter @totp/ui typecheck`
若报 `Cannot find module '...icons-full.json?url'`：在 `packages/ui/src/env.d.ts` 追加

```ts
declare module '*.json?url' {
  const src: string
  export default src
}
```

否则跳过。再跑一次 typecheck 至通过。

- [ ] **Step 5: 跑测试确认通过并提交**

Run: `pnpm --filter @totp/ui test -- fullIcons` → PASS

```bash
git add packages/ui/src/fullIcons.ts packages/ui/test/fullIcons.test.ts packages/ui/src/env.d.ts
git commit -m "feat(ui): 全量图标集懒加载器 fullIcons

为什么：全量 3.5MB 资产不进主包，打开选择器时才 fetch 并注册进 core；
ready/error 响应式标志驱动依赖方补渲染。"
```

---

### Task 4: iconStore 包注册表

**Files:**
- Modify: `packages/ui/src/iconStore.ts`
- Test: `packages/ui/test/iconStorePacks.test.ts`（新建；fake adapter 沿用 `packages/ui/test/iconStore.test.ts` 中的现有 fake 写法——先读该文件照抄其 adapter 构造）

**Interfaces:**
- Consumes: 既有 `createIconStore(adapter)` / `StorageAdapter`。
- Produces（Task 5/7/8 依赖）:
  - `interface IconPackInfo { name: string; iconIds: string[] }`
  - `IconStore` 新增成员：
    - `packs: Readonly<Record<string, IconPackInfo>>`（reactive，键为 normalize 后的包身份）
    - `upsertPack(normKey: string, info: IconPackInfo): Promise<void>`
    - `removePack(normKey: string): Promise<void>`（删该包全部图标 + 注册表条目；包不存在时 no-op）
    - `removeMany(ids: string[]): Promise<void>`（批量删图标，单次落盘）
  - 持久化键 `'iconpacks'`，`init()` 同步装载。

- [ ] **Step 1: 写失败测试**（fake adapter 从 iconStore.test.ts 照抄；下例假设该 fake 名为 `fakeAdapter()`，按实际调整）

```ts
// packages/ui/test/iconStorePacks.test.ts
import { describe, expect, it } from 'vitest'
import { createIconStore } from '../src/iconStore'
// import { fakeAdapter } from './iconStore.test' —— 若未导出则在本文件内照抄同款构造

describe('iconStore 包注册表', () => {
  it('upsertPack 写入并持久化；新实例 init 装载', async () => {
    const adapter = fakeAdapter()
    const store = createIconStore(adapter)
    await store.put('icon-a', 'data:image/png;base64,AA')
    await store.upsertPack('testpack', { name: 'Test Pack', iconIds: ['icon-a'] })
    const store2 = createIconStore(adapter)
    await store2.init()
    expect(store2.packs['testpack']).toEqual({ name: 'Test Pack', iconIds: ['icon-a'] })
  })

  it('upsert 同 normKey 覆盖显示名与 iconIds', async () => {
    const store = createIconStore(fakeAdapter())
    await store.upsertPack('k', { name: 'Old', iconIds: ['a'] })
    await store.upsertPack('k', { name: 'New', iconIds: ['b'] })
    expect(store.packs['k']).toEqual({ name: 'New', iconIds: ['b'] })
  })

  it('removePack 删除包图标与注册表条目；包不存在 no-op', async () => {
    const adapter = fakeAdapter()
    const store = createIconStore(adapter)
    await store.put('a', 'data:image/png;base64,AA')
    await store.put('keep', 'data:image/png;base64,AA')
    await store.upsertPack('k', { name: 'K', iconIds: ['a'] })
    await store.removePack('k')
    expect(store.icons['a']).toBeUndefined()
    expect(store.icons['keep']).toBeDefined()
    expect(store.packs['k']).toBeUndefined()
    await store.removePack('missing') // 不抛错
    const store2 = createIconStore(adapter)
    await store2.init()
    expect(store2.icons['a']).toBeUndefined()
    expect(store2.packs['k']).toBeUndefined()
  })

  it('removeMany 批量删除且单次落盘', async () => {
    const adapter = fakeAdapter()
    const store = createIconStore(adapter)
    await store.putMany({ a: 'x', b: 'y', c: 'z' })
    await store.removeMany(['a', 'b'])
    expect(store.icons['a']).toBeUndefined()
    expect(store.icons['c']).toBe('z')
    const store2 = createIconStore(adapter)
    await store2.init()
    expect(store2.icons['c']).toBe('z')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- iconStorePacks`
Expected: FAIL——`upsertPack`/`removePack`/`removeMany`/`packs` 不存在。

- [ ] **Step 3: 实现 iconStore.ts 改动**

`iconStore.ts` 逐处修改：

```ts
// IconStore 接口新增（icons 字段声明之后）：
  /** 包注册表（normKey → { 显示名, 图标 id 清单 }），reactive；来源筛选/替换/删除的单一事实源 */
  packs: Readonly<Record<string, IconPackInfo>>
  upsertPack(normKey: string, info: IconPackInfo): Promise<void>
  /** 删除整包：移除该包全部图标 + 注册表条目；引用悬空由 UI 层回退（首字母） */
  removePack(normKey: string): Promise<void>
  /** 批量删除图标 id（不含 urlcache: 命名空间），单次落盘 */
  removeMany(ids: string[]): Promise<void>

// 模块级新增：
export interface IconPackInfo {
  /** 显示名（保留用户输入原名） */
  name: string
  /** 归属该包的图标 id 清单 */
  iconIds: string[]
}
const PACKS_KEY = 'iconpacks'

// createIconStore 内：
  const packs = reactive<Record<string, IconPackInfo>>({})

// init() 中读取 icons 之后追加（同样 try/catch JSON.parse 容错）：
    const rawPacks = await adapter.get(PACKS_KEY)
    if (rawPacks !== null) {
      try {
        Object.assign(packs, JSON.parse(rawPacks) as Record<string, IconPackInfo>)
      } catch {
        // 损坏按空注册表处理，不阻断启动
      }
    }

// 新增函数（persist 旁）：
  async function persistPacks(): Promise<void> {
    await adapter.set(PACKS_KEY, JSON.stringify(packs))
  }

  async function upsertPack(normKey: string, info: IconPackInfo): Promise<void> {
    packs[normKey] = info
    await persistPacks()
  }

  async function removeMany(ids: string[]): Promise<void> {
    for (const id of ids) delete icons[id]
    await persist()
  }

  async function removePack(normKey: string): Promise<void> {
    const info = packs[normKey]
    if (!info) return
    for (const id of info.iconIds) delete icons[id]
    delete packs[normKey]
    await persist()
    await persistPacks()
  }

// return 对象补：packs, upsertPack, removePack, removeMany
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui test -- iconStore`
Expected: 新文件 PASS；既有 `iconStore.test.ts` / `iconStore.edges.test.ts` 不回归。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/iconStore.ts packages/ui/test/iconStorePacks.test.ts
git commit -m "feat(ui): iconStore 包注册表（upsert/remove/removeMany）

为什么：按包筛选/整包替换/删除需要包→图标清单的单一事实源；
来源归属走派生判定（id ∈ 包 iconIds），零数据迁移。"
```

---

### Task 5: importIconPackZip 接受包名并落地替换语义

**Files:**
- Modify: `packages/ui/src/iconImport.ts`
- Modify（保持 typecheck 绿的最小适配）: `packages/ui/src/components/EntryForm.vue`（`importIconPackZip` 调用点补第三参）
- Test: `packages/ui/test/iconImport.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `upsertPack` / `removeMany` / `packs`；既有 `normalizeIssuer`（@totp/core）。
- Produces:
  - `importIconPackZip(zipBytes: Uint8Array, icons: Pick<IconStore, 'putMany' | 'removeMany' | 'upsertPack' | 'packs'>, pack: { name: string }): Promise<IconPackResult & { packName: string }>`
  - 语义：`pack.name` 空白 → 解压前抛 `Error('包名不能为空')`；身份 `normKey = normalizeIssuer(pack.name)`；同名重导 = 整包替换（旧 iconIds 中不在新集合者 `removeMany`，注册表收敛为新集合全集，显示名更新为本次输入）；`packName` 返回 trim 后显示名。

- [ ] **Step 1: 更新与新增测试**

先读 `packages/ui/test/iconImport.test.ts`：为既有每个 `importIconPackZip(bytes, store)` 调用补第三参 `{ name: '测试包' }`；store mock 对象补 `packs: {}`、`removeMany: vi.fn(async () => {})`、`upsertPack: vi.fn(async () => {})`。追加：

```ts
describe('包名与替换语义', () => {
  function makeStore() {
    return {
      icons: {} as Record<string, string>,
      packs: {} as Record<string, { name: string; iconIds: string[] }>,
      putMany: vi.fn(async (entries: Record<string, string>) => { Object.assign(store.icons, entries) }),
      removeMany: vi.fn(async (ids: string[]) => { for (const id of ids) delete store.icons[id] }),
      upsertPack: vi.fn(async (key: string, info: { name: string; iconIds: string[] }) => { store.packs[key] = info }),
    }
  }

  it('空白包名：解压前直接抛错', async () => {
    const store = makeStore()
    await expect(importIconPackZip(VALID_ZIP_BYTES, store, { name: '   ' })).rejects.toThrow('包名不能为空')
    expect(store.putMany).not.toHaveBeenCalled()
  })

  it('写入包注册表：normKey 身份 + 显示名 + 新集合 iconIds；返回 packName', async () => {
    const store = makeStore()
    const r = await importIconPackZip(VALID_ZIP_BYTES, store, { name: ' My Pack ' })
    expect(r.packName).toBe('My Pack')
    expect(store.packs['mypack']).toEqual({ name: 'My Pack', iconIds: r.names })
  })

  it('同名重导整包替换：旧集合中不在新包的 id 被 removeMany', async () => {
    const store = makeStore()
    store.packs['mypack'] = { name: 'My Pack', iconIds: ['ghosticon', 'github'] }
    store.icons['ghosticon'] = 'data:image/png;base64,AA'
    const r = await importIconPackZip(VALID_ZIP_BYTES, store, { name: 'My Pack' })
    const newIds = new Set(r.names)
    expect(store.removeMany).toHaveBeenCalledWith(['ghosticon'].filter((id) => !newIds.has(id)))
    if (!newIds.has('ghosticon')) expect(store.icons['ghosticon']).toBeUndefined()
    expect(store.packs['mypack']!.iconIds).toEqual(r.names)
  })
})
```

（`VALID_ZIP_BYTES` 用该测试文件既有的 zip 构造 helper/fixture；先读文件复用。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- iconImport`
Expected: FAIL——签名第三参不存在/未写注册表。

- [ ] **Step 3: 实现**

`iconImport.ts`：函数签名与开头、结尾改为

```ts
export async function importIconPackZip(
  zipBytes: Uint8Array,
  icons: Pick<IconStore, 'putMany' | 'removeMany' | 'upsertPack' | 'packs'>,
  pack: { name: string },
): Promise<IconPackResult & { packName: string }> {
  const packName = pack.name.trim()
  if (!packName) throw new Error('包名不能为空')
  const normKey = normalizeIssuer(packName)
  if (!normKey) throw new Error('包名不能为空')
  const max = opts?.max ?? DEFAULT_MAX
  // …（原解压与统计逻辑不变；注意 max/maxBytes 仍从 opts 读，opts 参数保留）…
```

（若原签名无 `opts`，保留原参数形状：把 `pack` 加为第三参。）函数尾部（trim pending 之后、返回之前）：

```ts
  const old = icons.packs[normKey]?.iconIds ?? []
  const stale = old.filter((id) => !seen.has(id))
  if (stale.length > 0) await icons.removeMany(stale)
  if (Object.keys(pending).length > 0) await icons.putMany(pending)
  await icons.upsertPack(normKey, { name: packName, iconIds: [...seen] })
  return { imported, overwritten, skipped, skippedLarge, names: [...seen], packName }
```

`EntryForm.vue` 的调用点（`onPackFile` 内）同步改为 `importIconPackZip(bytes, props.iconStore, { name: file.name.replace(/\.zip$/i, '') })`（Task 8 会把命名换成对话框输入，这里仅保 typecheck 绿）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui test -- iconImport` → PASS；`pnpm --filter @totp/ui typecheck` → 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/iconImport.ts packages/ui/test/iconImport.test.ts packages/ui/src/components/EntryForm.vue
git commit -m "feat(ui): 图标包导入接受自定义包名并落地整包替换

为什么：命名对话框（Task 8）需要导入函数承接包名身份；
同名重导按注册表收敛旧图标，防止残留孤儿图标。"
```

---

### Task 6: IconPackImportDialog 组件

**Files:**
- Create: `packages/ui/src/components/IconPackImportDialog.vue`
- Test: `packages/ui/test/IconPackImportDialog.test.ts`
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`.../en/common.json`

**Interfaces:**
- Consumes: `MdDialog` / `MdButton` / `MdTextField`（既有 md 组件）；`normalizeIssuer`（@totp/core）；Task 4 的 `IconPackInfo` 形状。
- Produces（Task 8 依赖）:
  - props `{ open: boolean; defaultName: string; existingPacks: Readonly<Record<string, { name: string }>>; busy?: boolean; error?: string }`
  - emits `confirm: [name: string]`（trim 后名字）、`close: []`
  - 行为：open 时 name 重置为 defaultName；快捷填入 chip 点击回填显示名；normalize 命中既有包显示覆盖提示；空名/busy 禁用确认。

- [ ] **Step 1: 写失败测试**

```ts
// packages/ui/test/IconPackImportDialog.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import IconPackImportDialog from '../src/components/IconPackImportDialog.vue'
import { createTestI18n } from './helpers/i18n'

function mountDialog(props: Partial<InstanceType<typeof IconPackImportDialog>['$props']> = {}) {
  return mount(IconPackDialog, {
    global: { plugins: [createTestI18n()] },
    props: {
      open: true,
      defaultName: 'MyPack',
      existingPacks: { aegisicons: { name: 'Aegis Icons' }, mypack: { name: 'My Pack' } },
      ...props,
    },
  })
}
import IconPackDialog from '../src/components/IconPackImportDialog.vue'

describe('IconPackImportDialog', () => {
  it('open 时预填 defaultName', () => {
    const w = mountDialog()
    expect((w.find('input').element as HTMLInputElement).value).toBe('MyPack')
  })

  it('快捷填入：点击既有包 chip 回填显示名', async () => {
    const w = mountDialog()
    await w.findAll('.quick-chip').find((c) => c.text() === 'Aegis Icons')!.trigger('click')
    expect((w.find('input').element as HTMLInputElement).value).toBe('Aegis Icons')
  })

  it('normalize 命中既有包 → 显示覆盖提示', async () => {
    const w = mountDialog()
    await w.find('input').setValue('my.pack')
    expect(w.find('.override-hint').text()).toContain('My Pack')
  })

  it('空名禁用确认；确认 emit trim 后的名字', async () => {
    const w = mountDialog()
    await w.find('input').setValue('   ')
    expect(w.find('.actions button:last-child').attributes('disabled')).toBeDefined()
    await w.find('input').setValue('  Aegis Icons  ')
    await w.find('.actions button:last-child').trigger('click')
    expect(w.emitted('confirm')![0]).toEqual(['Aegis Icons'])
  })

  it('busy 时确认禁用且错误透出', () => {
    const w = mountDialog({ busy: true, error: 'boom' })
    expect(w.find('.actions button:last-child').attributes('disabled')).toBeDefined()
    expect(w.find('.error').text()).toBe('boom')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- IconPackImportDialog`
Expected: FAIL——组件不存在。

- [ ] **Step 3: 实现组件与 i18n**

```vue
<!-- packages/ui/src/components/IconPackImportDialog.vue -->
<script setup lang="ts">
import { normalizeIssuer } from '@totp/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{
  open: boolean
  /** 预填：zip 文件名去扩展名 */
  defaultName: string
  /** 既有包 normKey → { 显示名 }：快捷填入 + 覆盖提示的数据源 */
  existingPacks: Readonly<Record<string, { name: string }>>
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ confirm: [name: string]; close: [] }>()

const { t } = useI18n()
const name = ref('')
// 每次打开按最新 defaultName 重置（换 zip 重开不残留上次输入）
watch(
  () => props.open,
  (open) => {
    if (open) name.value = props.defaultName
  },
)

const trimmed = computed(() => name.value.trim())
/** 输入 normalize 后命中既有包 → 提示将覆盖（防近似重复包） */
const overrideTarget = computed(() => {
  const key = normalizeIssuer(trimmed.value)
  return key ? props.existingPacks[key]?.name : undefined
})
const canConfirm = computed(() => trimmed.value !== '' && !props.busy)
</script>

<template>
  <MdDialog :open="open" :headline="t('entryForm.iconPackImportTitle')" @close="emit('close')">
    <MdTextField
      v-model="name" :label="t('entryForm.iconPackNameLabel')"
      :placeholder="t('entryForm.iconPackNamePlaceholder')" :aria-label="t('entryForm.iconPackNameLabel')"
    />
    <p v-if="overrideTarget" class="override-hint">{{ t('entryForm.iconPackOverrideHint', { name: overrideTarget }) }}</p>
    <div v-if="Object.keys(existingPacks).length > 0" class="quick-fill">
      <p class="quick-label">{{ t('entryForm.iconPackQuickFill') }}</p>
      <div class="quick-chips">
        <button
          v-for="(p, key) in existingPacks" :key="key" type="button" class="quick-chip"
          :disabled="busy" @click="name = p.name"
        >{{ p.name }}</button>
      </div>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="actions">
      <MdButton variant="text" :disabled="busy" @click="emit('close')">{{ t('entryForm.cancel') }}</MdButton>
      <MdButton variant="filled" :disabled="!canConfirm" @click="emit('confirm', trimmed)">
        {{ t('entryForm.iconPackImportConfirm') }}
      </MdButton>
    </div>
  </MdDialog>
</template>

<style scoped>
.override-hint { font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-tertiary); margin: 4px 0; }
.quick-label { font-size: var(--md-sys-typescale-label-medium); opacity: 0.65; margin: 8px 0 4px; }
.quick-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.quick-chip { border: 1px solid var(--md-sys-color-outline-variant); border-radius: 999px; background: transparent; color: var(--md-sys-color-on-surface); padding: 2px 10px; font-size: var(--md-sys-typescale-body-small); cursor: pointer; }
.quick-chip:hover { background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent); }
.error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
```

实现前核对两点（决定后写死，不做运行时分支）：`MdTextField` 是否支持 `disabled`（若支持，包名输入框补 `:disabled="busy"`）；取消按钮文案键是否已有（rg locales 中 `cancel`，有则复用既有键名，无则用 `entryForm.cancel` 新增）。i18n 新增（zh / en 对应位置）：

```json
"iconPackImportTitle": "导入图标包",
"iconPackNameLabel": "包名称",
"iconPackNamePlaceholder": "输入图标包名称…",
"iconPackQuickFill": "填入已有包：",
"iconPackOverrideHint": "将覆盖已有包“{name}”",
"iconPackImportConfirm": "导入"
```

```json
"iconPackImportTitle": "Import icon pack",
"iconPackNameLabel": "Pack name",
"iconPackNamePlaceholder": "Enter icon pack name…",
"iconPackQuickFill": "Fill from existing packs:",
"iconPackOverrideHint": "Will overwrite existing pack \"{name}\"",
"iconPackImportConfirm": "Import"
```

- [ ] **Step 4: 跑测试与 i18n 校验确认通过**

Run: `pnpm --filter @totp/ui test -- IconPackImportDialog && pnpm check:i18n`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/IconPackImportDialog.vue packages/ui/test/IconPackImportDialog.test.ts packages/ui/src/i18n/locales
git commit -m "feat(ui): 图标包导入命名对话框（快捷填入覆盖提示）

为什么：导入包需自定义包名并可一键填入既有包名走整包替换；
normalize 命中提示防近似重复包。"
```

---

### Task 7: IconPickerDialog 改版（标签/来源筛选/跨源搜索/懒加载/窗口化）

**Files:**
- Modify: `packages/ui/src/components/IconPickerDialog.vue`（整体重写）
- Test: `packages/ui/test/IconPickerDialog.test.ts`（整体重写）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`.../en/common.json`

**Interfaces:**
- Consumes: Task 2 `suggestIcons`/`IconSuggestion`；Task 3 `ensureFullIcons`/`fullIconsReady`/`fullIconsError`；Task 4 `IconPackInfo` 形状。
- Produces（Task 8 依赖）:
  - props `{ open: boolean; builtin: Record<string, BuiltinIcon>; issuer?: string; stored?: Readonly<Record<string, string>>; packs?: Readonly<Record<string, { name: string; iconIds: string[] }>> }`
  - emits `select: [{ kind: 'builtin' | 'stored'; id: string; title: string }]`、`removePack: [normKey: string]`、`close: []`
  - 打开时触发 `ensureFullIcons()`；chips：全部/内置/上传（有上传图标才显示）/各包（显示名，× 两步确认后 emit removePack）；网格 cell = 图标 + 下方单行标签（builtin→title，stored→id）；搜索走 `suggestIcons(query, MAX_SAFE_INTEGER, storedExtras)` 后按 chip 过滤；滚动容器窗口化（`data-total` 挂全量数）。

- [ ] **Step 1: 重写测试**（先读现有 `IconPickerDialog.test.ts`，保留可保留断言；`mountPicker` 扩展 stored/packs/fetch stub）

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { getBuiltinIcons } from '@totp/core'
import IconPickerDialog from '../src/components/IconPickerDialog.vue'
import { createTestI18n } from './helpers/i18n'

const icons = getBuiltinIcons()
// 选择器 open 即触发 ensureFullIcons：stub fetch 返回微缩全量集，避免真实 3.5MB 资产
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ icons: {} }), { status: 200 })))
beforeEach(() => vi.clearAllMocks())

function mountPicker(opts: { issuer?: string; open?: boolean; stored?: Record<string, string>; packs?: Record<string, { name: string; iconIds: string[] }> } = {}) {
  return mount(IconPickerDialog, {
    global: { plugins: [createTestI18n()] },
    props: { open: opts.open ?? true, builtin: icons, issuer: opts.issuer ?? '', stored: opts.stored ?? {}, packs: opts.packs ?? {} },
  })
}
const grid = (w: ReturnType<typeof mount>) => w.find('.picker-grid--all')

describe('IconPickerDialog', () => {
  it('open=false 时不渲染对话框', () => {
    expect(mountPicker({ open: false }).find('.md-dialog').exists()).toBe(false)
  })

  it('窗口化：data-total 报全量数（≥200 精选），实际渲染 cell 数 < total（jsdom 回退 30）', () => {
    const w = mountPicker()
    expect(Number(grid(w).attributes('data-total'))).toBeGreaterThanOrEqual(200)
    expect(w.findAll('.picker-grid--all button').length).toBeLessThan(Number(grid(w).attributes('data-total')))
  })

  it('chips：默认 全部/内置；有上传图标出现「上传」；各包按显示名出现', () => {
    const w = mountPicker({ stored: { gh: 'data:image/png;base64,AA', orphan: 'data:image/png;base64,AA' }, packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } } })
    const labels = w.findAll('.picker-chip').map((c) => c.text())
    expect(labels).toContain('全部')
    expect(labels).toContain('内置')
    expect(labels).toContain('上传')
    expect(labels).toContain('My Pack')
  })

  it('chip=内置 只显 builtin；chip=包 只显该包 stored（带 id 标签与 img）', async () => {
    const w = mountPicker({ stored: { gh: 'data:image/png;base64,AA' }, packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } } })
    await w.findAll('.picker-chip').find((c) => c.text() === '内置')!.trigger('click')
    expect(w.findAll('.picker-grid--all img').length).toBe(0)
    await w.findAll('.picker-chip').find((c) => c.text() === 'My Pack')!.trigger('click')
    const cells = w.findAll('.picker-grid--all button')
    expect(cells).toHaveLength(1)
    expect(cells[0]!.find('img').attributes('src')).toBe('data:image/png;base64,AA')
    expect(cells[0]!.find('.picker-cell-label').text()).toBe('gh')
  })

  it('选中 stored → select 载荷 {kind:"stored", id}；选中 builtin → {kind:"builtin"}', async () => {
    const w = mountPicker({ stored: { gh: 'data:image/png;base64,AA' }, packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } } })
    await w.findAll('.picker-chip').find((c) => c.text() === 'My Pack')!.trigger('click')
    await w.find('.picker-grid--all button').trigger('click')
    expect(w.emitted('select')![0]).toEqual([{ kind: 'stored', id: 'gh', title: 'gh' }])
    await w.find('.picker-grid--all .picker-grid-item, .picker-grid--all button').trigger('click') // builtin 任一格
    const last = w.emitted('select')!.at(-1)![0] as { kind: string }
    expect(last.kind).toBe('builtin')
  })

  it('搜索跨源：stored id 命中查询（extra 管线）', async () => {
    const w = mountPicker({ stored: { githacks: 'data:image/png;base64,AA' } })
    await w.find('.picker-search input').setValue('githacks')
    const cells = w.findAll('.picker-grid--all button')
    expect(cells.some((c) => c.find('.picker-cell-label').text() === 'githacks')).toBe(true)
  })

  it('中文别名搜索保留（谷歌→Google）', async () => {
    const w = mountPicker()
    await w.find('.picker-search input').setValue('谷歌')
    expect(w.findAll('.picker-grid--all button')[0]!.attributes('title')).toBe('Google')
  })

  it('包 chip × 两步确认 → emit removePack(normKey)', async () => {
    const w = mountPicker({ stored: { gh: 'data:image/png;base64,AA' }, packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } } })
    const packChip = w.findAll('.picker-chip').find((c) => c.text().includes('My Pack'))!
    await packChip.find('.chip-remove').trigger('click')
    await packChip.find('.chip-remove-confirm').trigger('click')
    expect(w.emitted('removePack')![0]).toEqual(['mypack'])
  })

  it('推荐区 mixed：builtin 出 svg、stored 出 img', () => {
    const w = mountPicker({ issuer: 'githacks', stored: { githacks: 'data:image/png;base64,AA' } })
    const rec = w.findAll('.picker-recommended button')
    expect(rec.length).toBeGreaterThan(0)
    expect(rec.some((b) => b.find('img').exists())).toBe(true)
    expect(rec.some((b) => b.find('svg').exists())).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- IconPickerDialog`
Expected: FAIL——新 props/行为未实现。

- [ ] **Step 3: 重写组件**

```vue
<!-- packages/ui/src/components/IconPickerDialog.vue -->
<script setup lang="ts">
import { suggestIcons, type BuiltinIcon, type IconSuggestion } from '@totp/core'
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ensureFullIcons, fullIconsError, fullIconsReady } from '../fullIcons'
import MdDialog from './md/MdDialog.vue'
import MdTextField from './md/MdTextField.vue'

/** 选中载荷：stored 含上传与包导入图标 */
export interface PickerSelect {
  kind: 'builtin' | 'stored'
  id: string
  title: string
}

const props = defineProps<{
  open: boolean
  builtin: Record<string, BuiltinIcon>
  /** 当前服务商名称：打开时按模糊匹配生成推荐区，空/无候选则不显示 */
  issuer?: string
  /** stored dataUrl 映射（urlcache: 前缀键排除在选择源之外） */
  stored?: Readonly<Record<string, string>>
  /** 包注册表（normKey → { name, iconIds }）：来源筛选与按包删除 */
  packs?: Readonly<Record<string, { name: string; iconIds: string[] }>>
}>()
const emit = defineEmits<{ select: [item: PickerSelect]; removePack: [normKey: string]; close: [] }>()

const { t } = useI18n()
const query = ref('')
watch(
  () => props.open,
  (open) => {
    if (open) {
      query.value = ''
      active.value = 'all'
      confirmingRemove.value = null
      void ensureFullIcons()
      void nextTick(measure)
    }
  },
)

// ---- 来源分桶（派生判定，零迁移）----
interface Item {
  id: string
  title: string
  kind: 'builtin' | 'stored'
  src?: string
}
const storedItems = computed<Item[]>(() =>
  Object.entries(props.stored ?? {})
    .filter(([id]) => !id.startsWith('urlcache:'))
    .map(([id, src]) => ({ id, title: id, kind: 'stored' as const, src })),
)
function packKeyOf(id: string): string | undefined {
  for (const [key, p] of Object.entries(props.packs ?? {})) if (p.iconIds.includes(id)) return key
  return undefined
}
const storedExtras = computed(() => storedItems.value.map((i) => ({ id: i.id })))

// ---- 来源筛选 chips ----
type ChipKey = 'all' | 'builtin' | 'uploaded' | (string & {})
const active = ref<ChipKey>('all')
const uploadedCount = computed(() => storedItems.value.filter((i) => !packKeyOf(i.id)).length)
const chips = computed(() => {
  const list: Array<{ key: ChipKey; label: string }> = [
    { key: 'all', label: t('entryForm.iconFilterAll') },
    { key: 'builtin', label: t('entryForm.iconFilterBuiltin') },
  ]
  if (uploadedCount.value > 0) list.push({ key: 'uploaded', label: t('entryForm.iconFilterUploaded') })
  for (const [key, p] of Object.entries(props.packs ?? {})) list.push({ key, label: p.name })
  return list
})
function matchesChip(item: Item): boolean {
  if (active.value === 'all') return true
  if (active.value === 'builtin') return item.kind === 'builtin'
  if (active.value === 'uploaded') return item.kind === 'stored' && !packKeyOf(item.id)
  return item.kind === 'stored' && packKeyOf(item.id) === active.value
}

/** 包删除两步确认：× → 确认按钮 → emit；切换/关闭重置 */
const confirmingRemove = ref<string | null>(null)
function onConfirmRemove() {
  const key = confirmingRemove.value
  confirmingRemove.value = null
  if (key) {
    emit('removePack', key)
    if (active.value === key) active.value = 'all'
  }
}

// ---- 列表组装：搜索走 suggestIcons（含 stored extra），否则全集按 chip 过滤 ----
const searching = computed(() => query.value.trim() !== '')
const results = computed<Item[]>(() => {
  if (searching.value) {
    return suggestIcons(query.value.trim(), Number.MAX_SAFE_INTEGER, storedExtras.value)
      .map((s: IconSuggestion) =>
        s.source === 'builtin'
          ? { id: s.id, title: s.title, kind: 'builtin' as const }
          : { id: s.id, title: s.title, kind: 'stored' as const, src: props.stored?.[s.id] },
      )
      .filter(matchesChip)
  }
  const builtinItems: Item[] = Object.values(props.builtin).map((b) => ({ id: b.id, title: b.title, kind: 'builtin' }))
  const pool = active.value === 'builtin' ? builtinItems : [...builtinItems, ...storedItems.value]
  return pool.filter(matchesChip)
})
const recommended = computed<IconSuggestion[]>(() =>
  props.open ? suggestIcons(props.issuer ?? '', 3, storedExtras.value) : [],
)

// ---- 窗口化：行高定值 + 列数按容器宽推算；jsdom 高度 0 → 回退 30 项 ----
const scroller = ref<HTMLElement | null>(null)
const CELL_H = 96
const COL_MIN = 76
const colCount = ref(5)
const first = ref(0)
const visibleCount = ref(30)
function measure() {
  const el = scroller.value
  if (!el) return
  colCount.value = Math.max(3, Math.floor((el.clientWidth + 4) / (COL_MIN + 4)))
  if (el.clientHeight > 0) visibleCount.value = (Math.ceil(el.clientHeight / CELL_H) + 4) * colCount.value
}
function onScroll() {
  const el = scroller.value
  if (!el) return
  const startRow = Math.max(0, Math.floor(el.scrollTop / CELL_H) - 4)
  first.value = startRow * colCount.value
}
watch([results, () => props.open], () => {
  first.value = 0
  void nextTick(measure)
})
const windowed = computed(() => results.value.slice(first.value, first.value + visibleCount.value))

function select(item: Item) {
  emit('select', { kind: item.kind, id: item.id, title: item.title })
}
</script>

<template>
  <MdDialog :open="open" :headline="t('entryForm.iconPickerTitle')" @close="emit('close')">
    <MdTextField
      v-model="query" class="picker-search" :label="t('entryForm.searchIconsLabel')"
      :placeholder="t('entryForm.searchIcons')" :aria-label="t('entryForm.searchIconsLabel')"
    />
    <div class="picker-chips">
      <button
        v-for="chip in chips" :key="chip.key" type="button" class="picker-chip"
        :class="{ active: active === chip.key }" @click="active = chip.key; confirmingRemove = null"
      >
        {{ chip.label }}
        <span
          v-if="/^(?!(all|builtin|uploaded)$)/.test(String(chip.key))" class="chip-remove" role="button"
          :aria-label="t('entryForm.iconPackRemoveConfirm')" @click.stop="confirmingRemove = String(chip.key)"
        >×</span>
        <template v-if="confirmingRemove === chip.key">
          <button type="button" class="chip-remove-confirm" @click.stop="onConfirmRemove">{{ t('entryForm.iconPackRemoveConfirm') }}</button>
          <button type="button" class="chip-remove-cancel" @click.stop="confirmingRemove = null">{{ t('entryForm.iconPackRemoveCancel') }}</button>
        </template>
      </button>
    </div>
    <p v-if="open && !fullIconsReady && !fullIconsError" class="picker-loading">{{ t('entryForm.iconsLoading') }}</p>
    <button v-if="open && fullIconsError" type="button" class="picker-retry" @click="void ensureFullIcons()">
      {{ t('entryForm.iconsLoadRetry') }}
    </button>
    <div v-if="!searching && recommended.length > 0" class="picker-recommended">
      <p class="picker-section-label">{{ t('entryForm.recommendedSection') }}</p>
      <div class="picker-grid">
        <button
          v-for="icon in recommended" :key="`rec-${icon.source}-${icon.id}`" type="button" class="picker-cell"
          :title="icon.title" :aria-label="icon.title" @click="select(icon.source === 'builtin'
            ? { id: icon.id, title: icon.title, kind: 'builtin' }
            : { id: icon.id, title: icon.title, kind: 'stored' })"
        >
          <svg v-if="icon.path" viewBox="0 0 24 24" aria-hidden="true"><path :d="icon.path" /></svg>
          <img v-else :src="stored?.[icon.id]" alt="" />
        </button>
      </div>
    </div>
    <p class="picker-section-label">{{ searching ? t('entryForm.searchResultsSection') : t('entryForm.allIconsSection') }}</p>
    <div ref="scroller" class="picker-scroll" @scroll.passive="onScroll">
      <div class="picker-grid picker-grid--all" :data-total="results.length">
        <button
          v-for="item in windowed" :key="`${item.kind}-${item.id}`" type="button" class="picker-cell picker-cell--labeled"
          :title="item.title" :aria-label="item.title" @click="select(item)"
        >
          <svg v-if="item.kind === 'builtin'" viewBox="0 0 24 24" aria-hidden="true"><path :d="builtin[item.id]!.path" /></svg>
          <img v-else :src="item.src" alt="" />
          <span class="picker-cell-label">{{ item.title }}</span>
        </button>
      </div>
    </div>
    <p v-if="searching && results.length === 0" class="picker-empty">{{ t('entryForm.iconPickerNoResults') }}</p>
  </MdDialog>
</template>
```

样式（scoped，替换旧块，cell 由 44px 方格改为带标签格式）：

```css
.picker-search { margin-bottom: 4px; }
.picker-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
.picker-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--md-sys-color-outline-variant); border-radius: 999px; background: transparent; color: var(--md-sys-color-on-surface-variant); padding: 2px 10px; font-size: var(--md-sys-typescale-body-small); cursor: pointer; }
.picker-chip.active { background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container); border-color: transparent; }
.chip-remove { cursor: pointer; opacity: 0.6; padding: 0 2px; }
.chip-remove:hover { opacity: 1; }
.chip-remove-confirm, .chip-remove-cancel { border: none; background: transparent; color: inherit; font-size: var(--md-sys-typescale-label-small); cursor: pointer; padding: 0 2px; }
.chip-remove-confirm { color: var(--md-sys-color-error); }
.picker-loading, .picker-empty { font-size: var(--md-sys-typescale-body-small); opacity: 0.6; }
.picker-retry { border: none; background: transparent; color: var(--md-sys-color-primary); cursor: pointer; font-size: var(--md-sys-typescale-body-small); }
.picker-section-label { font-size: var(--md-sys-typescale-label-medium); opacity: 0.65; margin: 8px 0 4px; }
.picker-scroll { max-height: 300px; overflow-y: auto; }
.picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 4px; }
.picker-cell { display: grid; place-items: center; gap: 2px; width: 100%; padding: 6px 2px; border: none; border-radius: 8px; background: transparent; color: var(--md-sys-color-on-surface-variant); cursor: pointer; }
.picker-cell:hover { background: color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent); color: var(--md-sys-color-on-surface); }
.picker-cell svg { width: 24px; height: 24px; fill: currentColor; }
.picker-cell img { width: 24px; height: 24px; object-fit: contain; }
.picker-cell--labeled { grid-template-rows: 24px 1fr; }
.picker-cell-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; line-height: 1.2; }
```

实现注意：推荐区 cell 里的 select 分支如类型报窄化问题，可提 helper `toSelect(icon: IconSuggestion): PickerSelect`；chip key 正则过滤（仅包 chip 出 ×）亦可改为 `typeof chip.key === 'string' && !['all','builtin','uploaded'].includes(chip.key)`——选其一写死。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui test -- IconPickerDialog && pnpm check:i18n && pnpm --filter @totp/ui typecheck`
Expected: 全 PASS（i18n 新键见下）。i18n 新增：

```json
"iconFilterAll": "全部",
"iconFilterBuiltin": "内置",
"iconFilterUploaded": "上传",
"iconsLoading": "图标加载中…",
"iconsLoadRetry": "加载失败，重试",
"iconPackRemoveConfirm": "删除",
"iconPackRemoveCancel": "取消"
```

```json
"iconFilterAll": "All",
"iconFilterBuiltin": "Built-in",
"iconFilterUploaded": "Uploaded",
"iconsLoading": "Loading icons…",
"iconsLoadRetry": "Load failed, retry",
"iconPackRemoveConfirm": "Delete",
"iconPackRemoveCancel": "Cancel"
```

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/IconPickerDialog.vue packages/ui/test/IconPickerDialog.test.ts packages/ui/src/i18n/locales
git commit -m "feat(ui): 图标选择器改版——标签/来源筛选/跨源搜索/懒加载/窗口化

为什么：3460 项格子无标签难辨认，stored（上传/包）图标此前无入口可选；
来源 chips + 手写窗口化承载全量集的可用性（spec 2026-10-05 §4）。"
```

---

### Task 8: EntryForm 集成（导入对话框流程 + mixed 推荐 + applyIcon）

**Files:**
- Modify: `packages/ui/src/components/EntryForm.vue`
- Test: `packages/ui/test/EntryForm.test.ts`（及 `EntryForm.edges.test.ts` 等涉及包导入/推荐/选择器的用例）

**Interfaces:**
- Consumes: Task 5 `importIconPackZip(bytes, icons, {name})`；Task 6 `IconPackImportDialog`；Task 7 `IconPickerDialog` 新 props/emits；Task 2 `IconSuggestion`。
- Produces: 用户可见行为——选 zip → 命名对话框 → 确认导入（busy/error 在对话框内，统计在 `packMessage`）；推荐气泡 builtin(svg)/stored(img) 混排；picker 选中 stored 也能落 `IconRef{kind:'stored'}`；`@remove-pack` → `iconStore.removePack` + `packMessage` 提示。

- [ ] **Step 1: 更新/新增测试**（先读现有 EntryForm 测试中包导入与推荐相关用例）

新增/调整用例（挂载 props 需含 `iconStore` mock 与 `icons`）：

```ts
it('包导入：选 zip 先开命名对话框，确认后才导入并显示统计', async () => {
  const w = mountForm() // 既有 helper，iconStore 为 mock（含 packs/upsertPack/removeMany/putMany）
  await w.find('input.pack-file').setFile?(...) // 沿用该文件既有的 zip 注入方式（File/DataTransfer 模式）
  const dialog = w.findComponent({ name: 'IconPackImportDialog' })
  expect(dialog.exists()).toBe(true)
  expect((dialog.find('input').element as HTMLInputElement).value).toBe('MyPack') // 预填文件名去 .zip
  await dialog.find('.actions button:last-child').trigger('click')
  expect(w.find('.pack-message').text()).toContain('1') // imported 统计（按既有 iconPackImported 文案断言导入数）
})

it('推荐气泡 mixed：stored 候选出 img，点击落 IconRef{kind:"stored"}', async () => {
  const w = mountForm({ stored: { githacks: 'data:image/png;base64,AA' } })
  await w.find('input[aria-label*="服务商"], .entry-form input[type="text"]').setValue('githacks') // 定位 issuer 输入（按既有测试的选择器）
  await flushDebounce() // 既有防抖等待方式
  const bubble = w.find('.icon-recommend')
  expect(bubble.find('img').exists()).toBe(true)
  await bubble.find('img').trigger('click') // img 在按钮内，click 冒泡至按钮
  // 提交后条目 icon 为 stored 引用：按既有保存断言路径校验 emit('save') payload.icon
})

it('picker remove-pack → iconStore.removePack 调用并提示', async () => {
  const w = mountForm({ packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } }, stored: { gh: 'data:...' } })
  const picker = w.findComponent({ name: 'IconPickerDialog' })
  picker.vm.$emit('removePack', 'mypack')
  await nextTick()
  expect(w.props/mock iconStore.removePack).toHaveBeenCalledWith('mypack') // 按既有 mock 断言风格
  expect(w.find('.pack-message').text()).toContain('My Pack')
})
```

（以上测试骨架须落在既有测试文件的 mount/断言惯例上：选择器、防抖等待、save payload 断言均照抄文件内既有写法；不要引入新测试工具。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- EntryForm`
Expected: 新用例 FAIL（对话框流程/mixed 气泡未实现）；受影响的既有用例（直接导入生效、applyBuiltinIcon 载荷）FAIL 待修。

- [ ] **Step 3: 实现 EntryForm 改动**

script 部分：

```ts
// import 区：
import type { IconSuggestion } from '@totp/core'
import IconPackImportDialog from './IconPackImportDialog.vue'

// 推荐候选改为 IconSuggestion：
const recommendations = ref<IconSuggestion[]>([])
/** stored 图标 id（排除 urlcache:）作为 suggestIcons extra 候选 */
const storedExtras = computed(() =>
  Object.keys(props.icons?.stored ?? {})
    .filter((id) => !id.startsWith('urlcache:'))
    .map((id) => ({ id })),
)
// watch(issuer) 内：
  recommendations.value = props.icons && !iconTouched.value && !form.icon ? suggestIcons(v.trim(), 3, storedExtras.value) : []

/** 推荐气泡/选择器统一选中入口：按 source 落对应 IconRef（原 applyBuiltinIcon 泛化） */
function applyIcon(icon: IconSuggestion) {
  form.icon = icon.source === 'builtin' ? { kind: 'builtin', id: icon.id } : { kind: 'stored', id: icon.id }
  iconTouched.value = true
  recommendations.value = []
  pickerOpen.value = false
}

// 包导入：选 zip → 存 pending + 开对话框；确认才导入
const packDialogOpen = ref(false)
const packPending = ref<{ bytes: Uint8Array; defaultName: string } | null>(null)
const packDialogError = ref('')
async function onPackFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !props.iconStore) return
  iconError.value = ''
  packDialogError.value = ''
  if (file.size > MAX_ICON_PACK_ZIP_BYTES) {
    iconError.value = t('entryForm.iconPackTooLarge', { limit: Math.floor(MAX_ICON_PACK_ZIP_BYTES / 1024 / 1024) })
    input.value = ''
    return
  }
  packPending.value = { bytes: new Uint8Array(await file.arrayBuffer()), defaultName: file.name.replace(/\.zip$/i, '') }
  packDialogOpen.value = true
  input.value = ''
}
async function onPackConfirm(name: string) {
  if (!props.iconStore || !packPending.value) return
  packBusy.value = true
  packDialogError.value = ''
  try {
    const result = await importIconPackZip(packPending.value.bytes, props.iconStore, { name })
    packMessage.value = t('entryForm.iconPackImported', { imported: result.imported, skipped: result.skipped })
    packDialogOpen.value = false
    packPending.value = null
  } catch (err) {
    packDialogError.value = err instanceof Error ? err.message : String(err)
  } finally {
    packBusy.value = false
  }
}
async function onRemovePack(normKey: string) {
  const name = props.iconStore?.packs[normKey]?.name ?? normKey
  await props.iconStore?.removePack(normKey)
  packMessage.value = t('entryForm.iconPackRemoved', { name })
}
```

template 部分：

```html
<!-- 推荐气泡 mixed：builtin svg / stored img -->
<button
  v-for="rec in recommendations" :key="`${rec.source}-${rec.id}`" type="button" class="recommend-item"
  :title="rec.title" :aria-label="`${t('entryForm.useIcon')} ${rec.title}`" @click="applyIcon(rec)"
>
  <svg v-if="rec.path" viewBox="0 0 24 24" class="icon-preview" aria-hidden="true" v-html="builtinHtml(rec.path)" />
  <img v-else :src="icons?.stored?.[rec.id]" class="icon-preview" alt="" />
</button>
```

```html
<!-- picker 传新 props + removePack；对话框挂载 -->
<IconPickerDialog
  v-if="icons" :open="pickerOpen" :builtin="icons.builtin" :issuer="form.issuer"
  :stored="icons.stored" :packs="iconStore?.packs"
  @select="applyIcon" @remove-pack="onRemovePack" @close="pickerOpen = false"
/>
<IconPackImportDialog
  :open="packDialogOpen" :default-name="packPending?.defaultName ?? ''"
  :existing-packs="iconStore?.packs ?? {}" :busy="packBusy" :error="packDialogError"
  @confirm="onPackConfirm" @close="packDialogOpen = false"
/>
```

（原 `onPackFile` 中的直接导入逻辑移除；`applyBuiltinIcon` 函数删除，调用点全部改 `applyIcon`；`import type { BuiltinIcon }` 若仅剩 picker props 使用则保留。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui test -- EntryForm` → 全绿（含既有回归）；`pnpm --filter @totp/ui typecheck` → 通过。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/EntryForm.vue packages/ui/test/EntryForm.test.ts packages/ui/test/EntryForm.edges.test.ts
git commit -m "feat(ui): EntryForm 接入命名对话框与 mixed 推荐

为什么：包导入需先命名（可快捷填入覆盖）；服务商推荐纳入包图标
（spec 修订二）；picker 选中 stored 图标统一经 applyIcon 落引用。"
```

---

### Task 9: 宿主组装 fullIconsReady 依赖 + 真机清单 + 全量回归

**Files:**
- Modify: `apps/extension/entrypoints/popup/App.vue`（entryIcons computed，约 100 行）
- Modify: `packages/ui/src/pages/CodesPage.vue:101`
- Create: `docs/e2e/2026-10-05-full-icons-picker-checklist.md`
- Modify: `docs/superpowers/specs/2026-10-05-full-icons-picker-design.md`（§1 推荐区措辞勘误，见 Step 4）

**Interfaces:**
- Consumes: Task 3 `fullIconsReady`。
- Produces: 全量加载完成后，列表/弹层中非精选 builtin 图标自动补渲染（entryIcons computed 纳入 ready 依赖触发重算）。MiniApp 桌面端不渲染图标选择区（无 entryIcons/EntryForm 图标区），本任务验证其不回归。

- [ ] **Step 1: 修改两处 entryIcons**

`packages/ui/src/pages/CodesPage.vue` 与 `apps/extension/entrypoints/popup/App.vue`：

```ts
import { fullIconsReady } from '../fullIcons' // popup 路径 '@totp/ui' 无导出则从相对路径/包入口补导出
const entryIcons = computed(() => {
  void fullIconsReady.value // 全量注册后重算：非精选 builtin path 就位
  return { builtin: getBuiltinIcons(), stored: props.icons?.icons ?? {} }
})
```

（popup 的 stored 源为 `icons.icons`；以各自现状为准只加依赖行与 import。若 ui 包入口需导出 `fullIconsReady`/`ensureFullIcons`，在 `packages/ui/src/index.ts` 补 `export { ensureFullIcons, fullIconsReady, fullIconsError } from './fullIcons'`。）

- [ ] **Step 2: 全量回归**

Run: `pnpm test && pnpm typecheck && pnpm check:i18n`
Expected: 全绿。若 `apps/extension/test/optionsApp.test.ts`、`apps/desktop/src/MiniApp.test.ts` 或导出快照守卫因新增导出/形状变化失败，按快照守卫惯例同步更新期望（历史坑位）。

- [ ] **Step 3: 覆盖率 gate**

Run: `pnpm test:coverage`
Expected: statements ≥71 / branches ≥54（CI gate）；不达标优先补测新代码路径而非调 gate。

- [ ] **Step 4: 真机验证清单 + spec 勘误提交**

新建 `docs/e2e/2026-10-05-full-icons-picker-checklist.md`（对齐仓库既有 e2e checklist 文档格式）：

```markdown
# 全量图标库与选择器来源筛选 真机验证清单

对应 spec：docs/superpowers/specs/2026-10-05-full-icons-picker-design.md（计划 2026-10-05-full-icons-picker.md）

前置：`pnpm exec wxt build -b firefox` 与 Chrome 构建各一份；准备 aegis-icons releases zip。

## 图标包导入对话框
- [ ] EntryForm 图标区「导入图标包」选 zip → 弹对话框，包名预填文件名去 .zip，可改
- [ ] 对话框列出已导入包名，点击一键填入；输入 my.pack（normalize 命中）出现覆盖提示
- [ ] 空名确认禁用；确认后 busy → 关闭 → 统计文案显示导入/跳过数
- [ ] 同名重导：旧包中已消失的图标从选择器消失（整包替换）

## 选择器
- [ ] 打开选择器：加载指示出现后消失（全量懒加载）；失败断网场景显示重试，恢复后可重试
- [ ] chips：全部/内置恒在；有上传图标才显示「上传」；各包按显示名；包 chip × → 删除/取消两步确认 → 删除后 chip 消失
- [ ] 每格下方有可见标签（内置为品牌名、包图标为 id）；选中 stored 图标保存后条目正常显示该图标
- [ ] 搜索跨源：包图标 id 可被搜到；中文别名（谷歌→Google）仍命中
- [ ] 滚动到底流畅无卡顿（3460 项窗口化）

## 推荐
- [ ] 新增条目输入服务商（如输入包内品牌名）→ 推荐气泡出现包图标（img）与内置（svg）混排
- [ ] 选中包图标推荐 → 保存 → 条目正常渲染

## 删除与回退
- [ ] 删除整包后：引用其图标的条目回退首字母，无报错
- [ ] 重启浏览器/应用：包归属与上传图标保持

## 体积与性能
- [ ] 构建产物：主包不含 icons-full.json 内联（为独立资产）；dist 体积增量 ≈ 3.5MB
- [ ] 选择器首开到可交互 < 1s（本地资产）
```

spec 勘误（同日修正，行内注记保留原文语义）：`docs/superpowers/specs/2026-10-05-full-icons-picker-design.md` §1「推荐区候选集」一条中，将「仅搜索覆盖全量 3460 项」改为「全量加载完成后，推荐与搜索均自然覆盖全量（registerIcons 合并后单一注册表）；加载完成前 builtin 推荐候选即精选集，不依赖加载」。

```bash
git add apps/extension/entrypoints/popup/App.vue packages/ui/src/pages/CodesPage.vue packages/ui/src/index.ts docs/e2e/2026-10-05-full-icons-picker-checklist.md docs/superpowers/specs/2026-10-05-full-icons-picker-design.md
git commit -m "feat(ui): 宿主 entryIcons 纳入全量 ready 依赖 + 真机清单

为什么：全量注册进单一注册表后需触发列表重算，非精选 builtin 引用
才能补渲染；spec 推荐区措辞按实现口径同日勘误。"
```

---

## Self-Review 记录（计划完成后自查）

- Spec 覆盖：§1 数据管线→Task 1/3/9；§2 包注册表→Task 4/5；§3 对话框→Task 6/8；§4 选择器→Task 7；§5 suggestIcons→Task 2/8；§6 EntryForm→Task 5/8；§7 i18n→Task 6/7；验收/真机→Task 9。无缺口。
- 占位符：Task 5/6/7/8 中「先读既有文件照抄惯例」均为对既有工程惯例的引用（fake adapter、zip fixture、mount helper），非行为占位；条件分支（`?url` 声明、cancel 键、MdTextField disabled）均已写死两种走向的处理。
- 类型一致性：`IconSuggestion`（Task 2 定义，7/8 消费）、`IconPackInfo`（Task 4 定义，5/7/8 消费）、`importIconPackZip` 三参签名（Task 5 定义，8 消费）、`PickerSelect`（Task 7 定义，8 消费）、`ensureFullIcons/fullIconsReady`（Task 3 定义，7/9 消费）签名一致。
