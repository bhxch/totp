# TOTP 工具 M1-计划2：URL 匹配过滤 + 搜索 + 条目管理 + options 页 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐插件侧核心体验：core 五策略 URL 匹配引擎、popup 顶部搜索与按当前页 URL 过滤、条目编辑/删除、options 全功能页（条目管理 + 分组管理 + 匹配规则编辑），并以统一 store 单例替换 popup 的直接读写（解决已知并发写隐患）。

**Architecture:** core 新增匹配引擎（纯函数）与 settings 存储；extension 新增 `src/store.ts`（reactive vault + 串行持久化 + chrome.storage.onChanged 跨页同步 + settings）；ui 新增 EntryForm 共享编辑组件；popup 与 options 两个 WXT entrypoint 都消费 store 与共享组件。

**Tech Stack:** 同计划 1（pnpm/TS strict/Vitest/Vue 3.5/WXT）。不新增任何运行时依赖。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（第 10 节插件形态：搜索、五种匹配策略、右键编辑、options 全功能页）

## Global Constraints

- 沿用计划 1 全部约束：TS strict、core 零第三方运行时依赖、每任务 TDD + commit、UI 中文
- 权限不变：manifest 仅 `storage`、`clipboardWrite`（+WXT 自动生成的 options 声明）；**禁止加 `tabs` 权限**（activeTab 已在计划 1 申请，popup 打开即可读当前 tab URL）
- 跨计划约束：popup/options 的全部写操作必须走 `src/store.ts` 串行队列，禁止再直接 loadVault/saveVault
- 匹配引擎行为与 Bitwarden 同款语义：`baseDomain`（基域名相等）、`host`（完整 host 相等）、`exact`（整 URL 相等）、`startsWith`（字符串前缀）、`regex`（正则 test，pattern 非法时视为不匹配不抛错）
- 每条目 `matchRules` 为空/缺省时不参与 URL 过滤（只出现在「全部」视图）
- 二级后缀例外表（baseDomain 用）固定为：co.uk org.uk gov.uk ac.uk com.cn net.cn org.cn gov.cn co.jp ne.jp or.jp com.au net.au org.au co.nz com.br com.mx co.in co.kr com.tw com.hk com.sg com.tr（23 项，硬编码常量）

---

### Task 1: core URL 匹配引擎

**Files:**
- Create: `packages/core/src/match/engine.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/match.test.ts`

**Interfaces:**
- Consumes: `OtpEntry`（model.ts，读 `matchRules?: MatchRule[]` 与 `issuer`）
- Produces:
  - `type MatchStrategy = 'baseDomain' | 'host' | 'exact' | 'startsWith' | 'regex'`
  - `interface MatchRule { strategy: MatchStrategy; pattern: string }`
  - `function urlMatches(url: string, rule: MatchRule): boolean`（URL 解析失败→false；regex 非法→false；大小写：baseDomain/host 不敏感，exact/startsWith 敏感）
  - `function entryMatchesUrl(entry: Pick<OtpEntry, 'matchRules'>, url: string): boolean`（无规则→false；任一命中→true）
  - `function baseUrlOf(host: string): string`（host→基域名：末两段，若末两段命中例外表取末三段；host 为 IP 或单段→原样小写返回）
- 同时 `OtpEntry.matchRules` 在 model.ts 中的类型从 `MatchRule[]` 引用（model.ts 增加一行 `import type { MatchRule } from './match/engine'`，字段类型保持 `matchRules?: MatchRule[]` 不变）

- [ ] **Step 1: 写失败测试**

`packages/core/test/match.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { baseUrlOf, entryMatchesUrl, urlMatches, type MatchRule } from '../src/match/engine'

const rule = (strategy: MatchRule['strategy'], pattern: string): MatchRule => ({ strategy, pattern })

describe('baseUrlOf', () => {
  it.each([
    ['github.com', 'github.com'],
    ['api.github.com', 'github.com'],
    ['gist.github.com', 'github.com'],
    ['accounts.google.co.uk', 'google.co.uk'], // 例外表三段
    ['deep.sub.example.com.cn', 'example.com.cn'],
    ['localhost', 'localhost'],
    ['192.168.1.1', '192.168.1.1'], // IP 原样
    ['GitHub.COM', 'github.com'], // 小写化
  ])('%s → %s', (host, expected) => {
    expect(baseUrlOf(host)).toBe(expected)
  })
})

describe('urlMatches 五策略', () => {
  const url = 'https://gist.github.com/user?x=1#frag'
  it('baseDomain：子域命中，基域名不等不命中', () => {
    expect(urlMatches(url, rule('baseDomain', 'github.com'))).toBe(true)
    expect(urlMatches(url, rule('baseDomain', 'gitlab.com'))).toBe(false)
    expect(urlMatches(url, rule('baseDomain', 'https://gist.github.com/x'))).toBe(true) // pattern 先取 host
  })
  it('host：完整 host 相等（含端口），子域不命中', () => {
    expect(urlMatches('https://github.com/a', rule('host', 'github.com'))).toBe(true)
    expect(urlMatches(url, rule('host', 'github.com'))).toBe(false)
    expect(urlMatches('https://localhost:8080/x', rule('host', 'localhost:8080'))).toBe(true)
  })
  it('exact：整 URL 相等（忽略首尾空白），其余不命中', () => {
    expect(urlMatches(' https://a.com/p ', rule('exact', 'https://a.com/p'))).toBe(true)
    expect(urlMatches('https://a.com/p2', rule('exact', 'https://a.com/p'))).toBe(false)
  })
  it('startsWith：字符串前缀', () => {
    expect(urlMatches('https://a.com/p/1', rule('startsWith', 'https://a.com/p'))).toBe(true)
    expect(urlMatches('https://a.com/q/1', rule('startsWith', 'https://a.com/p'))).toBe(false)
  })
  it('regex：合法正则 test；非法正则 false 不抛', () => {
    expect(urlMatches('https://mail.a.com/x', rule('regex', '^https://mail\\.'))).toBe(true)
    expect(urlMatches('https://a.com/x', rule('regex', 'b(c'))).toBe(false)
  })
  it('URL 解析失败一律 false', () => {
    expect(urlMatches('not a url', rule('baseDomain', 'a.com'))).toBe(false)
  })
})

describe('entryMatchesUrl', () => {
  it('无规则/空规则不命中', () => {
    expect(entryMatchesUrl({}, 'https://a.com')).toBe(false)
    expect(entryMatchesUrl({ matchRules: [] }, 'https://a.com')).toBe(false)
  })
  it('任一规则命中即命中', () => {
    const e = { matchRules: [rule('host', 'x.com'), rule('baseDomain', 'y.com')] }
    expect(entryMatchesUrl(e, 'https://sub.y.com/z')).toBe(true)
    expect(entryMatchesUrl(e, 'https://z.com/z')).toBe(false)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/core/src/match/engine.ts`:
```ts
const SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'co.jp', 'ne.jp', 'or.jp',
  'com.au', 'net.au', 'org.au', 'co.nz',
  'com.br', 'com.mx', 'co.in', 'co.kr', 'com.tw', 'com.hk', 'com.sg', 'com.tr',
])

export type MatchStrategy = 'baseDomain' | 'host' | 'exact' | 'startsWith' | 'regex'

export interface MatchRule {
  strategy: MatchStrategy
  pattern: string
}

export function baseUrlOf(host: string): string {
  const h = host.toLowerCase()
  const parts = h.split('.').filter(Boolean)
  if (parts.length <= 2) return parts.join('.')
  const lastTwo = parts.slice(-2).join('.')
  if (SECOND_LEVEL.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}

function hostOf(input: string): string {
  try {
    return new URL(input).host
  } catch {
    return ''
  }
}

export function urlMatches(url: string, rule: MatchRule): boolean {
  const pattern = rule.pattern.trim()
  if (!pattern) return false
  switch (rule.strategy) {
    case 'baseDomain': {
      const host = hostOf(url)
      if (!host) return false
      return baseUrlOf(host) === baseUrlOf(pattern)
    }
    case 'host': {
      const host = hostOf(url)
      return host !== '' && host.toLowerCase() === pattern.toLowerCase()
    }
    case 'exact':
      return url.trim() === pattern
    case 'startsWith':
      return url.startsWith(pattern)
    case 'regex':
      try {
        return new RegExp(pattern).test(url)
      } catch {
        return false
      }
  }
}

export function entryMatchesUrl(entry: { matchRules?: MatchRule[] }, url: string): boolean {
  const rules = entry.matchRules
  if (!rules || rules.length === 0) return false
  return rules.some((r) => urlMatches(url, r))
}
```

`packages/core/src/index.ts` 追加:
```ts
export * from './match/engine'
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @totp/core test`
Expected: PASS（新增约 17 用例）

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): 五策略URL匹配引擎与基域名提取"
```

---

### Task 2: settings 存储与 extension 统一 store

**Files:**
- Create: `packages/core/src/storage/settingsStore.ts`
- Modify: `packages/core/src/storage/vaultStore.ts`（追加 `SETTINGS_KEY = 'settings'` 与 `AppSettings` 接口、load/save 函数）——实际放本文件更内聚，独立文件不建
- Modify: `packages/core/src/index.ts`
- Modify: `apps/extension/src/chromeStorage.ts`（无改动则不动）
- Create: `apps/extension/src/store.ts`
- Modify: `apps/extension/entrypoints/popup/App.vue`（改用 store；仅改读写路径，UI 不变）
- Test: `packages/core/test/settings.test.ts`

**Interfaces:**
- Produces:
  - core：`interface AppSettings { urlFilterEnabled: boolean }`、`DEFAULT_SETTINGS: AppSettings`、`async loadSettings(adapter): Promise<AppSettings>`（缺省/损坏→DEFAULT）、`async saveSettings(adapter, s): Promise<void>`
  - extension `src/store.ts`（模块级单例，popup 与 options 共用）：
    ```ts
    export const vault: Readonly<Proxy>  // Vue reactive<Vault>
    export const settings: Reactive<AppSettings>
    export async function initStore(): Promise<void>  // 幂等：loadVault+loadSettings 填充
    export async function commit(fn: (v: Vault) => Vault): Promise<void>   // 串行队列：改内存→防抖300ms落盘
    export async function commitSettings(): Promise<void>
    export function registerStorageSync(): void  // chrome.storage.onChanged：非自写变更→重读覆盖内存
    ```
    导出具体操作 helper：`addEntryOp(entry)`, `updateEntryOp(uuid, patch)`, `removeEntryOp(uuid)`, `addGroupOp(name)`, `renameGroupOp(id, name)`, `removeGroupOp(id)`, `reorderOp(uuids)`——每个内部调 `commit`。自写回环抑制：`lastSelfWriteAt` 时间戳，onChanged 500ms 内的自身写入跳过。
- popup App.vue 改造点：删除 `persist()` 与直接 `loadVault` 调用，`onMounted` 改 `await initStore(); registerStorageSync()`，`entries` 从 `computed(() => [...vault.entries].sort(...))` 派生；添加走 `addEntryOp`。

- [ ] **Step 1: core settings 测试（TDD）**

`packages/core/test/settings.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import { loadSettings, saveSettings, DEFAULT_SETTINGS, SETTINGS_KEY } from '../src/storage/vaultStore'

describe('settingsStore', () => {
  it('缺省返回默认设置', async () => {
    expect(await loadSettings(createMemoryStorage())).toEqual(DEFAULT_SETTINGS)
  })
  it('save/load 往返', async () => {
    const s = createMemoryStorage()
    await saveSettings(s, { urlFilterEnabled: false })
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: false })
  })
  it('损坏 JSON 回退默认值', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, '{oops')
    expect(await loadSettings(s)).toEqual(DEFAULT_SETTINGS)
  })
  it('未知字段被丢弃（只保留已知键）', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ urlFilterEnabled: true, hacked: 1 }))
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: true })
  })
})
```

- [ ] **Step 2: 运行确认失败 → 实现 → 通过**

`packages/core/src/storage/vaultStore.ts` 追加:
```ts
export const SETTINGS_KEY = 'settings'

export interface AppSettings {
  urlFilterEnabled: boolean
}

export const DEFAULT_SETTINGS: AppSettings = { urlFilterEnabled: true }

export async function loadSettings(adapter: StorageAdapter): Promise<AppSettings> {
  const raw = await adapter.get(SETTINGS_KEY)
  if (raw === null) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return { urlFilterEnabled: parsed.urlFilterEnabled ?? DEFAULT_SETTINGS.urlFilterEnabled }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(adapter: StorageAdapter, settings: AppSettings): Promise<void> {
  await adapter.set(SETTINGS_KEY, JSON.stringify(settings))
}
```

`packages/core/src/index.ts` 无需改（vaultStore 已 `export *`）。Run: `pnpm --filter @totp/core test` → PASS。

- [ ] **Step 3: extension store**

`apps/extension/src/store.ts`:
```ts
import {
  addEntry, addGroup, createVault, loadSettings, loadVault, removeEntry, removeGroup,
  renameGroup, saveSettings, saveVault, updateEntry,
  type AppSettings, type OtpEntry, type Vault,
} from '@totp/core'
import { reactive, toRaw } from 'vue'
import { createChromeStorage } from './chromeStorage'

const adapter = createChromeStorage()

export const vault = reactive<Vault>(createVault())
export const settings = reactive<AppSettings>({ urlFilterEnabled: true })

let inited = false
let lastSelfWriteAt = 0
let queue: Promise<void> = Promise.resolve()
let saveTimer: ReturnType<typeof setTimeout> | null = null

export async function initStore(): Promise<void> {
  if (inited) return
  const [v, s] = await Promise.all([loadVault(adapter), loadSettings(adapter)])
  replaceVault(v)
  Object.assign(settings, s)
  inited = true
}

function replaceVault(v: Vault): void {
  vault.version = v.version
  vault.updatedAt = v.updatedAt
  vault.entries.splice(0, vault.entries.length, ...v.entries)
  vault.groups.splice(0, vault.groups.length, ...v.groups)
}

export function registerStorageSync(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['vault']) return
    if (Date.now() - lastSelfWriteAt < 500) return
    void loadVault(adapter).then(replaceVault)
  })
}

export async function commit(fn: (v: Vault) => Vault): Promise<void> {
  queue = queue.then(async () => {
    replaceVault(fn(vault))
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      lastSelfWriteAt = Date.now()
      await saveVault(adapter, toRaw(vault) as Vault)
    }, 300)
  })
  return queue
}

export async function commitSettings(): Promise<void> {
  lastSelfWriteAt = Date.now()
  await saveSettings(adapter, toRaw(settings) as AppSettings)
}

export const addEntryOp = (entry: OtpEntry) => commit((v) => addEntry(v, entry))
export const updateEntryOp = (uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>) => commit((v) => updateEntry(v, uuid, patch))
export const removeEntryOp = (uuid: string) => commit((v) => removeEntry(v, uuid))
export const addGroupOp = (name: string) => commit((v) => addGroup(v, name))
export const renameGroupOp = (id: string, name: string) => commit((v) => renameGroup(v, id, name))
export const removeGroupOp = (id: string) => commit((v) => removeGroup(v, id))
```

- [ ] **Step 4: popup 改用 store**

`apps/extension/entrypoints/popup/App.vue` script 段改造（template/styles 不变）：
- 删除本地 `entries` ref、`persist()`、`onMounted` 的直接 loadVault
- `onMounted: await initStore(); registerStorageSync()`
- `const sorted = computed(() => [...vault.entries].sort((a, b) => a.order - b.order))`
- `add()` 成功分支改为 `await addEntryOp(entry)`；内存列表由 reactive vault 自动更新，删除 `entries.value = [...]` 行

- [ ] **Step 5: 验证 + Commit**

Run: `pnpm test && pnpm --filter @totp/extension build`
Expected: 全绿（core 63/63 上下）、build 成功

```bash
git add packages/core/ apps/extension/ pnpm-lock.yaml
git commit -m "feat: settings存储与extension统一store串行持久化+跨页同步"
```

---

### Task 3: popup 搜索框与 URL 过滤

**Files:**
- Modify: `apps/extension/entrypoints/popup/App.vue`
- Create: `packages/ui/src/components/SearchBar.vue`

**Interfaces:**
- Consumes: `entryMatchesUrl`（Task 1）、`settings.urlFilterEnabled`、`commitSettings`（Task 2）
- Produces: `SearchBar.vue` props `{ modelValue: string }` emit `update:modelValue`（带 200ms 防抖不必要——本地即时过滤即可，直接 v-model 透传）；popup 新状态 `tabUrl: string | null`（activeTab 读出；读不到/非 http(s) → null）

- [ ] **Step 1: SearchBar 组件**

`packages/ui/src/components/SearchBar.vue`:
```vue
<script setup lang="ts">
defineProps<{ modelValue: string }>()
defineEmits<{ 'update:modelValue': [string] }>()
</script>

<template>
  <input
    class="search"
    type="search"
    placeholder="搜索服务名或账户…"
    :value="modelValue"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.search { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid rgba(128,128,128,.4); border-radius: 8px; background: transparent; color: inherit; }
.search:focus { outline: none; border-color: #4a90d9; }
</style>
```

`packages/ui/src/index.ts` 追加 `export { default as SearchBar } from './components/SearchBar.vue'`

- [ ] **Step 2: popup 集成**

`App.vue` script 增加：
```ts
import { entryMatchesUrl } from '@totp/core'
import { SearchBar } from '@totp/ui'
const query = ref('')
const tabUrl = ref<string | null>(null)
const filterOn = computed(() => settings.urlFilterEnabled)

onMounted(async () => {
  /* 已有 initStore + registerStorageSync */
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.url?.startsWith('http')) tabUrl.value = tab.url
})

const matched = computed(() => (tabUrl.value ? sorted.value.filter((e) => entryMatchesUrl(e, tabUrl.value!)) : []))
const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  const base = q
    ? sorted.value.filter((e) => `${e.issuer} ${e.label} ${e.note ?? ''}`.toLowerCase().includes(q))
    : sorted.value
  if (!filterOn.value || !tabUrl.value) return base
  return matched.value.length > 0 ? matched.value.filter((e) => base.includes(e)) : base
})
const filterFallback = computed(() => filterOn.value && !!tabUrl.value && matched.value.length === 0)
const toggleFilter = async () => { settings.urlFilterEnabled = !settings.urlFilterEnabled; await commitSettings() }
```

template：header 下加 `<SearchBar v-model="query" />`；其下过滤状态行（仅当 tabUrl 存在时显示）：
```html
<div class="filter-row" v-if="tabUrl">
  <label><input type="checkbox" :checked="filterOn" @change="toggleFilter" /> 按当前站点过滤</label>
  <span v-if="filterFallback" class="hint">当前站点无匹配，显示全部</span>
  <span v-else-if="filterOn" class="hint">匹配 {{ matched.length }} 条</span>
</div>
```
列表渲染 `v-for="e in visible"`；空态文案区分 query 非空（「无匹配结果」）与无条目。样式：`.filter-row` 小字 12px、`.hint` 半透明。

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm -r run typecheck && pnpm --filter @totp/extension build && pnpm test`
Expected: 全绿

```bash
git add packages/ui/ apps/extension/
git commit -m "feat(extension): popup顶部搜索与按当前站点URL过滤（含回退）"
```

---

### Task 4: ui 共享编辑表单 EntryForm + 条目删除/编辑（popup）

**Files:**
- Create: `packages/ui/src/components/EntryForm.vue`
- Modify: `packages/ui/src/index.ts`
- Modify: `apps/extension/entrypoints/popup/App.vue`（列表项操作 + 编辑/删除接 store）
- Test: `packages/ui/test/EntryForm.test.ts`

**Interfaces:**
- Produces: `EntryForm.vue`
  - props: `{ initial?: OtpEntry | null; groups: Group[] }`（initial null=新建模式）
  - emits: `save: [data: EntryFormData]`、`cancel: []`
  - `interface EntryFormData { type: 'totp'|'hotp'|'steam'; issuer: string; label: string; secret: string; note: string; groupIds: string[]; matchRules: MatchRule[] }`
  - 字段：issuer/label/note 文本框、secret 文本框（编辑模式显示原值可改）、type 下拉（totp/steam；hotp 仅编辑已有 hotp 时可见且锁定）、分组 checkbox 列表（groups 为空时隐藏）、matchRules 编辑区（Task 6 填充实现，本任务渲染占位容器）
  - 校验：secret 必填 + `base32Decode` 预检（错误提示「密钥不是有效的 base32 编码（base32 仅允许字母 A–Z 和数字 2–7）」）；issuer/label 可为空（用户自由）
- popup 改造：列表项右侧 hover 出现「✎」与「🗑」（emoji 按钮，无需图标库）；删除点击后该项按钮区变「确认？」二次点击才执行 `removeEntryOp(uuid)`，3 秒未确认自动还原；编辑点击 → `editing = ref<OtpEntry | null>`，表单区显示 EntryForm，save → `updateEntryOp(uuid, data)`；新建也改走 EntryForm（替代现有 add-form，secret 预检逻辑随组件走，popup 内重复代码删除）

- [ ] **Step 1: EntryForm 组件（TDD：先组件测试）**

`packages/ui/test/EntryForm.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import EntryForm from '../src/components/EntryForm.vue'
import type { OtpEntry } from '@totp/core'

const entry: OtpEntry = {
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order: 0, createdAt: 0,
}

describe('EntryForm', () => {
  it('编辑模式回填字段，save 携带全部数据', async () => {
    const w = mount(EntryForm, { props: { initial: entry, groups: [] } })
    await w.find('form').trigger('submit')
    const payload = w.emitted('save')![0]![0]
    expect(payload).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP', note: '', groupIds: [], matchRules: [] })
  })
  it('非法 secret 显示错误且不 emit save', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [] } })
    await w.find('input[placeholder="密钥 base32"]').setValue('AB01') // 0/1 非法
    await w.find('form').trigger('submit')
    expect(w.emitted('save')).toBeUndefined()
    expect(w.text()).toContain('base32')
  })
  it('分组 checkbox 勾选写入 groupIds', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [{ id: 'g1', name: '工作', order: 0 }] } })
    await w.find('input[type="checkbox"]').setValue(true)
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ groupIds: ['g1'] })
  })
})
```

`packages/ui/src/components/EntryForm.vue`:
```vue
<script setup lang="ts">
import { base32Decode, type Group, type MatchRule, type OtpEntry } from '@totp/core'
import { reactive, ref } from 'vue'

export interface EntryFormData {
  type: 'totp' | 'hotp' | 'steam'
  issuer: string
  label: string
  secret: string
  note: string
  groupIds: string[]
  matchRules: MatchRule[]
}

const props = defineProps<{ initial?: OtpEntry | null; groups?: Group[] }>()
const emit = defineEmits<{ save: [data: EntryFormData]; cancel: [] }>()

const form = reactive({
  type: (props.initial?.type ?? 'totp') as 'totp' | 'hotp' | 'steam',
  issuer: props.initial?.issuer ?? '',
  label: props.initial?.label ?? '',
  secret: props.initial?.secret ?? '',
  note: props.initial?.note ?? '',
  groupIds: [...(props.initial?.groupIds ?? [])],
  matchRules: [...(props.initial?.matchRules ?? [])],
})
const error = ref('')
const isNew = !props.initial

function cleanSecret(): string {
  return form.secret.replace(/\s+/g, '').toUpperCase()
}

function submit() {
  error.value = ''
  if (form.type !== 'hotp') {
    try {
      base32Decode(cleanSecret())
    } catch {
      error.value = '密钥不是有效的 base32 编码（base32 仅允许字母 A–Z 和数字 2–7）'
      return
    }
  }
  emit('save', { ...form, secret: cleanSecret() })
}
</script>

<template>
  <form class="entry-form" @submit.prevent="submit">
    <select v-model="form.type" :disabled="form.type === 'hotp'">
      <option value="totp">TOTP</option>
      <option value="steam">Steam</option>
      <option v-if="form.type === 'hotp'" value="hotp">HOTP（计数器）</option>
    </select>
    <input v-model="form.issuer" placeholder="服务名（如 GitHub）" />
    <input v-model="form.label" placeholder="账户名" />
    <input v-model="form.secret" placeholder="密钥 base32" required />
    <textarea v-model="form.note" placeholder="备注（可选）" rows="2" />
    <fieldset v-if="(groups ?? []).length > 0">
      <legend>分组</legend>
      <label v-for="g in groups" :key="g.id" class="group-check">
        <input type="checkbox" :value="g.id" v-model="form.groupIds" /> {{ g.name }}
      </label>
    </fieldset>
    <div v-if="error" class="error">{{ error }}</div>
    <div class="row">
      <button type="submit">{{ isNew ? '添加' : '保存' }}</button>
      <button type="button" @click="emit('cancel')">取消</button>
    </div>
  </form>
</template>

<style scoped>
.entry-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid rgba(128,128,128,.4); border-radius: 8px; }
.entry-form input, .entry-form select, .entry-form textarea, .entry-form button { padding: 6px 8px; box-sizing: border-box; }
.entry-form textarea { resize: vertical; font-family: inherit; }
fieldset { border: 1px solid rgba(128,128,128,.3); border-radius: 6px; display: flex; gap: 10px; flex-wrap: wrap; }
.group-check { font-size: 13px; display: flex; align-items: center; gap: 4px; }
.error { color: #d9534f; font-size: 12px; }
.row { display: flex; gap: 8px; }
</style>
```

`packages/ui/src/index.ts` 追加 `export { default as EntryForm } from './components/EntryForm.vue'` 与 `export type { EntryFormData } from './components/EntryForm.vue'`

Run: `pnpm --filter @totp/ui test` → PASS（3 新用例）

- [ ] **Step 2: popup 接入编辑/删除**

App.vue script 改造：
```ts
const editing = ref<OtpEntry | null>(null)
const creating = ref(false)
const confirmingDelete = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null

async function onSave(data: EntryFormData) {
  if (editing.value) await updateEntryOp(editing.value.uuid, data)
  else await addEntryOp({ ...data, uuid: crypto.randomUUID(), algorithm: 'SHA1', digits: data.type === 'steam' ? 5 : 6, period: 30, order: 0, createdAt: Date.now() })
  editing.value = null; creating.value = false
}
function askRemove(uuid: string) {
  if (confirmingDelete.value === uuid) { void removeEntryOp(uuid); confirmingDelete.value = null; return }
  confirmingDelete.value = uuid
  if (confirmTimer) clearTimeout(confirmTimer)
  confirmTimer = setTimeout(() => (confirmingDelete.value = null), 3000)
}
```
模板：`＋ 添加`按钮改 `creating = true`；表单区 `<EntryForm v-if="creating || editing" :initial="editing" :groups="vault.groups" @save="onSave" @cancel="editing = null; creating = false" />`；每个列表项加操作区：
```html
<div class="ops">
  <template v-if="confirmingDelete === e.uuid">
    <button class="danger" @click.stop="askRemove(e.uuid)">确认删除？</button>
  </template>
  <template v-else>
    <button class="icon" @click.stop="editing = e">✎</button>
    <button class="icon" @click.stop="askRemove(e.uuid)">🗑</button>
  </template>
</div>
```
（`.ops` 默认 `opacity:0`，`.otp-item:hover .ops { opacity:1 }`；`.icon` 无边框背景；`.danger` 红字。注意与 OtpListItem 的 click 复制共存：操作按钮 `@click.stop`。OtpListItem 是独立组件——操作按钮放 popup 的列表项外层包裹 div 中，外层 div 包 OtpListItem + ops 悬浮右上角。）

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm test && pnpm --filter @totp/extension build`
Expected: 全绿

```bash
git add packages/ui/ apps/extension/
git commit -m "feat(ui): EntryForm共享编辑表单；popup条目编辑与二次确认删除"
```

---

### Task 5: options 页（条目管理 + 分组管理）

**Files:**
- Create: `apps/extension/entrypoints/options/index.html`、`apps/extension/entrypoints/options/main.ts`、`apps/extension/entrypoints/options/App.vue`

**Interfaces:**
- Consumes: store 全部操作、EntryForm、OtpListItem、SearchBar
- Produces: options 页（WXT 自动生成 `options_ui` manifest 项，`open_in_tab: true`）

- [ ] **Step 1: options 三文件**

`apps/extension/entrypoints/options/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>TOTP 验证码工具 - 管理</title>
  </head>
  <body style="margin: 0">
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`apps/extension/entrypoints/options/main.ts`:
```ts
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
```

`apps/extension/entrypoints/options/App.vue`（结构同 popup，无 URL 过滤区，增分组管理卡）：
```vue
<script setup lang="ts">
import type { EntryFormData } from '@totp/ui'
import { EntryForm, OtpListItem, SearchBar, useOtpCodes } from '@totp/ui'
import { computed, onMounted, ref } from 'vue'
import {
  addEntryOp, addGroupOp, initStore, registerStorageSync, removeEntryOp, removeGroupOp, renameGroupOp, updateEntryOp, vault,
} from '../../src/store'

const query = ref('')
const editing = ref<(typeof vault.entries)[number] | null>(null)
const creating = ref(false)
const confirmingDelete = ref<string | null>(null)
const newGroupName = ref('')
const renaming = ref<string | null>(null)
const renameValue = ref('')

onMounted(async () => {
  await initStore()
  registerStorageSync()
})

const { codes } = useOtpCodes(computed(() => [...vault.entries]))
const sorted = computed(() => [...vault.entries].sort((a, b) => a.order - b.order))
const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return sorted.value
  return sorted.value.filter((e) => `${e.issuer} ${e.label} ${e.note ?? ''}`.toLowerCase().includes(q))
})

async function onSave(data: EntryFormData) {
  if (editing.value) await updateEntryOp(editing.value.uuid, data)
  else await addEntryOp({ ...data, uuid: crypto.randomUUID(), algorithm: 'SHA1', digits: data.type === 'steam' ? 5 : 6, period: 30, order: 0, createdAt: Date.now() })
  editing.value = null
  creating.value = false
}
function askRemove(uuid: string) {
  if (confirmingDelete.value === uuid) { void removeEntryOp(uuid); confirmingDelete.value = null; return }
  confirmingDelete.value = uuid
  setTimeout(() => (confirmingDelete.value = null), 3000)
}
async function addGroup() {
  const name = newGroupName.value.trim()
  if (!name) return
  await addGroupOp(name)
  newGroupName.value = ''
}
</script>

<template>
  <main class="page">
    <h1>TOTP 验证码工具</h1>

    <section class="card">
      <h2>分组管理</h2>
      <form class="group-add" @submit.prevent="addGroup">
        <input v-model="newGroupName" placeholder="新分组名称" />
        <button type="submit">创建分组</button>
      </form>
      <ul class="group-list">
        <li v-for="g in vault.groups" :key="g.id">
          <template v-if="renaming === g.id">
            <input v-model="renameValue" @keydown.enter="renameGroupOp(g.id, renameValue.trim() || g.name); renaming = null" />
            <button @click="renameGroupOp(g.id, renameValue.trim() || g.name); renaming = null">保存</button>
            <button @click="renaming = null">取消</button>
          </template>
          <template v-else>
            <span class="gname">{{ g.name }}</span>
            <span class="gcount">{{ vault.entries.filter((e) => e.groupIds.includes(g.id)).length }} 条</span>
            <button class="icon" @click="renaming = g.id; renameValue = g.name">✎</button>
            <button class="icon" @click="removeGroupOp(g.id)">🗑</button>
          </template>
        </li>
        <li v-if="vault.groups.length === 0" class="empty">暂无分组</li>
      </ul>
    </section>

    <section class="card">
      <h2>
        条目（{{ vault.entries.length }}）
        <button @click="creating = true; editing = null">＋ 添加</button>
      </h2>
      <SearchBar v-model="query" />
      <EntryForm v-if="creating || editing" :initial="editing" :groups="vault.groups" @save="onSave" @cancel="creating = false; editing = null" />
      <div v-if="visible.length === 0" class="empty">无匹配条目</div>
      <div v-for="e in visible" :key="e.uuid" class="row">
        <OtpListItem :entry="e" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" />
        <div class="ops">
          <template v-if="confirmingDelete === e.uuid">
            <button class="danger" @click.stop="askRemove(e.uuid)">确认删除？</button>
          </template>
          <template v-else>
            <button class="icon" @click.stop="editing = e; creating = false">✎</button>
            <button class="icon" @click.stop="askRemove(e.uuid)">🗑</button>
          </template>
        </div>
      </div>
    </section>
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; }
.page { max-width: 640px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
h1 { font-size: 20px; } h2 { font-size: 15px; display: flex; justify-content: space-between; align-items: center; }
.card { border: 1px solid rgba(128,128,128,.4); border-radius: 10px; padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.group-add { display: flex; gap: 8px; }
.group-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.group-list li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.gname { font-weight: 600; } .gcount { opacity: .6; font-size: 12px; flex: 1; }
.row { position: relative; display: flex; align-items: center; }
.row :deep(.otp-item) { flex: 1; }
.ops { display: flex; gap: 4px; opacity: 0; transition: opacity .15s; }
.row:hover .ops { opacity: 1; }
.icon, .danger { border: none; background: none; cursor: pointer; padding: 4px; }
.danger { color: #d9534f; font-size: 12px; }
.empty { text-align: center; opacity: .6; padding: 16px 0; }
</style>
```

注意：options 里 useOtpCodes 的参数需 `Ref<OtpEntry[]>`——`computed(() => [...vault.entries])` 满足（computed 返回 ComputedRef）。popup 的 `useOtpCodes(entries)` 若原用 ref 也照旧。

- [ ] **Step 2: 验证 + Commit**

Run: `pnpm --filter @totp/extension build`
Expected: `.output/chrome-mv3/manifest.json` 含 `options_ui`（或 `options_page`）

```bash
git add apps/extension/
git commit -m "feat(extension): options管理页（条目管理+分组管理）"
```

---

### Task 6: MatchRule 编辑（EntryForm 内）

**Files:**
- Modify: `packages/ui/src/components/EntryForm.vue`
- Test: `packages/ui/test/EntryForm.test.ts`（追加用例）

**Interfaces:**
- Consumes: `MatchRule`、`MatchStrategy`（core）
- Produces: EntryForm 的 matchRules 区块：每条规则一行 `[策略下拉][pattern 文本框][✕ 删除]`；底部「＋ 添加匹配规则」按钮；策略文案：基础域名/主机/精确/前缀/正则

- [ ] **Step 1: 追加失败测试**

`packages/ui/test/EntryForm.test.ts` 追加:
```ts
it('添加/编辑/删除 matchRule 并随 save 提交', async () => {
  const w = mount(EntryForm, { props: { initial: entry, groups: [] } })
  await w.find('button.add-rule').trigger('click')
  const selects = w.findAll('select.rule-strategy')
  expect(selects).toHaveLength(1)
  await selects[0]!.setValue('baseDomain')
  await w.find('input.rule-pattern').setValue('github.com')
  await w.find('form').trigger('submit')
  expect(w.emitted('save')![0]![0]).toMatchObject({ matchRules: [{ strategy: 'baseDomain', pattern: 'github.com' }] })
  await w.find('button.rm-rule').trigger('click')
  await w.find('form').trigger('submit')
  expect(w.emitted('save')!.at(-1)![0]).toMatchObject({ matchRules: [] })
})
```

- [ ] **Step 2: 实现（EntryForm 模板 fieldset 后追加）**

```html
<fieldset>
  <legend>URL 匹配规则（浏览器插件按当前页过滤用）</legend>
  <div v-for="(r, i) in form.matchRules" :key="i" class="rule-row">
    <select class="rule-strategy" v-model="r.strategy">
      <option value="baseDomain">基础域名</option>
      <option value="host">主机</option>
      <option value="exact">精确</option>
      <option value="startsWith">前缀</option>
      <option value="regex">正则</option>
    </select>
    <input class="rule-pattern" v-model="r.pattern" placeholder="如 github.com 或 ^https://" />
    <button type="button" class="rm-rule" @click="form.matchRules.splice(i, 1)">✕</button>
  </div>
  <button type="button" class="add-rule" @click="form.matchRules.push({ strategy: 'baseDomain', pattern: '' })">＋ 添加匹配规则</button>
</fieldset>
```
样式：`.rule-row { display:flex; gap:6px; }`、`.rule-strategy { width: 110px; }`、`.rule-pattern { flex:1; }`。空 pattern 的规则在 submit 时过滤掉：`emit('save', { ...form, matchRules: form.matchRules.filter((r) => r.pattern.trim()), secret: cleanSecret() })`。

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm --filter @totp/ui test && pnpm --filter @totp/extension build`
Expected: PASS、build 成功

```bash
git add packages/ui/ apps/extension/
git commit -m "feat(ui): EntryForm支持URL匹配规则增删改"
```

---

### Task 7: 全仓回归 + README 更新

**Files:**
- Modify: `README.md`（功能清单补：搜索、URL 过滤、编辑/删除、options 管理页、分组管理）

- [ ] **Step 1: 回归**

Run: `pnpm test && pnpm --filter @totp/extension build && pnpm --filter @totp/extension typecheck`
Expected: 全绿（core ~76、ui ~6）

- [ ] **Step 2: README「## 结构」后补一段**

```markdown
## 插件功能（M1）

- 录入：手动（base32 校验）、TOTP/Steam
- 列表：实时验证码 + 倒计时、关键字搜索、按当前站点 URL 过滤（五种匹配策略，条目编辑中配置）
- 管理：编辑/删除（二次确认）、分组管理（options 页）
- options 页：浏览器扩展详情 → 扩展选项
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README补充M1插件功能清单"
```
