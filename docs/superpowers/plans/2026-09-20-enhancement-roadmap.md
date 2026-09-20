# 功能增强路线图实施计划（6 交付单元）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec（docs/superpowers/specs/2026-09-20-enhancement-roadmap-design.md）落地 6 个交付单元：i18n D1 机制、导出与扫码互通、QR 与智能录入（C0-C4）、Yandex + Authenticator Plus 导入、体验打磨、i18n D2 全量。

**Architecture:** core（`@totp/core` 纯 TS）新增 export/qr-free 的导出算法、yandex OTP、zip-AES 解密与粘贴解析分发；ui（`@totp/ui` Vue 3 共享层）新增 QR 渲染/解码、双 Tab 新增弹窗、导出卡格式选择与多选拼版；两端壳（extension/desktop）仅做平台保存与 background 右键菜单适配。

**Tech Stack:** vue-i18n@11、uqr（QR 矩阵生成）、jsQR（解码）、fflate inflateRaw（AP zip）、WebCrypto（PBKDF2-HMAC-SHA1/AES-CTR/HMAC）、vitest + @vue/test-utils。

**Spec:** docs/superpowers/specs/2026-09-20-enhancement-roadmap-design.md

## Global Constraints

- **零新增 manifest 权限**（`apps/extension/wxt.config.ts` 现有清单不许扩；Task 17 的 `scripting` 例外须先回报需求方）。
- Task 1 落地后所有新增 UI 字符串一律 `t('key')`，不再产生硬编码中文文案（D2 前的过渡期旧文案不动）。
- vault 新增可选字段（`pin`、settings 新字段）走「可选 + 类型校验 + DEFAULT 兜底合并」模式（`loadSettings` M4 注释口径），**不 bump Vault.version**。
- 每个任务结束：对应包测试全绿 + `pnpm --filter <pkg> exec vue-tsc --noEmit`（ui 包）/ `tsc --noEmit`（core）无新增错误；commit 用 Angular 规范、原子提交。
- 权威对齐基线（实施时不得凭记忆改参数）：Yandex = Aegis `YandexInfo.java` + `crypto/otp/YAOTP.java`；AP 导入 = Aegis `importers/AuthenticatorPlusImporter.java`（加密 zip 内 `Accounts.txt` → otpauth URI 逐行）；Aegis vault 文件布局 = 本项目 `packages/core/src/import/aegis.ts` 头部注释（VaultFile/CryptParameters/CryptoUtils 已核对）。
- 测试基线：现有全部用例保持通过（core 477+ / ui 566+ / extension 65+ / desktop 79+），只增不减。

---

## Part 0：i18n D1 机制先行

### Task 1: vue-i18n 引入与工厂

**Files:**
- Modify: `packages/ui/package.json`（dependencies 加 vue-i18n）
- Create: `packages/ui/src/i18n/index.ts`
- Create: `packages/ui/src/i18n/locales/zh/common.json`、`packages/ui/src/i18n/locales/en/common.json`
- Modify: `packages/ui/src/index.ts`（追加导出）
- Modify: `apps/extension/entrypoints/popup/main.ts`、`apps/extension/entrypoints/options/main.ts`、`apps/desktop/src/main.ts`、`apps/desktop/src/mini.ts`（挂载）
- Test: `packages/ui/test/i18n.test.ts`

**Interfaces:**
- Produces: `createAppI18n(store: VueStore): I18n<false>`（`@totp/ui` 导出；四个壳 `app.use(createAppI18n(store))`）
- Produces: 资源目录约定 `locales/{zh,en}/<模块>.json`，后续任务的 key 先写进 `common.json`（D2 再拆模块）

- [ ] **Step 1: 安装依赖**

```bash
pnpm --filter @totp/ui add vue-i18n@^11
```

- [ ] **Step 2: 写失败测试** `packages/ui/test/i18n.test.ts`

```ts
import { createAppI18n } from '../src/i18n'
import { createVueStore } from '../src/store'
import { describe, expect, it } from 'vitest'
import type { StorageAdapter } from '@totp/core'

const memAdapter = (): StorageAdapter => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) }
}

describe('createAppI18n', () => {
  it('locale 跟随 settings.locale（en 生效，zh 为回退）', () => {
    const store = createVueStore(memAdapter())
    store.settings.locale = 'en'
    const i18n = createAppI18n(store)
    expect(i18n.global.locale.value).toBe('en')
    expect(i18n.global.t('app.title')).not.toBe('app.title') // en 资源已就绪
  })
  it('settings.locale=auto 时按 navigator.language 判定（非 *-en* 落 zh）', () => {
    const store = createVueStore(memAdapter())
    store.settings.locale = 'auto'
    const i18n = createAppI18n(store)
    expect(['zh', 'en']).toContain(i18n.global.locale.value)
  })
  it('settings.locale 变更联动 locale', () => {
    const store = createVueStore(memAdapter())
    const i18n = createAppI18n(store)
    store.settings.locale = 'en'
    expect(i18n.global.locale.value).toBe('en')
  })
})
```

注意：该测试依赖 Task 2 的 `locale` 字段才可编译——本任务先在 `AppSettings` 落 `locale` 字段（Step 3），测试随后跑通。

- [ ] **Step 3: core 加 settings.locale**（本步骤与 Task 2 Step 1 相同，直接完成 Task 2 的 Step 1-2 后回到这里）

- [ ] **Step 4: 实现** `packages/ui/src/i18n/index.ts`

```ts
import { createI18n, type I18n } from 'vue-i18n'
import { watch } from 'vue'
import type { VueStore } from '../store'
import zh from './locales/zh/common.json'
import en from './locales/en/common.json'

/** D1：i18n 机制。locale 源 = settings.locale（auto → navigator.language 判定，zh 兜底回退） */
export function createAppI18n(store: VueStore): I18n<false> {
  const resolve = (l: string): 'zh' | 'en' =>
    l === 'en' ? 'en' : l === 'zh' ? 'zh' : (typeof navigator !== 'undefined' && /^en/i.test(navigator.language) ? 'en' : 'zh')
  const i18n = createI18n({ legacy: false, locale: resolve(store.settings.locale), fallbackLocale: 'zh', messages: { zh, en } })
  watch(() => store.settings.locale, (l) => { i18n.global.locale.value = resolve(l) })
  return i18n
}
```

`locales/zh/common.json`：

```json
{ "app": { "title": "TOTP 验证码工具" } }
```

`locales/en/common.json`：

```json
{ "app": { "title": "TOTP Code Tool" } }
```

`packages/ui/src/index.ts` 追加：

```ts
export { createAppI18n } from './i18n'
```

- [ ] **Step 5: 四个壳挂载**（每个 `createApp` 调用处，在 `app.use(router)` 同级追加；`store` 变量名以各文件现状为准）

```ts
import { createAppI18n } from '@totp/ui'
// ...
app.use(createAppI18n(store))
```

- [ ] **Step 6: 跑测试与 typecheck**

```bash
pnpm --filter @totp/ui test -- i18n
pnpm --filter @totp/ui exec vue-tsc --noEmit
```

Expected: PASS / 无新增错误。

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/i18n packages/ui/src/index.ts packages/ui/package.json packages/ui/test/i18n.test.ts packages/core/src/storage/vaultStore.ts apps/extension/entrypoints apps/desktop/src/main.ts apps/desktop/src/mini.ts pnpm-lock.yaml
git commit -m "feat(i18n): 引入 vue-i18n 机制（settings.locale + 四壳挂载，D1）"
```

### Task 2: settings.locale 字段

**Files:**
- Modify: `packages/core/src/storage/vaultStore.ts:104`（AppSettings 接口）、`:136`（DEFAULT_SETTINGS）、`:151-178`（loadSettings 校验）
- Test: `packages/core/test/settingsLocale.test.ts`（或就近的 vaultStore settings 测试文件内追加）

**Interfaces:**
- Produces: `AppSettings.locale: 'auto' | 'zh' | 'en'`（默认 `'auto'`；Task 1/Task 20 消费）

- [ ] **Step 1: 写失败测试**

```ts
import { DEFAULT_SETTINGS, loadSettings, type AppSettings, type StorageAdapter } from '@totp/core'
import { describe, expect, it } from 'vitest'

const adapterWith = (v: unknown): StorageAdapter => ({
  get: async (k) => (k === 'settings' ? JSON.stringify(v) : null),
  set: async () => {}, delete: async () => {},
})

describe('settings.locale', () => {
  it('缺省 auto；非法值回退默认', async () => {
    expect((await loadSettings(adapterWith({}))).locale).toBe('auto')
    expect((await loadSettings(adapterWith({ locale: 'fr' }))).locale).toBe('auto')
  })
  it('合法值保留', async () => {
    for (const locale of ['zh', 'en'] as const) {
      expect((await loadSettings(adapterWith({ locale }))).locale).toBe(locale)
    }
  })
  it('DEFAULT_SETTINGS 含 locale=auto', () => {
    expect(DEFAULT_SETTINGS.locale).toBe('auto')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @totp/core test -- settingsLocale
```

Expected: FAIL（locale 字段不存在）。

- [ ] **Step 3: 实现**——`AppSettings` 接口（`lastTagFilterIds` 之后）加：

```ts
/** 界面语言：auto=跟随浏览器语言（非 en 即 zh）；zh 源语言兼回退（spec §1） */
locale: 'auto' | 'zh' | 'en'
```

`DEFAULT_SETTINGS` 加 `locale: 'auto',`。`loadSettings` 返回对象加一行（M4 逐字段模式）：

```ts
locale: merged.locale === 'zh' || merged.locale === 'en' || merged.locale === 'auto' ? merged.locale : DEFAULT_SETTINGS.locale,
```

- [ ] **Step 4: 跑测试通过 + Commit**

```bash
pnpm --filter @totp/core test -- settingsLocale
git add packages/core/src/storage/vaultStore.ts packages/core/test
git commit -m "feat(core): settings 新增 locale 语言偏好（auto/zh/en）"
```

### Task 3: SettingsPage 语言选择 + NavigationShell/LockScreen 抽串示范

**Files:**
- Modify: `packages/ui/src/pages/SettingsPage.vue`（外观区加语言 MdSelect）
- Modify: `packages/ui/src/components/NavigationShell.vue`、`packages/ui/src/components/LockScreen.vue`（抽串示范）
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`（新增 keys）
- Modify: `packages/ui/test/NavigationShell.test.ts`、`packages/ui/test/LockScreen.test.ts`（如断言文案需适配；断言语言保持 zh）

**Interfaces:**
- Consumes: `useI18n()`（vue-i18n composition，组件 `<script setup>` 内 `const { t } = useI18n()`）
- Produces: key 命名约定 `<模块>.<语义名>`（如 `nav.codes`、`lock.unlockBtn`）；本任务产出 nav/lock 两组 key

- [ ] **Step 1: SettingsPage 语言选择**（`themeMode` 选择器同款模式，外观分组内追加）

```vue
<div class="set-row">
  <MdSelect class="set-locale" :model-value="store.settings.locale"
    aria-label="界面语言" @update:model-value="setLocale($event)">
    <option value="auto">跟随浏览器</option>
    <option value="zh">中文</option>
    <option value="en">English</option>
  </MdSelect>
</div>
```

```ts
async function setLocale(v: string | number): Promise<void> {
  store.settings.locale = v as AppSettings['locale']
  await store.commitSettings()
}
```

- [ ] **Step 2: 抽串示范（模式说明，机械应用于两个组件全部文案）**

对组件内每处硬编码中文文案（模板插值、属性、title/aria-label、alert 字符串字面量）：

before（以 NavigationShell 页签标题为例，实际以文件现状为准）：

```vue
< MdButton ... >验证码</MdButton>
```

after：

```vue
<MdButton ...>{{ t('nav.codes') }}</MdButton>
```

`common.json` keys（本任务至少完成以下四组，组件内其余文案同模式逐个迁移；先 `rg -o "['\"">][^'\"<>{}]*[\u4e00-\u9fff][^'\"<>{}]*" <文件>` 列出全量文案再逐条建 key）：

```json
{ "nav": { "codes": "验证码", "import": "导入", "sync": "备份", "security": "安全", "settings": "设置" },
  "lock": { "title": "已锁定", "passphrase": "主口令", "unlock": "解锁", "unlockWithPasskey": "用 Passkey 解锁" } }
```

en 侧同 key 对应英译（nav: Codes/Import/Backup/Security/Settings；lock: Locked/Passphrase/Unlock/Unlock with Passkey）。

- [ ] **Step 3: 测试适配**——组件测试挂 i18n（`mount(Comp, { global: { plugins: [i18n] } })`，i18n 用 `createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })` 小工厂，放 `packages/ui/test/helpers/i18n.ts`）；断言仍按中文（locale=zh 与资源一致）。

- [ ] **Step 4: 跑 ui 全量测试 + typecheck + Commit**

```bash
pnpm --filter @totp/ui test
pnpm --filter @totp/ui exec vue-tsc --noEmit
git add packages/ui
git commit -m "feat(i18n): 设置页语言选择；NavigationShell/LockScreen 抽串示范（D1）"
```

---

## Part 1：批① 导出与扫码互通

### Task 4: core — otpauth 文本导出

**Files:**
- Create: `packages/core/src/export/otpauthText.ts`
- Modify: `packages/core/src/index.ts`（`export * from './export/otpauthText'` 等，随各任务追加）
- Test: `packages/core/test/exportOtpauthText.test.ts`

**Interfaces:**
- Consumes: `buildOtpUri(p: OtpUriParams): string`（`packages/core/src/otp/uri.ts:100`）
- Produces: `exportOtpauthText(v: Vault): string`（每行一条；HOTP 恒带 counter；steam host）

- [ ] **Step 1: 写失败测试**

```ts
import { createVault, addEntry, exportOtpauthText, parseOtpUri, newEntryFromUri, type OtpEntry, type Vault } from '@totp/core'
import { describe, expect, it } from 'vitest'

function vaultWith(entries: OtpEntry[]): Vault {
  let v = createVault()
  for (const e of entries) v = addEntry(v, e)
  return v
}

describe('exportOtpauthText', () => {
  it('totp/hotp/steam 逐行导出且可回读（round-trip）', () => {
    const totp = newEntryFromUri('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP')
    const hotp = newEntryFromUri('otpauth://hotp/Repo:bob?secret=JBSWY3DPEHPK3PXP&counter=7')
    const steam = newEntryFromUri('otpauth://steam/Steam:carol?secret=JBSWY3DPEHPK3PXP')
    const text = exportOtpauthText(vaultWith([totp, hotp, steam]))
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    const [a, b, c] = lines.map((l) => parseOtpUri(l))
    expect(a.type).toBe('totp'); expect(a.issuer).toBe('GitHub'); expect(a.label).toBe('alice')
    expect(b.type).toBe('hotp'); expect(b.counter).toBe(7)
    expect(c.type).toBe('steam'); expect(c.digits).toBe(5)
  })
  it('空 vault 导出空串', () => {
    expect(exportOtpauthText(createVault())).toBe('')
  })
})
```

- [ ] **Step 2: 跑失败** —— `pnpm --filter @totp/core exec vitest run test/exportOtpauthText.test.ts`，Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现** `packages/core/src/export/otpauthText.ts`

```ts
import { buildOtpUri, type Vault } from '../..'

/** 批① §2.1：每行一条 otpauth URI。HOTP 恒带 counter（buildOtpUri 已保证）；steam 走 otpauth://steam/ */
export function exportOtpauthText(v: Vault): string {
  return v.entries
    .map((e) => buildOtpUri({ type: e.type, issuer: e.issuer, label: e.label, secret: e.secret, algorithm: e.algorithm, digits: e.digits, period: e.period, counter: e.counter }))
    .join('\n')
}
```

`packages/core/src/index.ts` 追加 `export * from './export/otpauthText'`。

- [ ] **Step 4: 跑通过**（同 Step 2 命令，Expected: PASS）
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/export packages/core/src/index.ts packages/core/test/exportOtpauthText.test.ts
git commit -m "feat(core): otpauth URI 逐行明文导出（批① §2.1）"
```

### Task 5: core — Aegis 明文 vault 导出

**Files:**
- Create: `packages/core/src/export/aegisVault.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/exportAegisPlaintext.test.ts`

**Interfaces:**
- Consumes: `importAegisPlaintext(text: string): ImportResult`（`packages/core/src/import/aegis.ts:140`）
- Produces:
  - `exportAegisPlaintext(v: Vault): { json: string; report: AegisExportReport }`
  - `interface AegisExportReport { usedGroups: string[]; droppedTagCount: number }`（多标签取第一个，其余计入 droppedTagCount——spec §2.2）

- [ ] **Step 1: 写失败测试**

```ts
import { addEntry, createVault, exportAegisPlaintext, importAegisPlaintext, newEntryFromUri, resolveTagNames } from '@totp/core'
import { describe, expect, it } from 'vitest'

describe('exportAegisPlaintext', () => {
  it('round-trip：导出 → 本项目 Aegis 明文导入器逐字段恒等', () => {
    const e1 = newEntryFromUri('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60')
    const e2 = newEntryFromUri('otpauth://hotp/Repo:bob?secret=JBSWY3DPEHPK3PXP&counter=3')
    const e3 = newEntryFromUri('otpauth://steam/Steam:carol?secret=JBSWY3DPEHPK3PXP')
    let v = createVault()
    for (const e of [e1, e2, e3]) v = addEntry(v, e)
    const { json } = exportAegisPlaintext(v)
    const r = importAegisPlaintext(json)
    expect(r.failures).toEqual([])
    expect(r.entries.map((x) => [x.type, x.issuer, x.label, x.secret, x.algorithm, x.digits, x.period])).toEqual([
      ['totp', 'GitHub', 'alice', 'JBSWY3DPEHPK3PXP', 'SHA256', 8, 60],
      ['hotp', 'Repo', 'bob', 'JBSWY3DPEHPK3PXP', 'SHA1', 6, 30],
      ['steam', 'Steam', 'carol', 'JBSWY3DPEHPK3PXP', 'SHA1', 5, 30],
    ])
    expect(r.entries[1]!.counter).toBe(3)
  })
  it('多标签条目：第一个标签映射 group，其余计入 report.droppedTagCount', () => {
    const e = newEntryFromUri('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP')
    let v = createVault()
    const { vault: v1, tagIds } = resolveTagNames(v, ['工作', '重要']) // 两个 tag
    v = v1
    e.tagIds = [tagIds[0]!, tagIds[1]!]
    v = addEntry(v, e)
    const { json, report } = exportAegisPlaintext(v)
    expect(report.droppedTagCount).toBe(1)
    const r = importAegisPlaintext(json)
    expect(r.entries[0]!.tags).toEqual(['工作'])
  })
  it('顶层结构对齐 Aegis VaultFile：version/header.slots 为空数组/db.entries', () => {
    const v = addEntry(createVault(), newEntryFromUri('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP'))
    const obj = JSON.parse(exportAegisPlaintext(v).json) as Record<string, unknown>
    expect(obj['version']).toBe(1)
    expect((obj['header'] as Record<string, unknown>)['slots']).toEqual([])
    expect(Array.isArray((obj['db'] as Record<string, unknown>)['entries'])).toBe(true)
  })
})
```

- [ ] **Step 2: 跑失败**（模块不存在）

- [ ] **Step 3: 实现** `packages/core/src/export/aegisVault.ts`

```ts
import { randomUUID } from './random'
import type { OtpEntry, Vault } from '../model'

// 布局对齐 Aegis VaultFile.java（本项目 import/aegis.ts 头部注释已核对）：
// 顶层 {version:1, header:{slots,params}, db}；明文 header.slots=[]、db 为对象。
// entry 字段对齐 import 侧 parseEntry 读取口径：type/name/issuer/note/group + info{secret,algo,digits,period,counter}。

export interface AegisExportReport {
  /** 实际写入的 group 名（去重，条目顺序） */
  usedGroups: string[]
  /** 多标签条目中被丢弃的标签总数（每条目保留第一个，spec §2.2） */
  droppedTagCount: number
}

export interface AegisExportResult {
  json: string
  report: AegisExportReport
}

interface AegisEntryJson {
  type: OtpEntry['type']
  uuid: string
  name: string
  issuer?: string
  note?: string
  group?: string
  info: { secret: string; algo: string; digits: number; period: number; counter?: number }
}

function tagNameOf(v: Vault, id: string): string | null {
  return v.tags.find((t) => t.id === id)?.name ?? null
}

function toAegisEntry(v: Vault, e: OtpEntry, report: AegisExportReport): AegisEntryJson {
  const names = e.tagIds.map((id) => tagNameOf(v, id)).filter((n): n is string => n !== null)
  const group = names[0]
  report.droppedTagCount += Math.max(0, names.length - 1)
  const name = e.issuer !== '' ? `${e.issuer}:${e.label}` : e.label
  return {
    type: e.type,
    uuid: e.uuid,
    name,
    ...(e.issuer !== '' ? { issuer: e.issuer } : {}),
    ...(e.note !== undefined && e.note !== '' ? { note: e.note } : {}),
    ...(group !== undefined ? { group } : {}),
    info: {
      secret: e.secret,
      algo: e.algorithm,
      digits: e.digits,
      period: e.period,
      ...(e.type === 'hotp' ? { counter: e.counter ?? 0 } : {}),
    },
  }
}

function buildDb(v: Vault, report: AegisExportReport): Record<string, unknown> {
  const entries = v.entries.map((e) => toAegisEntry(v, e, report))
  const groups = [...new Set(entries.map((x) => x.group).filter((g): g is string => g !== undefined))]
  report.usedGroups = groups
  return { entries, groups: groups.map((name) => ({ uuid: randomUUID(), name })) }
}

export function exportAegisPlaintext(v: Vault): AegisExportResult {
  const report: AegisExportReport = { usedGroups: [], droppedTagCount: 0 }
  const json = JSON.stringify({ version: 1, header: { slots: [], params: {} }, db: buildDb(v, report) })
  return { json, report }
}
```

`randomUUID`：core 现有 uuid 生成方式以 `rg -n "randomUUID|crypto.randomUUID" packages/core/src | head -3` 确认；若无统一 helper，在 `aegisVault.ts` 内联：

```ts
const randomUUID = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)
```

`packages/core/src/index.ts` 追加 `export * from './export/aegisVault'`。

- [ ] **Step 4: 跑通过**
- [ ] **Step 5: Commit**

```bash
git add packages/core/src/export packages/core/src/index.ts packages/core/test/exportAegisPlaintext.test.ts
git commit -m "feat(core): Aegis 明文 vault 导出（多标签取首个并报告丢弃数）"
```

### Task 6: core — Aegis 加密 vault 导出

**Files:**
- Modify: `packages/core/src/export/aegisVault.ts`（追加加密导出）
- Test: `packages/core/test/exportAegisEncrypted.test.ts`

**Interfaces:**
- Consumes: `scrypt`（hash-wasm，参数名 costFactor/blockSize/parallelism，见 `import/aegis.ts:197`）、`aesGcmEncrypt/aesGcmDecrypt`（`crypto/aesgcm.ts`，WebCrypto 返回 `ct||tag` 连体）、`bytesToBase64`、`hexToBytes`
- Produces: `exportAegisEncrypted(v: Vault, password: string): Promise<AegisExportResult>`

- [ ] **Step 1: 写失败测试**

```ts
import { addEntry, createVault, exportAegisEncrypted, importAegisEncrypted, newEntryFromUri } from '@totp/core'
import { describe, expect, it } from 'vitest'

const SECRET = 'JBSWY3DPEHPK3PXP'

describe('exportAegisEncrypted', () => {
  it('round-trip：加密导出 → 本项目 Aegis 加密导入器（对齐官方 scrypt+GCM）可解密且逐字段恒等', async () => {
    let v = createVault()
    v = addEntry(v, newEntryFromUri(`otpauth://totp/GitHub:alice?secret=${SECRET}`))
    const { json } = await exportAegisEncrypted(v, '口令-pass-123')
    const r = await importAegisEncrypted(json, '口令-pass-123')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]!.issuer).toBe('GitHub')
    expect(r.entries[0]!.secret).toBe(SECRET)
  })
  it('错误口令抛「口令错误或文件已损坏」', async () => {
    let v = createVault()
    v = addEntry(v, newEntryFromUri(`otpauth://totp/G:a?secret=${SECRET}`))
    const { json } = await exportAegisEncrypted(v, 'right')
    await expect(importAegisEncrypted(json, 'wrong')).rejects.toThrow('口令错误或文件已损坏')
  })
  it('header 结构：单个 PasswordSlot(type=1, n=16384,r=8,p=1) + params.nonce/tag', async () => {
    let v = createVault()
    v = addEntry(v, newEntryFromUri(`otpauth://totp/G:a?secret=${SECRET}`))
    const { json } = await exportAegisEncrypted(v, 'pw')
    const obj = JSON.parse(json) as { header: { slots: Array<Record<string, unknown>>; params: Record<string, unknown> }; db: string }
    expect(typeof obj.db).toBe('string')
    expect(obj.header.slots).toHaveLength(1)
    const slot = obj.header.slots[0]!
    expect(slot['type']).toBe(1)
    expect(slot['n']).toBe(16384); expect(slot['r']).toBe(8); expect(slot['p']).toBe(1)
    expect(typeof obj.header.params['nonce']).toBe('string')
    expect(typeof obj.header.params['tag']).toBe('string')
  })
})
```

- [ ] **Step 2: 跑失败**

- [ ] **Step 3: 实现**（追加到 `aegisVault.ts`；`aesGcmEncrypt` 签名以 `packages/core/src/crypto/aesgcm.ts` 实际导出为准——`aesGcmDecrypt(key, data, nonce)` 已在 import 侧使用，加密侧若名为 `aesGcmEncrypt(key, plaintext, nonce)` 直接用；`bytesToBase64` 从 `../crypto/aesgcm` 或 `../encoding` 取实际导出）

```ts
import { scrypt } from 'hash-wasm'
import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64 } from '../crypto/aesgcm'
import { hexToBytes } from '../encoding/hex'

// 与 import/aegis.ts 同口径：AES-256-GCM（nonce 12B、tag 16B，WebCrypto 产 ct||tag 连体后拆分存储）；
// PasswordSlot(type=1)：KEK = scrypt(pw, salt, n=16384, r=8, p=1)（Aegis 默认档）包 master key。
const AEGIS_SCRYPT = { costFactor: 16384, blockSize: 8, parallelism: 1, hashLength: 32 } as const

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** GCM 加密并按 Aegis 布局拆 nonce/tag（encrypt 输入随机 12B nonce，输出 ct||tag） */
async function gcmSplit(key: Uint8Array, plain: Uint8Array): Promise<{ ct: Uint8Array; tag: Uint8Array; nonce: Uint8Array }> {
  const nonce = randomBytes(12)
  const out = new Uint8Array(await aesGcmEncrypt(key, plain, nonce))
  const ct = out.slice(0, out.length - 16)
  const tag = out.slice(out.length - 16)
  return { ct, tag, nonce }
}

export async function exportAegisEncrypted(v: Vault, password: string): Promise<AegisExportResult> {
  const report: AegisExportReport = { usedGroups: [], droppedTagCount: 0 }
  const dbJson = JSON.stringify(buildDb(v, report))

  // ① master key（32B 随机）→ 加密 db
  const master = randomBytes(32)
  const db = gcmSplit(master, new TextEncoder().encode(dbJson))

  // ② PasswordSlot：KEK = scrypt(password, salt) 包 master key
  const salt = randomBytes(16)
  const kek = (await scrypt({ password, salt, ...AEGIS_SCRYPT, outputType: 'binary' })) as Uint8Array
  const slotWrap = gcmSplit(kek, master)

  const header = {
    slots: [{
      type: 1,
      uuid: randomUUID(),
      key: bytesToHex(slotWrap.ct),
      key_params: { nonce: bytesToHex(slotWrap.nonce), tag: bytesToHex(slotWrap.tag) },
      salt: bytesToHex(salt),
      ...AEGIS_SCRYPT_NRP,
    }],
    params: { nonce: bytesToHex(db.nonce), tag: bytesToHex(db.tag) },
  }
  const json = JSON.stringify({ version: 1, header, db: bytesToBase64(db.ct) })
  return { json, report }
}

const AEGIS_SCRYPT_NRP = { n: 16384, r: 8, p: 1 } as const
```

注意：`aesGcmEncrypt` 若 core 未导出（仅解密侧），按 `aesGcmDecrypt` 同型在 `crypto/aesgcm.ts` 补：

```ts
export async function aesGcmEncrypt(key: Uint8Array, plain: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt'])
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 }, k, plain as BufferSource))
}
```

- [ ] **Step 4: 跑通过**（round-trip 即权威验证：本项目导入器已与官方实现对齐）
- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): Aegis 加密 vault 导出（scrypt 16384/8/1 + AES-GCM，复用导入侧原语反写）"
```

### Task 7: 导出卡格式选择 + 两端保存

**Files:**
- Modify: `packages/ui/src/components/backupPlatform.ts`（接口加 `saveTextFile`）
- Modify: `packages/ui/src/components/BackupCard.vue`（导出区：格式选择 + Aegis 加密口令 + 明文二次确认）
- Modify: `apps/extension/entrypoints/options/App.vue`（backupPlatform 实现加 `saveTextFile`：Blob + `<a download>`）
- Modify: `apps/desktop/src/App.vue`（backupPlatform 实现加 `saveTextFile`：`pickBackupSaveOs` + `writeBackupFileOs`）
- Test: `packages/ui/test/BackupCard.export.test.ts`

**Interfaces:**
- Consumes: `exportOtpauthText` / `exportAegisPlaintext` / `exportAegisEncrypted`（Task 4-6）、`BackupPlatform`（`packages/ui/src/components/backupPlatform.ts` 现有接口）
- Produces: `BackupPlatform.saveTextFile?(name: string, content: string): Promise<boolean>`（false=用户取消；两端实现）

- [ ] **Step 1: 写失败测试** `packages/ui/test/BackupCard.export.test.ts`

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import BackupCard from '../src/components/BackupCard.vue'
import type { BackupPlatform } from '../src/components/backupPlatform'

const basePlatform = (over: Partial<BackupPlatform> = {}): BackupPlatform => ({
  createBackup: vi.fn(async () => 'ok'),
  restoreFromPicker: vi.fn(async () => null),
  replaceAllOp: vi.fn(),
  ...over,
}) as BackupPlatform

const mountCard = (platform: BackupPlatform) =>
  mount(BackupCard, { props: { platform, vaultJson: '{"version":2,"entries":[],"tags":[],"updatedAt":0}', sessionSecret: 'pw' } })

describe('BackupCard 导出格式（spec §2.3）', () => {
  it('选择 otpauth 文本：确认明文风险后调 saveTextFile 且内容为 URI 行', async () => {
    const saveTextFile = vi.fn(async () => true)
    const w = mountCard(basePlatform({ saveTextFile }))
    await w.find('[data-test="export-format"]').setValue('otpauth-text')
    await w.find('[data-test="export-run"]').trigger('click')
    await w.find('[data-test="export-confirm"]').trigger('click') // 二次确认
    expect(saveTextFile).toHaveBeenCalledOnce()
    expect(saveTextFile.mock.calls[0]![0]).toMatch(/\.txt$/)
  })
  it('选择 Aegis 加密：要求口令输入，未输入时禁用导出', async () => {
    const saveTextFile = vi.fn(async () => true)
    const w = mountCard(basePlatform({ saveTextFile }))
    await w.find('[data-test="export-format"]').setValue('aegis-encrypted')
    expect((w.find('[data-test="export-run"]').element as HTMLButtonElement).disabled).toBe(true)
    await w.find('[data-test="export-password"]').setValue('pw2')
    expect((w.find('[data-test="export-run"]').element as HTMLButtonElement).disabled).toBe(false)
  })
  it('记住口令勾选且 vault 已解锁时：调用宿主 setBackupSecret（经 platform 或事件上抛）', async () => {
    // 具体断言按实现路径二选一：BackupCard emit('remember-secret', pw) 由宿主调 store.setBackupSecret
    const w = mountCard(basePlatform({ saveTextFile: async () => true }))
    await w.find('[data-test="export-format"]').setValue('aegis-encrypted')
    await w.find('[data-test="export-password"]').setValue('pw2')
    await w.find('[data-test="export-remember"]').setValue(true)
    await w.find('[data-test="export-run"]').trigger('click')
    await w.find('[data-test="export-confirm"]').trigger('click')
    expect(w.emitted('remember-secret')?.[0]).toEqual(['pw2'])
  })
})
```

- [ ] **Step 2: 跑失败**

- [ ] **Step 3: 实现 BackupCard 导出区**（模板要点；`vaultJson` prop 已有，导出用 `JSON.parse(props.vaultJson) as Vault`；core 导出函数从 `@totp/core` import）

结构：`导出格式` MdSelect（`data-test="export-format"`，四项：`totp-backup`（默认，走现状 exportToFile）/`otpauth-text`/`aegis-plain`/`aegis-encrypted`）→ 选 aegis-encrypted 时显示口令 MdTextField（`data-test="export-password"`）+「记住到保管区」MdCheckbox（`data-test="export-remember"`，emit `remember-secret`）→「导出」按钮（`data-test="export-run"`，加密未输口令时 disabled）→ 明文两种先弹两步确认（复用卡内 `pending` 两步确认模式：确认按钮 `data-test="export-confirm"`，文案「导出为明文，任何人读取该内容即可获取全部密钥，确认继续？」）→ 调 `props.platform.saveTextFile(name, content)`：

```ts
async function runExport(): Promise<void> {
  if (!props.platform) return
  const v = JSON.parse(props.vaultJson) as Vault
  if (fmt.value === 'totp-backup') { /* 现状 onExport 逻辑不动 */ return }
  busy.value = true
  try {
    if (fmt.value === 'otpauth-text') {
      ok(await props.platform.saveTextFile!('totp-export.txt', exportOtpauthText(v)))
    } else if (fmt.value === 'aegis-plain') {
      const { json, report } = exportAegisPlaintext(v)
      const saved = await props.platform.saveTextFile!('aegis-export.json', json)
      okWithDropped(saved, report)
    } else {
      const { json, report } = await exportAegisEncrypted(v, encPw.value)
      const saved = await props.platform.saveTextFile!('aegis-export.json', json)
      if (remember.value) emit('remember-secret', encPw.value)
      okWithDropped(saved, report)
    }
  } catch (e) { fail(e) } finally { busy.value = false }
}
function okWithDropped(saved: boolean, report: { droppedTagCount: number }): void {
  msg.value = !saved ? '已取消' : `已导出` + (report.droppedTagCount > 0 ? `（${report.droppedTagCount} 个多余标签未导出：Aegis 条目仅支持单分组）` : '')
  msgKind.value = saved ? 'ok' : 'hint'
}
```

`BackupCard.vue` emits 追加 `remember-secret: [pw: string]`；options/desktop 宿主在 `<BackupCard @remember-secret="(pw) => store.setBackupSecret(pw, true)">` 处接线（两端 App.vue 各一行）。

- [ ] **Step 4: 两端 saveTextFile 实现**

extension（`apps/extension/entrypoints/options/App.vue` 的 backupPlatform 对象内，参照现有 `downloadEnvelope`）：

```ts
async saveTextFile(name: string, content: string): Promise<boolean> {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
},
```

desktop（`apps/desktop/src/App.vue`，复用 `pickBackupSaveOs`/`writeBackupFileOs`；filters 允许 `.json/.txt`）：

```ts
async saveTextFile(name: string, content: string): Promise<boolean> {
  const picked = await pickBackupSaveOs(name, TEXT_FILE_FILTERS) // filters 常量就近定义：{ extensions: ['json','txt'], label: '导出文件' }
  if (!picked) return false
  await writeBackupFileOs(picked, content)
  return true
},
```

- [ ] **Step 5: 跑通过**（`pnpm --filter @totp/ui test -- BackupCard.export` + 两端 `tsc`/`vue-tsc`）
- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/backupPlatform.ts packages/ui/src/components/BackupCard.vue packages/ui/test/BackupCard.export.test.ts apps/extension/entrypoints/options/App.vue apps/desktop/src/App.vue
git commit -m "feat(export): 导出卡四格式（otpauth 文本/Aegis 明文/加密/备份），明文二次确认与口令保管（批① §2.3）"
```

### Task 8: ui — QR 矩阵与 canvas 绘制

**Files:**
- Modify: `packages/ui/package.json`（`pnpm --filter @totp/ui add uqr`）
- Create: `packages/ui/src/qr/qrDraw.ts`
- Test: `packages/ui/test/qrDraw.test.ts`

**Interfaces:**
- Produces:
  - `qrMatrix(text: string): { size: number; get(x: number, y: number): boolean }`
  - `drawQrToCanvas(canvas: HTMLCanvasElement, grid: QrGrid, opts?: { moduleSize?: number; marginModules?: number }): void`
  - `COLS_TABLE`：拼版列数规则（Task 10 消费）

- [ ] **Step 1: 安装 + 写失败测试**

```bash
pnpm --filter @totp/ui add uqr
```

```ts
import { drawQrToCanvas, qrMatrix } from '../src/qr/qrDraw'
import { describe, expect, it } from 'vitest'

describe('qrMatrix', () => {
  it('uri 生成方阵且三个定位角为黑（find pattern）', () => {
    const g = qrMatrix('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP')
    expect(g.size).toBeGreaterThan(20)
    for (const [ox, oy] of [[0, 0], [g.size - 7, 0], [0, g.size - 7]] as const) {
      expect(g.get(ox, oy)).toBe(true)          // 左上角模块黑
      expect(g.get(ox + 6, oy)).toBe(true)      // 定位框右缘黑
    }
  })
})
```

（canvas 绘制的像素级断言放 Task 11 的 round-trip——jsQR 解回即最强验证；此处仅断言矩阵结构。）

- [ ] **Step 2: 实现** `packages/ui/src/qr/qrDraw.ts`

```ts
import { encode } from 'uqr'

export interface QrGrid {
  size: number
  get(x: number, y: number): boolean
}

/** uqr 生成矩阵（纠错 M，spec §2.4）；quiet zone 由绘制层 marginModules 保证 */
export function qrMatrix(text: string): QrGrid {
  const { size, data } = encode(text, { ecc: 'M' })
  return { size, get: (x, y) => data[y]![x] === true }
}

export interface QrDrawOpts {
  moduleSize?: number
  marginModules?: number
}

/** 白底黑码（扫描对比度），ctx 就地绘制不清理外部内容 */
export function drawQrToCanvas(canvas: HTMLCanvasElement, grid: QrGrid, opts: QrDrawOpts = {}): void {
  const moduleSize = opts.moduleSize ?? 6
  const margin = (opts.marginModules ?? 4) * moduleSize
  const total = grid.size * moduleSize + margin * 2
  if (canvas.width !== total) canvas.width = total
  if (canvas.height !== total) canvas.height = total
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, total, total)
  ctx.fillStyle = '#000000'
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (grid.get(x, y)) ctx.fillRect(margin + x * moduleSize, margin + y * moduleSize, moduleSize, moduleSize)
    }
  }
}
```

- [ ] **Step 3: 跑通过 + Commit**

```bash
pnpm --filter @totp/ui test -- qrDraw
git add packages/ui/src/qr packages/ui/test/qrDraw.test.ts packages/ui/package.json pnpm-lock.yaml
git commit -m "feat(qr): uqr 矩阵生成与 canvas 绘制（批① §2.4）"
```

### Task 9: 单条二维码 Dialog 与三处入口

**Files:**
- Create: `packages/ui/src/components/OtpQrDialog.vue`
- Modify: `packages/ui/src/components/OtpListItem.vue`（加 `qr` emit + 行内按钮）
- Modify: `packages/ui/src/index.ts`（导出 OtpQrDialog）
- Modify: `apps/extension/entrypoints/popup/App.vue`（行内 @qr + 右键菜单加「显示二维码」+ 挂 Dialog）
- Modify: `packages/ui/src/pages/CodesPage.vue`（同上两处 + 挂 Dialog）
- Test: `packages/ui/test/OtpQrDialog.test.ts`、`packages/ui/test/OtpListItem.test.ts`（补 qr 事件）

**Interfaces:**
- Consumes: `buildOtpUri`、`qrMatrix/drawQrToCanvas`（Task 8）、`MdDialog({open, headline, @close, body/actions slots})`
- Produces:
  - `OtpQrDialog.vue` props `{ open: boolean; entry: OtpEntry | null }`，emit `close`
  - `OtpListItem` 新 emit `qr: []`（点行内二维码图标按钮触发）

- [ ] **Step 1: 写失败测试** `packages/ui/test/OtpQrDialog.test.ts`

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import OtpQrDialog from '../src/components/OtpQrDialog.vue'
import type { OtpEntry } from '@totp/core'

const entry = {
  uuid: 'u1', type: 'totp' as const, issuer: 'GitHub', label: 'alice', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1' as const, digits: 6 as const, period: 30, tagIds: [], order: 0, createdAt: 0,
} satisfies OtpEntry

describe('OtpQrDialog', () => {
  it('open 时渲染 canvas 与固定密钥警示文案', () => {
    const w = mount(OtpQrDialog, { props: { open: true, entry } })
    expect(w.find('canvas').exists()).toBe(true)
    expect(w.text()).toContain('二维码包含完整密钥')
    expect(w.text()).toContain('GitHub')
  })
  it('点击关闭按钮 emit close', async () => {
    const w = mount(OtpQrDialog, { props: { open: true, entry } })
    await w.find('[data-test="qr-close"]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })
})
```

`OtpListItem.test.ts` 追加：触发行内 qr 按钮断言 `emitted('qr')`。

- [ ] **Step 2: 实现 OtpQrDialog.vue**

```vue
<script setup lang="ts">
import { buildOtpUri, type OtpEntry } from '@totp/core'
import { watch, ref } from 'vue'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'
import { drawQrToCanvas, qrMatrix } from '../qr/qrDraw'

const props = defineProps<{ open: boolean; entry: OtpEntry | null }>()
const emit = defineEmits<{ close: [] }>()
const canvasRef = ref<HTMLCanvasElement | null>(null)

watch(
  () => [props.open, props.entry] as const,
  ([open, e]) => {
    if (!open || !e) return
    // canvas 随下一帧可用（MdDialog v-if 挂载）
    void Promise.resolve().then(() => {
      if (canvasRef.value) drawQrToCanvas(canvasRef.value, qrMatrix(buildOtpUri({ type: e.type, issuer: e.issuer, label: e.label, secret: e.secret, algorithm: e.algorithm, digits: e.digits, period: e.period, counter: e.counter })), { moduleSize: 6 })
    })
  },
  { immediate: true },
)
</script>
<template>
  <MdDialog :open="open && entry !== null" :headline="entry ? `${entry.issuer} · ${entry.label}` : ''" @close="emit('close')">
    <div class="qr-wrap">
      <canvas ref="canvasRef" role="img" :aria-label="entry ? `${entry.issuer} ${entry.label} 的 otpauth 二维码` : ''"></canvas>
      <p class="qr-warn">二维码包含完整密钥，请勿截图或分享</p>
    </div>
    <template #actions>
      <MdButton data-test="qr-close" @click="emit('close')">关闭</MdButton>
    </template>
  </MdDialog>
</template>
<style scoped>
.qr-wrap { display: grid; place-items: center; gap: 10px; }
.qr-warn { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
</style>
```

- [ ] **Step 3: OtpListItem 加 qr 按钮**——emits 加 `qr: []`；`right` 区 reveal 按钮后加：

```vue
<MdIconButton class="show-qr" title="显示二维码" aria-label="显示二维码" @click.stop="emit('qr')">▣</MdIconButton>
```

- [ ] **Step 4: 两宿主接线**——popup/App.vue 与 CodesPage.vue：
  1. 各自 `qrEntry = ref<OtpEntry | null>(null)`；`<OtpListItem ... @qr="qrEntry = entry" />`；
  2. 右键菜单数组加一项（popup 约 367 行 `<li>` 列表、CodesPage contextMenu 同款）：`<li><button @click="qrEntry = contextMenu.entry; contextMenu = null">显示二维码</button></li>`；
  3. 模板尾部挂 `<OtpQrDialog :open="qrEntry !== null" :entry="qrEntry" @close="qrEntry = null" />`；`index.ts` 导出组件。

- [ ] **Step 5: 跑通过 + Commit**

```bash
pnpm --filter @totp/ui test -- OtpQr
pnpm --filter @totp/ui test -- OtpListItem
git add packages/ui/src/components packages/ui/src/index.ts packages/ui/test apps/extension/entrypoints/popup/App.vue
git commit -m "feat(qr): 单条目二维码 Dialog（popup/管理页行内+右键入口，固定密钥警示）"
```

### Task 10: 多选拼版大图（仅管理页）

**Files:**
- Create: `packages/ui/src/components/QrSheetDialog.vue`
- Modify: `packages/ui/src/pages/CodesPage.vue`（选择模式 + 底部操作条 + 挂 Dialog）
- Modify: `packages/ui/src/components/backupPlatform.ts` 与两端（可选 `saveImageFile?(name: string, dataUrl: string): Promise<boolean>`；desktop 用 `pickBackupSaveOs`+`writeBackupFileOs`，extension 用 `a[download]`）
- Modify: `apps/extension/entrypoints/options/App.vue`、`apps/desktop/src/App.vue`（传实现）
- Test: `packages/ui/test/qrSheet.test.ts`、`packages/ui/test/pages/CodesPage.select.test.ts`（如 pages 测试目录已有结构，就近放）

**Interfaces:**
- Consumes: Task 8 绘制；`OtpEntry[]`
- Produces:
  - `colsFor(n: number): 2 | 3 | 4`（≤4→2、≤9→3、其余 4）
  - `QrSheetDialog.vue` props `{ open: boolean; entries: OtpEntry[]; saveImage?: (name: string, dataUrl: string) => Promise<boolean> }`，emit `close`
  - CodesPage 新 props `saveImage?`（options 宿主传入；popup 不用多选不传）

- [ ] **Step 1: 写失败测试**

```ts
// qrSheet.test.ts
import { colsFor, renderQrSheet } from '../src/components/qrSheet'
import { describe, expect, it } from 'vitest'

describe('colsFor（spec §2.5 列数自适应）', () => {
  it('≤4→2 列、≤9→3 列、更多→4 列', () => {
    expect(colsFor(1)).toBe(2); expect(colsFor(4)).toBe(2)
    expect(colsFor(5)).toBe(3); expect(colsFor(9)).toBe(3)
    expect(colsFor(10)).toBe(4); expect(colsFor(60)).toBe(4)
  })
})
```

选择模式测试（@vue/test-utils 挂 CodesPage，注入最小 store：`createVueStore(memAdapter())` + 预置 2 条 entry；进入选择模式→勾选 1 条→断言操作条文案「生成二维码(1)」出现）。

- [ ] **Step 2: 实现 `qrSheet.ts`（纯逻辑，可测）与 `QrSheetDialog.vue`**

```ts
// packages/ui/src/components/qrSheet.ts
import { buildOtpUri, type OtpEntry } from '@totp/core'
import { drawQrToCanvas, qrMatrix } from '../qr/qrDraw'

export function colsFor(n: number): 2 | 3 | 4 {
  return n <= 4 ? 2 : n <= 9 ? 3 : 4
}

export interface QrSheetLayout { cols: 2 | 3 | 4; cellPx: number; width: number; height: number }

/** 每格 = QR(module 5px + margin 3) + 两行文字（issuer/label，黑字白底） */
export function renderQrSheet(canvas: HTMLCanvasElement, entries: OtpEntry[]): QrSheetLayout {
  const cols = colsFor(entries.length)
  const rows = Math.ceil(entries.length / cols)
  const cellPx = 260
  const width = cols * cellPx
  const height = rows * cellPx
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  entries.forEach((e, i) => {
    const cx = (i % cols) * cellPx
    const cy = Math.floor(i / cols) * cellPx
    const grid = qrMatrix(buildOtpUri({ type: e.type, issuer: e.issuer, label: e.label, secret: e.secret, algorithm: e.algorithm, digits: e.digits, period: e.period, counter: e.counter }))
    const moduleSize = Math.max(2, Math.floor((cellPx - 80) / (grid.size + 8)))
    const sub = document.createElement('canvas')
    drawQrToCanvas(sub, grid, { moduleSize, marginModules: 4 })
    ctx.drawImage(sub, cx + Math.floor((cellPx - sub.width) / 2), cy + 16)
    ctx.fillStyle = '#000000'
    ctx.font = '16px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(e.issuer, cx + cellPx / 2, cy + cellPx - 46)
    ctx.font = '13px sans-serif'
    ctx.fillText(e.label, cx + cellPx / 2, cy + cellPx - 24)
    ctx.fillStyle = '#ffffff'
  })
  return { cols, cellPx, width, height }
}
```

`QrSheetDialog.vue`：MdDialog（headline「扫码迁移（N 个条目）」）内 `<canvas>`（open 时 `renderQrSheet`）+ 警示文案（同 Task 9）+ actions：`保存图片`（`data-test="sheet-save"`：`canvas.toDataURL('image/png')` → `props.saveImage?.('totp-qr-sheet.png', dataUrl)`；未传 saveImage 时隐藏）与 `关闭`。

CodesPage 接线：`selecting = ref(false)`、`selected = ref<Set<string>>(new Set())`；工具栏加「选择」按钮（`data-test="select-mode"`）；selecting 时每行前渲染 MdCheckbox（`:model-value="selected.has(entry.uuid)"`）；底部浮动操作条（`v-if="selected.size > 0"`）：`生成二维码({{ selected.size }})` → `sheetEntries = computed(entries 中选中的)` 打开 Dialog；「取消」清空并退出。options 宿主传 `saveImage`（extension：dataUrl→a[download]；desktop：`pickBackupSaveOs` + dataUrl 解码 bytes → `writeBackupFileOs`）。popup 不接多选（不传 saveImage、不渲染选择按钮——由 CodesPage 仅在 options 使用，popup 列表独立实现，不受影响）。

- [ ] **Step 3: 跑通过 + Commit**

```bash
pnpm --filter @totp/ui test -- qrSheet
pnpm --filter @totp/ui test -- CodesPage
git add packages/ui apps/extension/entrypoints/options/App.vue apps/desktop/src/App.vue
git commit -m "feat(qr): 管理页多选拼版大图（列数自适应，展示即所得+保存下载，批① §2.5）"
```
---

## Part 2：批② QR 与智能录入（C0→C4 递进）

### Task 11: jsQR 解码核心（纯像素函数）

**Files:**
- Modify: `packages/ui/package.json`（`pnpm --filter @totp/ui add jsqr`）
- Create: `packages/ui/src/qr/decodeQr.ts`
- Test: `packages/ui/test/decodeQr.test.ts`

**Interfaces:**
- Consumes: `qrMatrix`（Task 8，测试侧用于生成往返样本）
- Produces:
  - `interface ImagePixels { data: Uint8ClampedArray; width: number; height: number }`
  - `decodeQrPixels(p: ImagePixels): string | null`（成功返回码文本，失败 null）
  - `decodeQrToUri(p: ImagePixels): { uri: string } | { error: string }`（码文本必须通过 `parseOtpUri`，错误为中文消息）

- [ ] **Step 1: 写失败测试**（往返：uqr 生成矩阵 → 手绘 RGBA 像素（黑=0,0,0,255 / 白=255,255,255,255 + 4 模块白边）→ jsQR 解回）

```ts
import { decodeQrPixels, type ImagePixels } from '../src/qr/decodeQr'
import { qrMatrix } from '../src/qr/qrDraw'
import { describe, expect, it } from 'vitest'

function gridToPixels(text: string, margin = 4): ImagePixels {
  const g = qrMatrix(text)
  const w = g.size + margin * 2
  const data = new Uint8ClampedArray(w * w * 4).fill(255)
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.get(x, y)) continue
      const i = ((y + margin) * w + (x + margin)) * 4
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255
    }
  }
  return { data, width: w, height: w }
}

describe('decodeQrPixels', () => {
  it('round-trip：otpauth URI 生成→解码恒等', () => {
    const uri = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
    expect(decodeQrPixels(gridToPixels(uri))).toBe(uri)
  })
  it('非二维码像素返回 null', () => {
    const blank = new Uint8ClampedArray(100 * 100 * 4).fill(255)
    expect(decodeQrPixels({ data: blank, width: 100, height: 100 })).toBeNull()
  })
  it('decodeQrToUri：非法码文本给中文错误', () => {
    const r = decodeQrToUri({ data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 })
    expect(r).toHaveProperty('error')
  })
})
```

- [ ] **Step 2: 实现**

```ts
import jsQR from 'jsqr'
import { parseOtpUri } from '@totp/core'

export interface ImagePixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

export function decodeQrPixels(p: ImagePixels): string | null {
  const r = jsQR(p.data, p.width, p.height)
  return r?.data ?? null
}

export function decodeQrToUri(p: ImagePixels): { uri: string } | { error: string } {
  const text = decodeQrPixels(p)
  if (text === null) return { error: '未识别到二维码' }
  try {
    parseOtpUri(text) // 通过性校验；popup 预填通道会再解析一次，成本可忽略
    return { uri: text }
  } catch {
    return { error: '二维码内容不是有效的 otpauth 链接' }
  }
}
```

（`decodeQrToUri` 内 `parseOtpUri(text)` 仅作校验：通过则原文返回——popup 预填通道再解析一次成本可忽略。）

- [ ] **Step 3: 跑通过 + Commit**

```bash
pnpm --filter @totp/ui test -- decodeQr
git add packages/ui/src/qr packages/ui/test/decodeQr.test.ts packages/ui/package.json pnpm-lock.yaml
git commit -m "feat(qr): jsQR 像素级解码核心（uqr 往返测试，批② C1）"
```

### Task 12: 图片源层（Blob/剪贴板 → ImagePixels）

**Files:**
- Create: `packages/ui/src/qr/imageSource.ts`
- Test: `packages/ui/test/imageSource.test.ts`

**Interfaces:**
- Produces:
  - `blobToPixels(blob: Blob): Promise<ImagePixels>`（`createImageBitmap` + OffscreenCanvas，回退 `<canvas>`）
  - `imagesFromClipboard(e: ClipboardEvent): File[]`（`clipboardData.items` 中 `kind==='file'` 且 `type.startsWith('image/')`）

- [ ] **Step 1: 写可测部分的单测**（jsdom 无 createImageBitmap/getImageData——`blobToPixels` 属浏览器集成层，由 Task 17 真机冒烟与组件测试 mock 覆盖；此处测 `imagesFromClipboard`）

```ts
import { imagesFromClipboard } from '../src/qr/imageSource'
import { describe, expect, it } from 'vitest'

function clipboardEventWith(items: Array<{ kind: string; type: string; file?: File }>): ClipboardEvent {
  const dt = { items: items.map((it) => ({ kind: it.kind, type: it.type, getAsFile: () => it.file ?? null })) }
  return { clipboardData: dt } as unknown as ClipboardEvent
}

describe('imagesFromClipboard', () => {
  it('只收集图片文件，忽略文本项', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' })
    const e = clipboardEventWith([
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', file: png },
      { kind: 'file', type: 'application/pdf' },
    ])
    expect(imagesFromClipboard(e)).toEqual([png])
  })
  it('无剪贴板数据返回空数组', () => {
    expect(imagesFromClipboard({} as ClipboardEvent)).toEqual([])
  })
})
```

- [ ] **Step 2: 实现**

```ts
import type { ImagePixels } from './decodeQr'

export function imagesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items
  if (!items) return []
  const out: File[] = []
  for (const it of Array.from(items)) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

/** 解码位图取像素：OffscreenCanvas 优先，无则回退 DOM canvas（popup/options 均有 DOM） */
export async function blobToPixels(blob: Blob): Promise<ImagePixels> {
  const bmp = await createImageBitmap(blob)
  try {
    const w = bmp.width
    const h = bmp.height
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })
    const ctx = (canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D
    ctx.drawImage(bmp as unknown as CanvasImageSource, 0, 0)
    return ctx.getImageData(0, 0, w, h)
  } finally {
    bmp.close()
  }
}
```

- [ ] **Step 3: 跑通过 + Commit**

```bash
pnpm --filter @totp/ui test -- imageSource
git add packages/ui/src/qr/imageSource.ts packages/ui/test/imageSource.test.ts
git commit -m "feat(qr): 剪贴板/文件图片源层（批② C1）"
```

### Task 13: core — 粘贴文本解析分发

**Files:**
- Create: `packages/core/src/import/paste.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/importPaste.test.ts`

**Interfaces:**
- Consumes: `sniffFormat(text): ImportFormat | null`（`import/sniff.ts:60`）、各文本类 parser（`importUriBatch`/`importAegisPlaintext`/`importAndOtp`/`importTwoFas`/`importBitwarden`/`importProton`/`importStratum`/`importFreeOtp`/`importFreeOtpLegacy`/`importTotpAuthenticator`）
- Produces: `parsePastedText(text: string): ImportResult | { unsupported: string }`
  - 命中白名单 → 对应 parser 结果
  - `aegis` 命中且为加密文件（`sniffAegis(text).encrypted === true`）→ `{ unsupported: '加密 Aegis 文件请走导入页（需输入口令）' }`
  - `generic`/`winauth` → `{ unsupported: '该格式需要在导入页配置解析（通用 JSON 映射 / WinAuth 文件）' }`
  - `null` → `{ unsupported: '无法识别粘贴内容格式' }`

- [ ] **Step 1: 写失败测试**

```ts
import { parsePastedText } from '@totp/core'
import { describe, expect, it } from 'vitest'

describe('parsePastedText', () => {
  it('多行 otpauth URI 走 uriBatch', () => {
    const r = parsePastedText('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP\notpauth://totp/G:b?secret=JBSWY3DPEHPK3PXP')
    expect('unsupported' in r).toBe(false)
    if (!('unsupported' in r)) expect(r.entries).toHaveLength(2)
  })
  it('Aegis 明文 JSON 走 aegis 解析', () => {
    const json = JSON.stringify({ version: 1, header: { slots: [], params: {} }, db: { entries: [{ type: 'totp', uuid: 'u', name: 'G:a', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30 } }], groups: [] } })
    const r = parsePastedText(json)
    if (!('unsupported' in r)) expect(r.entries).toHaveLength(1)
    else expect.unreachable()
  })
  it('通用 JSON 提示走导入页', () => {
    const r = parsePastedText('{"foo": 1}')
    expect(r).toEqual({ unsupported: expect.stringContaining('导入页') })
  })
  it('乱文本无法识别', () => {
    expect(parsePastedText('hello world')).toHaveProperty('unsupported')
  })
})
```

- [ ] **Step 2: 实现** `packages/core/src/import/paste.ts`

```ts
import { sniffAegis, sniffFormat } from './sniff'
import { importAegisPlaintext } from './aegis'
import { importAndOtp, importFreeOtp, importFreeOtpLegacy, importTotpAuthenticator } from './miscApps'
import { importBitwarden, importProton, importStratum, importTwoFas } from './jsonApps'
import { importUriBatch } from './uriBatch'
import type { ImportFormat, ImportResult } from './types'

// 粘贴场景白名单（spec 批② C0）：文本可直接解析的格式。generic 需交互映射、winauth 为文件惯例、
// aegis 加密需口令页——三者引导走导入页，不在此强解。
const DISPATCH: Partial<Record<ImportFormat, (text: string) => ImportResult>> = {
  uriBatch: importUriBatch,
  aegis: importAegisPlaintext,
  andOtp: importAndOtp,
  twoFas: importTwoFas,
  bitwarden: importBitwarden,
  proton: importProton,
  stratum: importStratum,
  freeOtp: importFreeOtp,
  freeOtpLegacy: importFreeOtpLegacy,
  totpAuthenticator: (t) => importTotpAuthenticator(t),
}

export type PasteParseResult = ImportResult | { unsupported: string }

export function parsePastedText(text: string): PasteParseResult {
  const fmt = sniffFormat(text)
  if (fmt === null) return { unsupported: '无法识别粘贴内容格式' }
  if (fmt === 'aegis' && sniffAegis(text)?.encrypted === true) {
    return { unsupported: '加密 Aegis 文件请走导入页（需输入口令）' }
  }
  if (fmt === 'generic') return { unsupported: '通用 JSON 请走导入页配置字段映射' }
  if (fmt === 'winauth') return { unsupported: 'WinAuth 请在导入页选择文件导入' }
  const parse = DISPATCH[fmt]
  if (!parse) return { unsupported: '无法识别粘贴内容格式' }
  return parse(text)
}
```

`index.ts` 追加 `export * from './import/paste'`。

- [ ] **Step 3: 跑通过 + Commit**

```bash
pnpm --filter @totp/core test -- importPaste
git add packages/core/src/import/paste.ts packages/core/src/index.ts packages/core/test/importPaste.test.ts
git commit -m "feat(core): 粘贴文本格式嗅探分发（批② C0，白名单 + 引导文案）"
```

### Task 14: EntryFormDialog 双 Tab 与智能粘贴落库

**Files:**
- Create: `packages/ui/src/components/BatchPastePanel.vue`（智能粘贴 Tab 内容）
- Modify: `packages/ui/src/components/EntryFormDialog.vue`（MdTabs/MdSegmentedButton 双 Tab）
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/BatchPastePanel.test.ts`、`packages/ui/test/EntryFormDialog.test.ts`（补 Tab 流转）

**Interfaces:**
- Consumes: `parsePastedText`（Task 13）、`planImport(existing, incoming): ImportPlan`（`import/dedup.ts:57`）、`applyImport(v, entries, policy, conflictIdx): Vault`（`import/conflict.ts:76`）、`newEntryFromParsed`、store `commit`
- Produces:
  - `BatchPastePanel.vue` props `{ store: VueStore }`，emit `added: [count: number]`（宿主关闭弹窗并刷新）
  - 行内决策模型：`RowDecision = { index: number; kind: 'identical'|'suspect'|'conflict'|'new'; choice: 'skip'|'add'|'replace'|'merge' }`（默认 skip；`new` 行不可选恒加）

- [ ] **Step 1: 写失败测试** `packages/ui/test/BatchPastePanel.test.ts`

```ts
import { mount } from '@vue/test-utils'
import { createVueStore } from '../src/store'
import BatchPastePanel from '../src/components/BatchPastePanel.vue'
import { describe, expect, it, vi } from 'vitest'
import type { StorageAdapter } from '@totp/core'

const memAdapter = (): StorageAdapter => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) }
}

const URI_A = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
const URI_B = 'otpauth://totp/GitLab:bob?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitLab'

describe('BatchPastePanel', () => {
  it('粘贴两条 URI：显示 2 行解析结果且可添加', async () => {
    const store = createVueStore(memAdapter())
    const w = mount(BatchPastePanel, { props: { store } })
    await w.find('textarea').setValue(`${URI_A}\n${URI_B}`)
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(2)
    await w.find('[data-test="paste-commit"]').trigger('click')
    expect(store.vault.entries).toHaveLength(2)
    expect(w.emitted('added')?.[0]).toEqual([2])
  })
  it('重复粘贴同一条：identical 行默认跳过，第二次添加不产生重复', async () => {
    const store = createVueStore(memAdapter())
    const w = mount(BatchPastePanel, { props: { store } })
    await w.find('textarea').setValue(URI_A)
    await w.find('[data-test="paste-parse"]').trigger('click')
    await w.find('[data-test="paste-commit"]').trigger('click')
    await w.find('textarea').setValue(URI_A)
    await w.find('[data-test="paste-parse"]').trigger('click')
    await w.find('[data-test="paste-commit"]').trigger('click')
    expect(store.vault.entries).toHaveLength(1)
  })
  it('失败行显示原因且不阻塞其他行', async () => {
    const store = createVueStore(memAdapter())
    const w = mount(BatchPastePanel, { props: { store } })
    await w.find('textarea').setValue(`${URI_A}\nnot-a-uri`)
    await w.find('[data-test="paste-parse"]').trigger('click')
    await w.find('[data-test="paste-commit"]').trigger('click')
    expect(store.vault.entries).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 实现 BatchPastePanel.vue**

```vue
<script setup lang="ts">
import { applyImport, newEntryFromParsed, planImport, parsePastedText, type ParsedEntry, type Vault } from '@totp/core'
import { computed, ref } from 'vue'
import type { VueStore } from '../store'
import MdButton from './md/MdButton.vue'
import MdSelect from './md/MdSelect.vue'
import MdTextField from './md/MdTextField.vue'

const props = defineProps<{ store: VueStore }>()
const emit = defineEmits<{ added: [count: number] }>()

const text = ref('')
const error = ref('')
const rows = ref<Array<{ entry: ParsedEntry; kind: 'identical' | 'suspect' | 'conflict' | 'new'; choice: 'skip' | 'add' | 'replace' | 'merge' }>>([])
const failureLines = ref<string[]>([])

function parse(): void {
  error.value = ''
  failureLines.value = []
  rows.value = []
  const r = parsePastedText(text.value)
  if ('unsupported' in r) { error.value = r.unsupported; return }
  if (r.entries.length === 0 && r.failures.length > 0) { error.value = `没有可导入的条目（${r.failures.length} 行无法解析）`; return }
  // planImport 返回 { kinds: ImportKind[], targetUuids, counts }（import/dedup.ts:48）——按下标对齐逐条标注
  const plan = planImport(props.store.vault, r.entries)
  rows.value = r.entries.map((entry, i) => {
    const kind = plan.kinds[i] ?? 'new'
    return { entry, kind, choice: kind === 'new' ? ('add' as const) : ('skip' as const) }
  })
  failureLines.value = r.failures.map((f) => `第 ${f.index + 1} 行：${f.message}`)
}

async function commit(): Promise<void> {
  const active = rows.value.filter((r) => r.choice !== 'skip' && r.kind !== 'identical')
  if (active.length === 0) { emit('added', 0); return }
  await props.store.commit((v) => applyByChoices(v, active))
  emit('added', active.length)
}

/** 逐条决策 → 三批次串联 applyImport（add=强制新增；replace/merge=冲突集 + 对应策略，批② C0 裁定） */
function applyByChoices(v: Vault, active: Array<{ entry: ParsedEntry; kind: string; choice: string }>): Vault {
  const asNew = active.filter((r) => r.choice === 'add').map((r) => r.entry)
  const asReplace = active.filter((r) => r.choice === 'replace').map((r) => r.entry)
  const asMerge = active.filter((r) => r.choice === 'merge').map((r) => r.entry)
  let next = v
  next = applyImport(next, asNew, 'skip', new Set<number>())
  next = applyImport(next, asReplace, 'replace', new Set(asReplace.map((_, i) => i)))
  next = applyImport(next, asMerge, 'merge', new Set(asMerge.map((_, i) => i)))
  return next
}
const activeCount = computed(() => rows.value.filter((r) => r.choice !== 'skip' && r.kind !== 'identical').length)
function kindLabel(k: 'identical' | 'suspect' | 'conflict' | 'new'): string {
  return k === 'identical' ? '已存在' : k === 'suspect' ? '疑似重复' : k === 'conflict' ? '冲突' : '新条目'
}
</script>
<template>
  <div class="batch-paste">
    <textarea v-model="text" rows="6" aria-label="粘贴文本"
      placeholder="粘贴 otpauth URI（可多行）或各应用明文导出 JSON；也可直接粘贴/拖入二维码图片"></textarea>
    <MdButton data-test="paste-parse" :disabled="text.trim() === ''" @click="parse">解析</MdButton>
    <p v-if="error" class="err">{{ error }}</p>
    <p v-for="f in failureLines" :key="f" class="err">{{ f }}</p>
    <ul v-if="rows.length > 0" class="rows">
      <li v-for="(r, i) in rows" :key="i" data-test="paste-row">
        <span class="meta">{{ r.entry.issuer }} · {{ r.entry.label }}</span>
        <span class="kind" :class="r.kind">{{ kindLabel(r.kind) }}</span>
        <MdSelect v-if="r.kind !== 'new' && r.kind !== 'identical'" :model-value="r.choice"
          :aria-label="`处理方式 ${r.entry.issuer}`" @update:model-value="r.choice = $event as typeof r.choice">
          <option value="skip">跳过</option>
          <option value="add">仍然添加</option>
          <option v-if="r.kind === 'conflict'" value="replace">覆盖现有</option>
          <option v-if="r.kind === 'conflict'" value="merge">并存并集</option>
        </MdSelect>
      </li>
    </ul>
    <MdButton data-test="paste-commit" variant="filled" :disabled="rows.length === 0" @click="commit">
      添加（{{ activeCount }}）
    </MdButton>
  </div>
</template>
```

（`activeCount`/`kindLabel` 已在上方 script 定义；`planImport` 返回结构 `{ kinds, targetUuids, counts }` 见 `import/dedup.ts:48`，测试断言落在 `store.vault.entries` 长度与 `added` 事件，不耦合内部字段。）

- [ ] **Step 3: EntryFormDialog 双 Tab**——`EntryFormDialog.vue` 顶部加 `MdSegmentedButton`（或项目现有 MdTabs，取 NavigationShell 同款）两选项「手动填写 / 智能粘贴」；`manual` ref 缺省 true；手动 Tab 渲染现有 `<EntryForm>`，粘贴 Tab 渲染 `<BatchPastePanel :store="store" @added="count => emit('batch-added', count)" />`；Dialog props 加 `store: VueStore`（CodesPage/popup 宿主已持 store，传入）；emits 加 `batch-added: [count]`（宿主收到后关弹窗）。

- [ ] **Step 4: 跑通过 + Commit**

```bash
pnpm --filter @totp/ui test -- BatchPaste
pnpm --filter @totp/ui test -- EntryFormDialog
git add packages/ui/src/components packages/ui/src/index.ts packages/ui/test apps/extension/entrypoints/popup/App.vue packages/ui/src/pages/CodesPage.vue
git commit -m "feat(entry): 新增弹窗双 Tab——智能粘贴批量解析落库（批② C0）"
```

### Task 15: 手动 Tab「从图片识别」单图预填

**Files:**
- Modify: `packages/ui/src/components/EntryForm.vue`（secret 区旁加「从图片识别」按钮 + 隐藏 file input）
- Test: `packages/ui/test/EntryForm.qr.test.ts`

**Interfaces:**
- Consumes: `blobToPixels`（Task 12）、`decodeQrToUri`（Task 11）、`parseUriToEntryData`（`packages/ui/src/otpauthFlow.ts`——已存在的预填转换器）
- Produces: EntryForm 内部行为（识别成功后回填 form 各字段，等同粘贴 URI 预填；失败在表单 error 区显示中文原因）

- [ ] **Step 1: 写失败测试**（mock `blobToPixels` 返回可解码像素——用 `vi.mock('../src/qr/imageSource')` + `vi.mock('../src/qr/decodeQr')` 让 `decodeQrToUri` 返回固定 uri/error 两个分支）

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

const uri = 'otpauth://totp/Gen:pix?secret=JBSWY3DPEHPK3PXP&issuer=Gen'
vi.mock('../src/qr/decodeQr', () => ({ decodeQrToUri: vi.fn(() => ({ uri })) }))
vi.mock('../src/qr/imageSource', () => ({ blobToPixels: vi.fn(async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })) }))

import EntryForm from '../src/components/EntryForm.vue'

describe('EntryForm 从图片识别', () => {
  it('识别成功回填 issuer/label/secret', async () => {
    const w = mount(EntryForm)
    const input = w.find<HTMLInputElement>('input[type="file"][data-test="qr-file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'q.png', { type: 'image/png' })] })
    await input.trigger('change')
    await vi.waitFor(() => {
      const issuer = w.find('[aria-label="服务名"] input, [aria-label="服务名"]').element as HTMLInputElement
      expect(issuer.value).toBe('Gen')
    })
  })
  it('识别失败显示中文原因', async () => {
    const { decodeQrToUri } = await import('../src/qr/decodeQr')
    vi.mocked(decodeQrToUri).mockReturnValueOnce({ error: '未识别到二维码' })
    const w = mount(EntryForm)
    const input = w.find<HTMLInputElement>('input[type="file"][data-test="qr-file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'q.png', { type: 'image/png' })] })
    await input.trigger('change')
    await vi.waitFor(() => expect(w.text()).toContain('未识别到二维码'))
  })
})
```

- [ ] **Step 2: 实现**——EntryForm 模板 secret-row 旁：

```vue
<MdButton variant="text" data-test="qr-pick" @click="qrFile?.click()">从图片识别</MdButton>
<input ref="qrFile" type="file" accept="image/*" data-test="qr-file" class="visually-hidden" @change="onQrFile" />
```

```ts
import { blobToPixels } from '../qr/imageSource'
import { decodeQrToUri } from '../qr/decodeQr'
import { parseUriToEntryData } from '../otpauthFlow'

async function onQrFile(ev: Event): Promise<void> {
  const file = (ev.target as HTMLInputElement).files?.[0]
  ;(ev.target as HTMLInputElement).value = '' // 允许重复选同一文件
  if (!file) return
  try {
    const pixels = await blobToPixels(file)
    const r = decodeQrToUri(pixels)
    if ('error' in r) { error.value = r.error; return }
    const d = parseUriToEntryData(r.uri)
    if ('error' in d) { error.value = d.error; return }
    // 预填（保留用户已填的 note/tagIds/icon，覆盖 OTP 字段）
    form.type = d.data.type; form.issuer = d.data.issuer; form.label = d.data.label
    form.secret = d.data.secret; form.algorithm = d.data.algorithm; form.digits = d.data.digits
    form.period = d.data.period; if (d.data.counter !== undefined) form.counter = d.data.counter
    if (d.data.pin !== undefined) form.pin = d.data.pin
  } catch (e) {
    error.value = e instanceof Error ? e.message : '图片读取失败'
  }
}
```

- [ ] **Step 3: 跑通过 + Commit**

```bash
pnpm --filter @totp/ui test -- EntryForm.qr
git add packages/ui/src/components/EntryForm.vue packages/ui/test/EntryForm.qr.test.ts
git commit -m "feat(entry): 表单从图片识别二维码预填（批② C2）"
```

### Task 16: 智能粘贴 Tab 批量图片

**Files:**
- Modify: `packages/ui/src/components/BatchPastePanel.vue`（textarea 区域加 paste/drop 监听 + 图片解析列）
- Test: `packages/ui/test/BatchPastePanel.images.test.ts`

**Interfaces:**
- Consumes: `imagesFromClipboard`/`blobToPixels`（Task 12）、`decodeQrToUri`（Task 11）、`parseUriToEntryData`
- Produces: 面板新增图片行模型 `imageRows: Array<{ name: string; result: { uri: string } | { error: string } }>`；解析结果与文本行合并展示

- [ ] **Step 1: 写失败测试**（同 Task 15 mock 手法；断言：2 张图 1 成 1 败时，结果区 1 行可添加 + 1 行失败提示；成功图与文本结果合并计数）

```ts
// 要点（完整文件仿 Task 14 测试骨架）：
// - vi.mock blobToPixels 返回固定像素；decodeQrToUri 按调用序返回成功/失败
// - 触发：wrapper.find('[data-test="paste-zone"]').trigger('paste', { clipboardData: { items: [fileItem] } })
// - 断言 rows 中出现解码出的条目行 + errorRows 提示
```

- [ ] **Step 2: 实现**——BatchPastePanel 的粘贴区（textarea 外层容器 `data-test="paste-zone"`）加：

```ts
const imageErrors = ref<string[]>([])
const pendingImages = ref(0)

async function onPasteImages(e: ClipboardEvent): Promise<void> {
  const files = imagesFromClipboard(e)
  if (files.length > 0) { e.preventDefault(); await decodeImages(files) }
}
async function onDropImages(e: DragEvent): Promise<void> {
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'))
  if (files.length > 0) { e.preventDefault(); await decodeImages(files) }
}
async function decodeImages(files: File[]): Promise<void> {
  pendingImages.value += files.length
  try {
    for (const f of files) {
      try {
        const r = decodeQrToUri(await blobToPixels(f))
        if ('error' in r) { imageErrors.value.push(`${f.name}：${r.error}`); continue }
        const d = parseUriToEntryData(r.uri)
        if ('error' in d) { imageErrors.value.push(`${f.name}：${d.error}`); continue }
        const parsed = toParsed(d.data)
        const plan = planImport(props.store.vault, [parsed])
        rows.value.push({ entry: parsed, kind: plan.kinds[0] ?? 'new', choice: plan.kinds[0] === 'new' ? 'add' : 'skip' })
      } catch {
        imageErrors.value.push(`${f.name}：图片读取失败`)
      }
    }
  } finally {
    pendingImages.value -= files.length
  }
}
```

（`toParsed(d.data)`：`OtpEntry` 哑值 → `ParsedEntry` 的字段投影 helper，本组件内 8 行实现。模板：容器 `@paste="onPasteImages"` `@dragover.prevent` `@drop="onDropImages"`，`pendingImages > 0` 时显示「解码中…」，`imageErrors` 逐行展示。）

- [ ] **Step 3: 跑通过 + Commit**

```bash
pnpm --filter @totp/ui test -- BatchPastePanel
git add packages/ui/src/components/BatchPastePanel.vue packages/ui/test/BatchPastePanel.images.test.ts
git commit -m "feat(entry): 智能粘贴支持批量图片解码（paste/drop 多图，批② C3）"
```

### Task 17: 网页右键图片识别（C4，零新增权限）

**Files:**
- Create: `apps/extension/src/qrDecode.ts`（SW 可用的纯函数层，便于单测）
- Modify: `apps/extension/entrypoints/background.ts`（image 右键菜单 + 解码 + 通知 + pendingOtpauth 通道）
- Test: `apps/extension/test/qrDecode.test.ts`

**Interfaces:**
- Consumes: `blobToPixels`/`decodeQrToUri`（`@totp/ui`，jsQR 纯 JS 可入 SW）、`PENDING_OTPAUTH_KEY`（`apps/extension/src/pendingOtpauth.ts`）、`parseOtpUri`
- Produces:
  - `decodeImageBytesToUri(bytes: Uint8Array): Promise<string | null>`（Blob→pixels→decode→parseOtpUri 校验，失败 null）
  - background 菜单项 id `qr-decode-image`（`contexts: ['image']`）

- [ ] **Step 1: 写失败测试**（mock 层：`decodeImageBytesToUri` 的 otpauth 校验分支——用非法字节确认 null 路径不抛；成功路径在真机冒烟覆盖）

```ts
import { decodeImageBytesToUri } from '../src/qrDecode'
import { describe, expect, it } from 'vitest'

describe('decodeImageBytesToUri', () => {
  it('非图片字节返回 null 而非抛错', async () => {
    await expect(decodeImageBytesToUri(new Uint8Array([1, 2, 3]))).resolves.toBeNull()
  })
})
```

- [ ] **Step 2: 实现 `apps/extension/src/qrDecode.ts`**

```ts
import { blobToPixels, decodeQrToUri } from '@totp/ui'
import { parseOtpUri } from '@totp/core'

/** 图片字节 → otpauth URI（无法解码/非 otpauth 内容均返回 null，调用方统一提示） */
export async function decodeImageBytesToUri(bytes: Uint8Array): Promise<string | null> {
  let uri: string
  try {
    const r = decodeQrToUri(await blobToPixels(new Blob([bytes as BlobPart])))
    if ('error' in r) return null
    uri = r.uri
  } catch {
    return null
  }
  try {
    parseOtpUri(uri)
    return uri
  } catch {
    return null
  }
}
```

- [ ] **Step 3: background 接线**（`entrypoints/background.ts`，复用现有菜单幂等注册/通知/pendingOtpauth 三件套）

```ts
const QR_IMAGE_MENU_ID = 'qr-decode-image'
// 菜单注册（与 OTPAUTH_MENU_ID 并列）：
chrome.contextMenus.create({ id: QR_IMAGE_MENU_ID, title: '识别图中的验证码二维码', contexts: ['image'] }, () => void chrome.runtime.lastError)
// onClicked 分支（现有 listener 内追加）：
if (info.menuItemId === QR_IMAGE_MENU_ID) {
  const src = info.srcUrl ?? ''
  let uri: string | null = null
  try {
    const res = await fetch(src) // activeTab 已随右键点击授予该 tab 源权限（spec §3 C4）
    uri = await decodeImageBytesToUri(new Uint8Array(await res.arrayBuffer()))
  } catch { uri = null }
  if (uri === null) {
    void chrome.notifications.create({ type: 'basic', iconUrl: '/icon/128.png', title: 'TOTP 验证码工具', message: '图中未识别到有效的 otpauth 二维码' })
    return
  }
  await chrome.storage.local.set({ [PENDING_OTPAUTH_KEY]: uri })
  void chrome.notifications.create({ type: 'basic', iconUrl: '/icon/128.png', title: 'TOTP 验证码工具', message: '已识别验证码二维码，点扩展图标查看并保存' })
  return
}
```

（onClicked listener 需改 async；`info.srcUrl` 类型为 `string | undefined`。）

- [ ] **Step 4: 真机验证步骤（不可跳过，spec §9 风险项）**

```bash
pnpm --filter @totp/extension... build   # 或 apps/extension 的 build script，产物 .output/chrome-mv3
```

1. `chrome://extensions` 加载 `.output/chrome-mv3`；
2. 打开任意含 otpauth 二维码图片的页面（可用本项目 QR Dialog 的 canvas 右键另存为样本）；
3. 右键该图 →「识别图中的验证码二维码」→ 期望系统通知 + popup 打开后表单预填；
4. **降级判定**：若第 3 步 fetch 被 CORS/权限拒绝（DevTools SW 控制台出现 TypeError: Failed to fetch）——按 spec §9 执行降级：菜单保留但改为打开 options 导入页并提示「请保存图片后在弹窗中粘贴识别」，同时在任务汇报中明示「activeTab grant 假设未验证通过」，**不得**擅自追加 `scripting`/host 权限。

- [ ] **Step 5: 跑测试 + Commit**

```bash
pnpm --filter @totp/extension test -- qrDecode   # 包名以 apps/extension/package.json name 为准
git add apps/extension/src/qrDecode.ts apps/extension/entrypoints/background.ts apps/extension/test/qrDecode.test.ts
git commit -m "feat(ext): 网页图片右键识别 otpauth 二维码（activeTab 零新权限，批② C4）"
```

---

## Part 3：批③ Yandex 算法 + Authenticator Plus 导入

### Task 18: Yandex（yaotp）算法与全链路类型扩展

**Files:**
- Create: `packages/core/src/otp/yandex.ts`
- Create: `scripts/gen-yaotp-vectors.mjs`（黄金向量生成器，一次性工具，提交留档）
- Modify: `packages/core/src/model.ts`（`EntryType` 加 `'yandex'`；`OtpEntry` 加 `pin?: string`）
- Modify: `packages/core/src/otp/uri.ts`（host `yaotp` → type `yandex`；query `pin`；默认 digits=8、algorithm=SHA256）
- Modify: `packages/core/src/import/normalize.ts`（`normalizeType`/`toOtpDigits` 认识 yandex）
- Modify: `packages/core/src/import/types.ts`（`ParsedEntry.type` 加 `'yandex'`、加 `pin?: string`）
- Modify: `packages/core/src/import/aegis.ts`（`parseEntry` 读 `info.pin`）
- Modify: `packages/core/src/storage/vaultStore.ts`（`validateEntryShape`：type 白名单加 yandex；`o.type === 'yandex'` 时 digits 须为 8、`pin` 可选字符串）
- Modify: `packages/core/src/index.ts`
- Modify: `packages/ui/src/components/entryForm.ts`（`EntryFormData.type` 加 `'yandex'`）
- Modify: `packages/ui/src/components/EntryForm.vue`（TYPE_OPTIONS 加 Yandex；type watch 联动 digits=8）
- Modify: `packages/ui/src/composables/useOtpCodes.ts`（分支调用 `yandexCode`）
- Test: `packages/core/test/yandex.test.ts`、`packages/core/test/yaotpUri.test.ts`、`packages/ui/test/useOtpCodes.yandex.test.ts`

**Interfaces:**
- Consumes: `base32Decode`（`encoding/base32.ts`）、WebCrypto HMAC-SHA256
- Produces:
  - `yandexCode(secretB32: string, pin: string, timeMs: number, period?: number, digits?: number): Promise<string>`
  - `yandexValidateSecret(secretBytes: Uint8Array): void`（26 字节校验和，16 字节直通）
  - URI：`otpauth://yaotp/<Issuer:label>?secret=..&pin=..`（type=`yandex`，digits 默认 8、algorithm 默认 SHA256）

**权威算法（Aegis `YandexInfo.java` + `crypto/otp/YAOTP.java`，移植不得改动参数）：**

1. `keyHash = SHA-256(UTF8(pin) || secretBytes)`；若 `keyHash[0] === 0` 则去掉首字节
2. `msg = counter 的 8 字节大端`（`counter = floor(timeMs/1000/period)`）
3. `h = HMAC-SHA256(key=keyHash, msg)`；`off = h[31] & 0xf`；`h[off] &= 0x7f`
4. `otp = h[off..off+8] 大端 uint64`；`code = otp mod 26^digits`
5. 低位在前逐位映射：`out[i] = 'a' + code mod 26; code = floor(code / 26)`（i = 0..digits-1）→ 8 个小写字母
6. secret：base32 解码后 16 字节直通；26 字节须过校验和（`yandexValidateSecret`）后取前 16 字节
7. 校验和（`YandexInfo.validateSecret` 移植）：`accum = secret[0] & 0x3f`，i=1..15 `accum = (accum << 8) | secret[i]`；`crc = secret[16..25] 同式`；`poly = 0b1_1000_1111_0011`；i=0..15 若 `((crc >>> i) ^ (accum >>> i)) & 1 == 1` 则 `crc ^= poly << i`；终 `crc !== 0` 即校验失败

- [ ] **Step 1: 黄金向量生成器** `scripts/gen-yaotp-vectors.mjs`（独立参考实现——与被测 TS 代码不同路径，产出常量表）

```js
// 运行：node scripts/gen-yaotp-vectors.mjs   （仅 node:crypto 内置，无第三方依赖）
// 输出 6 行「secret_b32 | pin | period | timeMs | 期望 code」JSON，粘贴进 packages/core/test/yandex.test.ts 的 VECTORS 常量
import crypto from 'node:crypto'
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32(bytes) {
  let bits = 0, val = 0, out = ''
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5 } }
  return out
}
const secret = crypto.randomBytes(16)
const cases = []
for (const pin of ['1234', '0000', 'yy9-_x']) {
  for (const [period, timeMs] of [[30, 1700000000000], [60, 1700000060000]]) {
    const pinB = Buffer.from(pin, 'utf8')
    let keyHash = crypto.createHash('sha256').update(Buffer.concat([pinB, secret])).digest()
    if (keyHash[0] === 0) keyHash = keyHash.subarray(1)
    const counter = Math.floor(timeMs / 1000 / period)
    const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter))
    const h = crypto.createHmac('sha256', keyHash).update(msg).digest()
    const off = h[h.length - 1] & 0xf
    h[off] &= 0x7f
    let code = h.readBigUInt64BE(off) % 26n ** 8n
    let out = ''
    for (let i = 0; i < 8; i++) { out += String.fromCharCode(97 + Number(code % 26n)); code /= 26n }
    cases.push({ secretB32: b32(secret), pin, period, timeMs, code: out })
  }
}
console.log(JSON.stringify(cases, null, 2))
```

（同一 secret 复用使 6 个向量可共用测试常量；执行者运行后把输出粘贴为 Step 2 的 `VECTORS`。）

- [ ] **Step 2: 写失败测试** `packages/core/test/yandex.test.ts`

```ts
import { yandexCode, yandexValidateSecret, base32Decode, base32Encode } from '@totp/core'
import { describe, expect, it } from 'vitest'

// 由 scripts/gen-yaotp-vectors.mjs 产出（Step 1 运行结果原样粘贴）：
const VECTORS = [
  { secretB32: '<运行填入>', pin: '<填入>', period: 30, timeMs: 1700000000000, code: '<填入>' },
  // … 共 6 条
] as const

describe('yandexCode（黄金向量，对齐 Aegis YAOTP.java）', () => {
  it.each(VECTORS)('pin=$pin period=$period timeMs=$timeMs', async (v) => {
    await expect(yandexCode(v.secretB32, v.pin, v.timeMs, v.period)).resolves.toBe(v.code)
  })
  it('输出恒为 8 位小写字母', async () => {
    const code = await yandexCode(VECTORS[0]!.secretB32, VECTORS[0]!.pin, VECTORS[0]!.timeMs)
    expect(code).toMatch(/^[a-z]{8}$/)
  })
})

describe('yandexValidateSecret（YandexInfo.validateSecret 移植）', () => {
  it('16 字节直通；自洽 26 字节通过；任一位翻转抛错', () => {
    const body = new Uint8Array(16).map((_, i) => i * 7 + 1)
    expect(() => yandexValidateSecret(body)).not.toThrow()
    const full = new Uint8Array(26); full.set(body)
    // 按 poly 逆推 checkSum（与实现同式正向计算后写入）
    let accum = full[0]! & 0x3f
    for (let i = 1; i < 16; i++) accum = ((accum << 8) | full[i]!) | 0
    let crc = 0
    const poly = 0b1_1000_1111_0011
    for (let i = 0; i < 16; i++) if ((((crc >>> i) ^ (accum >>> i)) & 1) === 1) crc ^= poly << i
    for (let i = 0; i < 10; i++) full[16 + i] = (crc >>> ((9 - i) * 8)) & 0xff
    expect(() => yandexValidateSecret(full)).not.toThrow()
    const bad = full.slice(); bad[3]! ^= 1
    expect(() => yandexValidateSecret(bad)).toThrow()
  })
})

describe('yaotp URI（uri.ts 扩展）', () => {
  it('host yaotp → type yandex，默认 SHA256/8 位，pin 参数读取', async () => {
    const { parseOtpUri, buildOtpUri } = await import('@totp/core')
    const p = parseOtpUri('otpauth://yaotp/Yandex:user?secret=JBSWY3DPEHPK3PXP&pin=1234')
    expect(p.type).toBe('yandex')
    expect(p.algorithm).toBe('SHA256')
    expect(p.digits).toBe(8)
    expect((p as { pin?: string }).pin).toBe('1234')
    const back = parseOtpUri(buildOtpUri({ type: 'yandex', issuer: 'Yandex', label: 'user', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 30 }))
    expect(back.type).toBe('yandex')
  })
})
```

- [ ] **Step 3: 实现** `packages/core/src/otp/yandex.ts`（完整）

```ts
import { base32Decode } from '../encoding/base32'

export const YANDEX_DIGITS = 8
const CRC_POLY = 0b1_1000_1111_0011

/** YandexInfo.validateSecret 移植：16B 直通；26B=16B body + 10B CRC（poly 0x18F3 变体） */
export function yandexValidateSecret(secret: Uint8Array): void {
  if (secret.length === 16) return
  if (secret.length !== 26) throw new Error('yandex secret 长度非法（须 16 或 26 字节）')
  let accum = secret[0]! & 0x3f
  for (let i = 1; i < 16; i++) accum = ((accum << 8) | secret[i]!) | 0
  let crc = 0
  for (let i = 16; i < 26; i++) crc = ((crc << 8) | secret[i]!) | 0
  for (let i = 0; i < 16; i++) {
    if ((((crc >>> i) ^ (accum >>> i)) & 1) === 1) crc ^= CRC_POLY << i
  }
  if (crc !== 0) throw new Error('yandex secret 校验和不匹配')
}

/** Yandex secret（base32）→ 16 字节（26B 先过校验再取前 16） */
export function yandexSecretBytes(secretB32: string): Uint8Array {
  const bytes = base32Decode(secretB32.replace(/\s+/g, '').toUpperCase())
  yandexValidateSecret(bytes)
  return bytes.length === 26 ? bytes.slice(0, 16) : bytes
}

/** YAOTP.generateOTP 移植（spec 批③ §4.1 权威算法 1-5 步） */
export async function yandexCode(secretB32: string, pin: string, timeMs: number, period = 30, digits = YANDEX_DIGITS): Promise<string> {
  const secret = yandexSecretBytes(secretB32)
  const pinBytes = new TextEncoder().encode(pin)
  const merged = new Uint8Array(pinBytes.length + secret.length)
  merged.set(pinBytes); merged.set(secret, pinBytes.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', merged))
  const key = digest[0] === 0 ? digest.slice(1) : digest
  const counter = Math.floor(timeMs / 1000 / period)
  const msg = new Uint8Array(8)
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter))
  const hmacKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, msg))
  const off = h[h.length - 1] & 0xf
  h[off] &= 0x7f
  let code = new DataView(h.buffer, h.byteOffset).getBigUint64(off) % 26n ** BigInt(digits)
  let out = ''
  for (let i = 0; i < digits; i++) { out += String.fromCharCode(97 + Number(code % 26n)); code /= 26n }
  return out
}
```

`uri.ts` 改动点：`OtpUriParams.type` 联合加 `'yandex'`、`pin?: string`；parse 白名单 `['totp','hotp','steam','yandex']`，`host === 'yaotp'` 归一为 `'yandex'`；默认值分支 `digits = typeFinal === 'steam' ? 5 : typeFinal === 'yandex' ? 8 : Number(q.get('digits') ?? 6)`、`algorithm` 默认 `typeFinal === 'yandex' ? 'SHA256' : 'SHA1'`（query 显式值仍按白名单覆盖）；`q.get('pin')` 读取进结果。`buildOtpUri` 两处条件改写（现状 `p.digits !== 6` 对 yandex 会误输出 digits=8）：

```ts
const host = p.type === 'steam' ? 'steam' : p.type === 'yandex' ? 'yaotp' : p.type
const defaultDigits = p.type === 'steam' ? 5 : p.type === 'yandex' ? 8 : 6
const defaultAlgo: HashAlgorithm = p.type === 'yandex' ? 'SHA256' : 'SHA1'
if (p.algorithm !== defaultAlgo && p.type !== 'steam') q.set('algorithm', p.algorithm)
if (p.type !== 'steam' && p.digits !== defaultDigits) q.set('digits', String(p.digits))
if (p.type === 'yandex' && p.pin !== undefined) q.set('pin', p.pin)
```

其余波及（逐文件小改）：`normalize.ts` 的 `normalizeType` 白名单加 `'yandex'`、`toOtpDigits` 加 `type === 'yandex' → 8`；`ParsedEntry`/`OtpEntry` 加 `pin?: string`；`vaultStore.validateEntryShape` type 三元组改四元组并加 `if (o.type === 'yandex' && o.digits !== 8) reject()`、`if (o.pin !== undefined && typeof o.pin !== 'string') reject()`；`aegis.ts parseEntry` 加 `if (parsed.type === 'yandex' && typeof info.pin === 'string') parsed.pin = info.pin`。

ui 侧：`entryForm.ts` type 联合加 `'yandex'`；`EntryForm.vue` `TYPE_OPTIONS` 加 `{ value: 'yandex', label: 'Yandex（yaotp）' }`、type watch 加 `if (t === 'yandex') { form.digits = 8 } else if (old === 'yandex') form.digits = 6`、表单加「PIN（可选）」MdTextField 绑 `form.pin`、submit 产物带 `pin`；`useOtpCodes.ts` 加分支：

```ts
else if (e.type === 'yandex') code = await yandexCode(e.secret, e.pin ?? '', nowMs.value, period, e.digits)
```

- [ ] **Step 4: 全链路测试跑通**（core + ui 全量；`rg -n "'steam'" packages/core/src packages/ui/src` 逐个核对 type 白名单遗漏点——探索期统计 18 个文件，新增 yandex 后同样过一遍）

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/ui scripts/gen-yaotp-vectors.mjs
git commit -m "feat(otp): Yandex(yaotp) 算法与全链路类型扩展（对齐 Aegis YAOTP/YandexInfo，黄金向量测试）"
```

### Task 19: Authenticator Plus 导入（WinZip AES zip → Accounts.txt → uriBatch）

**Files:**
- Create: `packages/core/src/import/zipAes.ts`（WinZip AES AE-1/AE-2 加密条目解密原语）
- Create: `packages/core/src/import/zipRead.ts`（zip 结构解析：EOCD/central directory/local header，AES extra field 0x9901）
- Create: `packages/core/src/import/authenticatorPlus.ts`
- Modify: `packages/core/src/import/sniff.ts`（嗅探注释提及 AP 走文件选择非文本嗅探——不加入 sniffFormat）
- Modify: `packages/core/src/index.ts`
- Modify: `docs/superpowers/specs/2026-09-20-enhancement-roadmap-design.md`（§4.2 勘误，见 Step 1）
- Modify: `packages/ui` 导入向导文件选择格式（ImportCard/AP 入口：AP 是 zip 二进制——复用 `readImportFileBytes` 字节通道 + 手动选择「Authenticator Plus」格式项）
- Test: `packages/core/test/zipAes.test.ts`、`packages/core/test/authenticatorPlus.test.ts`

**Interfaces:**
- Consumes: WebCrypto PBKDF2-HMAC-SHA1/AES-CTR/HMAC、`fflate` 的 `inflateRawSync`（ui 依赖 fflate——core 需自加 `fflate` 依赖：`pnpm --filter @totp/core add fflate`）、`importUriBatch`
- Produces:
  - `deriveZipAesKeys(password: string, salt: Uint8Array, ks: 16 | 24 | 32): Promise<{ encKey: Uint8Array; authKey: Uint8Array; verifier: Uint8Array }>`
  - `zipAesCtrDecrypt(encKey: Uint8Array, data: Uint8Array, counter: Uint8Array): Promise<Uint8Array>`
  - `decryptZipEntryAes(password: string, entryData: Uint8Array, strength: 1 | 2 | 3): Promise<Uint8Array>`（salt+verifier+data+authCode 布局，AE-1/AE-2 通用）
  - `extractZipEntry(bytes: Uint8Array, nameSuffix: RegExp): Uint8Array | null`（遍历 central directory）
  - `importAuthenticatorPlus(zipBytes: Uint8Array, password: string): Promise<ImportResult>`

**权威参数（WinZip AES 规范 × zip4j `AESDecryptorJCE`——Aegis 经 zip4j 读 AP，参数一致即可互解）：**
- KDF：PBKDF2-HMAC-SHA1，迭代 **1000**，输出 `(2*ks + 2)` 字节 = `encKey(ks) || authKey(ks) || verifier(2)`
- 条目布局：`salt(ks/2) || verifier(2) || ciphertext || authCode(10)`；`ks`：strength 1/2/3 → 16/24/32 字节
- 加密：AES-CTR，**初始 counter block = 全零 16B、整 128 位大端递增**（zip4j 用 `AES/CTR/NoPadding` IV=0；WebCrypto `{name:'AES-CTR', counter: zeros16, length: 128}` 同语义）
- 完整性：HMAC-SHA1(authKey, ciphertext) 前 10 字节 == authCode；密码校验：解出 verifier 与文件头 2 字节比对

- [ ] **Step 1: spec 勘误并提交**（权威源核实结论：AP 加密 zip 内是 `Accounts.txt` 的 otpauth URI 逐行文本，Aegis `AuthenticatorPlusImporter` 经 `GoogleAuthUriImporter` 解析；**无需 SQLite/sql.js、无 group→tag 映射**）

```bash
git add docs/superpowers/specs/2026-09-20-enhancement-roadmap-design.md
git commit -m "docs(specs): 批③ AP 勘误——加密 zip 内为 Accounts.txt URI 文本，复用 uriBatch 无分组映射"
```

spec §4.2 两行改为：

```markdown
- `packages/core/src/import/authenticatorPlus.ts`：对齐 Aegis `AuthenticatorPlusImporter.java`——加密 zip 内为 `Accounts.txt`（otpauth URI 逐行文本），解出后直接复用 `importUriBatch`；**无 SQLite、无 group 映射**。
- **技术风险**：fflate 不支持 WinZip AES 加密 zip → 自实现 AE-1/AE-2 解密 + zip 结构解析（`zipRead.ts`）；参数对不上 Aegis/zip4j 实现时回报。
```

- [ ] **Step 2: 原语失败测试** `packages/core/test/zipAes.test.ts`（标准向量，非自证）

```ts
import { pbkdf2Sha1, zipAesCtrDecrypt } from '@totp/core'
import { hexToBytes } from '@totp/core'
import { describe, expect, it } from 'vitest'

const hex = (s: string) => hexToBytes(s)!
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

describe('pbkdf2Sha1（RFC 6070 权威向量）', () => {
  it.each([
    ['password', 'salt', 1, '0c60c80f961f0e71f3a9b524af6012062fe037a6'],
    ['password', 'salt', 2, 'ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957'],
    ['password', 'salt', 4096, '4b007901b765489abead49d926f721d065a429c1'],
  ])('P=%s S=%s c=%i → 20B', async (p, s, c, expected) => {
    const out = await pbkdf2Sha1(p, hex(s)!, c, 20)
    expect(toHex(out)).toBe(expected)
  })
})

describe('zipAesCtrDecrypt（NIST SP 800-38A F.5.1 CTR-AES128.Encrypt）', () => {
  it('块1：6bc1bee2… → 874d6191…', async () => {
    const key = hex('2b7e151628aed2a6abf7158809cf4f3c')!
    const counter = hex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff')!
    const plain = hex('6bc1bee22e409f96e93d7e117393172a')!
    const ct = await zipAesCtrDecrypt(key, plain, counter) // CTR 加解对称
    expect(toHex(ct)).toBe('874d6191b620e3261bef6864990db6ce')
  })
  it('跨块计数递增：两块明文整体加解一致', async () => {
    const key = hex('2b7e151628aed2a6abf7158809cf4f3c')!
    const counter = hex('f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff')!
    const plain = hex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51')!
    const ct = await zipAesCtrDecrypt(key, plain, counter)
    expect(toHex(ct)).toBe('874d6191b620e3261bef6864990db6ce9806f66b7970fdff8617187bb9fffdff')
    const back = await zipAesCtrDecrypt(key, ct, counter)
    expect(toHex(back)).toBe(toHex(plain))
  })
})
```

- [ ] **Step 3: 实现 `zipAes.ts`**

```ts
import { inflateRawSync, unzlibSync } from 'fflate' // 仅 inflateRawSync 必需

const encoder = new TextEncoder()

export async function pbkdf2Sha1(password: string, salt: Uint8Array, iterations: number, outBytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password) as BufferSource, 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-1', salt: salt as BufferSource, iterations }, key, outBytes * 8))
}

const ZERO_COUNTER = new Uint8Array(16)

export async function deriveZipAesKeys(password: string, salt: Uint8Array, ks: 16 | 24 | 32) {
  const derived = await pbkdf2Sha1(password, salt, 1000, ks * 2 + 2)
  return {
    encKey: derived.slice(0, ks),
    authKey: derived.slice(ks, ks * 2),
    verifier: derived.slice(ks * 2),
  }
}

/** AES-CTR（counter 参数化，16B 块大端递增——WebCrypto length:128 同语义） */
export async function zipAesCtrDecrypt(key: Uint8Array, data: Uint8Array, counter: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-CTR', false, ['encrypt'])
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CTR', counter: counter as BufferSource, length: 128 }, k, data as BufferSource))
}

const STRENGTH_KS = { 1: 16, 2: 24, 3: 32 } as const

/** WinZip AES 条目解密（AE-1/AE-2 通用）：salt || verifier || ciphertext || authCode(10) */
export async function decryptZipEntryAes(password: string, entryData: Uint8Array, strength: 1 | 2 | 3): Promise<Uint8Array> {
  const ks = STRENGTH_KS[strength]
  const saltLen = ks / 2
  if (entryData.length < saltLen + 2 + 10) throw new Error('AP 加密条目过短')
  const salt = entryData.slice(0, saltLen)
  const storedVerifier = entryData.slice(saltLen, saltLen + 2)
  const ciphertext = entryData.slice(saltLen + 2, entryData.length - 10)
  const authCode = entryData.slice(entryData.length - 10)
  const { encKey, authKey, verifier } = await deriveZipAesKeys(password, salt, ks)
  // 密码校验（2 字节）：不匹配=口令错误
  if (verifier[0] !== storedVerifier[0] || verifier[1] !== storedVerifier[1]) throw new Error('口令错误或文件已损坏')
  // 完整性：HMAC-SHA1(authKey, ciphertext) 前 10 字节
  const hmacKey = await crypto.subtle.importKey('raw', authKey as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, ciphertext as BufferSource)).slice(0, 10)
  for (let i = 0; i < 10; i++) if (mac[i] !== authCode[i]) throw new Error('AP 加密条目完整性校验失败（文件损坏或口令错误）')
  return zipAesCtrDecrypt(encKey, ciphertext, ZERO_COUNTER)
}
```

- [ ] **Step 4: 实现 `zipRead.ts`**（完整实现，全部 little-endian DataView）

```ts
// 偏移表：EOCD(sig 0x06054b50) cdCount@10(2B) cdSize@12(4B) cdOffset@16(4B)
//         CEN (sig 0x02014b50) method@10(2B) csize@20(4B) nameLen@28(2B) extraLen@30(2B) commentLen@32(2B) localOffset@42(4B)
//         LOC (sig 0x04034b50) nameLen@26(2B) extraLen@28(2B)
//         AES extra field id 0x9901: formatVersion(2B) vendorId(2B) strength(1B: 1/2/3) realMethod(2B)
export interface ZipEntryView {
  name: string
  csize: number
  method: number
  dataOffset: number
  aes?: { strength: 1 | 2 | 3; realMethod: number }
}

export function listZipEntries(bytes: Uint8Array): ZipEntryView[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // ① 从尾部扫 EOCD（注释区最长 65535 + 固定 22）
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法 zip（未找到 EOCD）')
  const count = dv.getUint16(eocd + 10, true)
  let p = eocd + dv.getUint32(eocd + 16, true)
  const out: ZipEntryView[] = []
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip central directory 损坏')
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    // ② extra field 中找 AES(0x9901)
    let aes: ZipEntryView['aes']
    let q = p + 46 + nameLen
    const extraEnd = q + extraLen
    while (q + 4 <= extraEnd) {
      const id = dv.getUint16(q, true)
      const size = dv.getUint16(q + 2, true)
      if (id === 0x9901 && size >= 7) {
        aes = { strength: dv.getUint8(q + 8) as 1 | 2 | 3, realMethod: dv.getUint16(q + 9, true) }
        break
      }
      q += 4 + size
    }
    // ③ 数据区 = LOC 头 + name + extra（LOC 的 extraLen 可能与 CEN 不同，须读 LOC 自己的）
    const locNameLen = dv.getUint16(localOffset + 26, true)
    const locExtraLen = dv.getUint16(localOffset + 28, true)
    out.push({ name, csize, method, dataOffset: localOffset + 30 + locNameLen + locExtraLen, aes })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

export function readZipEntryData(bytes: Uint8Array, e: ZipEntryView): Uint8Array {
  return bytes.slice(e.dataOffset, e.dataOffset + e.csize)
}

export function inflateEntry(e: ZipEntryView, raw: Uint8Array): Uint8Array {
  if (e.aes && e.method === 99) return e.aes.realMethod === 0 ? raw : inflateRawSync(raw)
  if (e.method === 0) return raw
  if (e.method === 8) return inflateRawSync(raw)
  throw new Error('不支持的 zip 压缩方法：' + e.method)
}
```

（`readZipEntryData` 的 zip64 条目（csize=0xFFFFFFFF）不在支持范围——AP 导出远小于 4GB，遇 zip64 抛「不支持 zip64」并计入 failures。）

- [ ] **Step 5: 实现 `authenticatorPlus.ts` + 集成测试**

```ts
import { importUriBatch } from './uriBatch'
import { decryptZipEntryAes } from './zipAes'
import { inflateEntry, listZipEntries, readZipEntryData } from './zipRead'
import type { ImportResult } from './types'

/** Authenticator Plus 导入：加密 zip（用户在 AP 内「导出为文本」生成）内 Accounts.txt → otpauth URI 逐行 */
export async function importAuthenticatorPlus(zipBytes: Uint8Array, password: string): Promise<ImportResult> {
  const entries = listZipEntries(zipBytes)
  const target = entries.find((e) => e.name.endsWith('Accounts.txt'))
  if (!target) throw new Error('压缩包中未找到 Accounts.txt（请使用 Authenticator Plus 的文本导出）')
  const raw = readZipEntryData(zipBytes, target)
  const plain = target.aes ? await decryptZipEntryAes(password, raw, target.aes.strength) : raw
  const text = new TextDecoder().decode(inflateEntry(target, plain))
  return importUriBatch(text)
}
```

集成测试（`packages/core/test/authenticatorPlus.test.ts`）：无现成权威加密样本——用 **7-Zip 生成 AE-2（AES-256）zip** 作对拍 fixture（7z 与 zip4j 同遵 WinZip AES 规范）：

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SEVEN_ZIP = ['C:\\Program Files\\7-Zip\\7z.exe', 'C:\\Program Files (x86)\\7-Zip\\7z.exe'].find(existsSync)
const d = it('', () => {}) // 占位说明：7z 不存在时集成用例整体 skip
```

测试逻辑：`tmp = mkdtempSync(join(tmpdir(), 'ap-'))` → 写 `Accounts.txt`（两条 otpauth URI）→ `execFileSync(SEVEN_ZIP, ['a', '-tzip', '-mem=AES256', '-psecret123', join(tmp, 'ap.zip'), join(tmp, 'Accounts.txt')])` → `importAuthenticatorPlus(readFileSync(zip), 'secret123')` 断言 2 条目字段 → 错误口令 rejects。**`SEVEN_ZIP` 为 undefined 时 `describe.skip` 整组跳过**（CI 无 7z 不红）。`AP_EXTERNAL_SAMPLE` 环境变量指向真实 AP 导出文件时追加一条真样本用例（有则跑）。

- [ ] **Step 6: UI 入口**——ImportCard 的文件选择格式清单加「Authenticator Plus（加密 zip）」：`readImportFileBytes` 已有字节通道（`options/App.vue` `pickFile` 扩展 `.zip`），ImportCard 新增格式分支调 `importAuthenticatorPlus(bytes, password)`（口令页复用 Aegis 加密同款交互；`sniffFormat` 不识别 zip 文本属预期，入口为手动选择）。

- [ ] **Step 7: 跑测试 + Commit**

```bash
pnpm --filter @totp/core test -- zipAes
pnpm --filter @totp/core test -- authenticatorPlus
git add packages/core docs/superpowers/specs/2026-09-20-enhancement-roadmap-design.md packages/ui
git commit -m "feat(import): Authenticator Plus 加密 zip 导入（WinZip AES AE-2 自实现 + Accounts.txt→uriBatch）"
```
---

## Part 4：批④ 体验打磨

### Task 20: AMOLED 纯黑对比度档

**Files:**
- Modify: `packages/core/src/storage/vaultStore.ts`（`AppSettings` 加 `themeContrast`；DEFAULT；loadSettings 校验行）
- Modify: `packages/ui/src/theme/useTheme.ts`（`applyThemeAttributes` 加 contrast 参数 + watchEffect 传递；副作用引入 amoled.css）
- Create: `packages/ui/src/theme/amoled.css`
- Modify: `packages/ui/src/pages/SettingsPage.vue`（外观区「纯黑（AMOLED）」开关）
- Test: `packages/core/test/settingsContrast.test.ts`、`packages/ui/test/useTheme.amoled.test.ts`

**Interfaces:**
- Consumes: 现有 `data-mode` token 选择器体系（`tokens.css`）
- Produces: `AppSettings.themeContrast: 'standard' | 'amoled'`（默认 `'standard'`）；`html[data-contrast='amoled']` 表面色覆盖层

- [ ] **Step 1: core 失败测试**

```ts
import { DEFAULT_SETTINGS, loadSettings, type StorageAdapter } from '@totp/core'
import { describe, expect, it } from 'vitest'

const adapterWith = (v: unknown): StorageAdapter => ({
  get: async (k) => (k === 'settings' ? JSON.stringify(v) : null), set: async () => {}, delete: async () => {},
})

describe('settings.themeContrast', () => {
  it('缺省 standard；非法值回退', async () => {
    expect(DEFAULT_SETTINGS.themeContrast).toBe('standard')
    expect((await loadSettings(adapterWith({ themeContrast: 'high' }))).themeContrast).toBe('standard')
    expect((await loadSettings(adapterWith({ themeContrast: 'amoled' }))).themeContrast).toBe('amoled')
  })
})
```

实现照抄 `locale` 字段模式（Task 2）：接口加 `/** 纯黑对比度档（spec §5）：amoled=暗色表面覆盖为 #000 系（OLED 省电+对比），仅影响表面色 */ themeContrast: 'standard' | 'amoled'`；DEFAULT `themeContrast: 'standard',`；loadSettings 校验行 `themeContrast: merged.themeContrast === 'amoled' ? merged.themeContrast : 'standard',`（standard 为唯一其他合法值，等价回退）。

- [ ] **Step 2: ui 失败测试** `packages/ui/test/useTheme.amoled.test.ts`（jsdom）

```ts
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
```

- [ ] **Step 3: 实现**——`useTheme.ts`：

```ts
import './amoled.css' // 副作用：覆盖层随主题模块引入

export function applyThemeAttributes(mode: string, color: string, contrast: string = 'standard'): void {
  document.documentElement.dataset.mode = mode
  document.documentElement.dataset.color = color
  document.documentElement.dataset.contrast = contrast
}
```

`useTheme` 的 `watchEffect` 内调用处改 `applyThemeAttributes(m, c, store.settings.themeContrast === 'amoled' ? 'amoled' : 'standard')`。

`packages/ui/src/theme/amoled.css`（覆盖暗色表面系；primary 系不动——spec §5）：

```css
/* AMOLED 纯黑（spec 批④ §5）：仅覆盖表面/容器梯度，主色与文本对比度体系不变。
   非 light 即 auto+dark：auto 由 resolvedMode 决定实际观感，覆盖层跟随 data-mode 原值。
   变量名以 tokens.css 实际产出为准（Step 3 核对）。 */
html[data-contrast='amoled']:not([data-mode='light']) {
  --md-sys-color-surface: #000000;
  --md-sys-color-surface-dim: #000000;
  --md-sys-color-surface-bright: #0f0f0f;
  --md-sys-color-surface-container-lowest: #000000;
  --md-sys-color-surface-container-low: #070707;
  --md-sys-color-surface-container: #0b0b0b;
  --md-sys-color-surface-container-high: #121212;
  --md-sys-color-surface-container-highest: #1a1a1a;
  --md-sys-color-outline-variant: #2a2a2a;
}
```

（变量名以 `packages/ui/src/theme/tokens.css` 实际生成的变量清单为准——Step 3 第一步 `rg -n "surface-container" packages/ui/src/theme/tokens.css | head` 核对，缺哪个变量就删哪行，多哪个表面变量就按同梯度补哪行。）

SettingsPage：外观区加 MdSwitch「纯黑（AMOLED）」（`:model-value="store.settings.themeContrast === 'amoled'"`，`@update:model-value` 写 `themeContrast` 并 `commitSettings()`；仅暗色/自动模式下有意义——文案注明「暗色模式下生效」）。

- [ ] **Step 4: 跑通过 + Commit**

```bash
pnpm --filter @totp/core test -- settingsContrast
pnpm --filter @totp/ui test -- useTheme
git add packages/core packages/ui/src/theme packages/ui/src/pages/SettingsPage.vue packages/ui/test
git commit -m "feat(theme): AMOLED 纯黑对比度档（表面色覆盖层，主色不动，批④ §5）"
```

### Task 21: 首字母头像多彩取色

**Files:**
- Create: `packages/ui/src/components/avatarColor.ts`
- Modify: `packages/ui/src/components/OtpListItem.vue`（无图标 avatar 分支应用动态底色）
- Test: `packages/ui/test/avatarColor.test.ts`（`OtpListItem.test.ts` 补样式断言）

**Interfaces:**
- Consumes: `THEME_PALETTES`（`packages/ui/src/theme/palette.ts`，10 色 hex）
- Produces: `avatarStyleOf(issuer: string): { background: string; color: string } | null`（issuer trim 后空串返回 null → 沿用现状 primary-container 样式；CSS `color-mix` 由浏览器求值，纯函数只产字符串）

- [ ] **Step 1: 写失败测试**

```ts
import { avatarStyleOf } from '../src/components/avatarColor'
import { describe, expect, it } from 'vitest'

describe('avatarStyleOf', () => {
  it('同 issuer 稳定，异 issuer 有分布（10 色哈希桶）', () => {
    expect(avatarStyleOf('GitHub')).toEqual(avatarStyleOf('GitHub'))
    const set = new Set(['GitHub', 'GitLab', 'Google', 'Amazon', 'Steam', '微信', 'Discord', 'Stripe', 'Cloudflare', 'Baidu', 'Twitter'].map((s) => avatarStyleOf(s)!.background))
    expect(set.size).toBeGreaterThan(3)
  })
  it('空白 issuer 返回 null（保留默认样式）', () => {
    expect(avatarStyleOf('')).toBeNull()
    expect(avatarStyleOf('   ')).toBeNull()
  })
  it('产出含 color-mix 与具体色值', () => {
    const s = avatarStyleOf('GitHub')!
    expect(s.background).toMatch(/^color-mix\(in srgb, #/)
    expect(s.color).toMatch(/^color-mix\(in srgb, #/)
  })
})
```

- [ ] **Step 2: 实现**

```ts
import { THEME_PALETTES } from '../theme/palette'

/** FNV-1a 32bit：同 issuer 稳定选色；色板来自主题 10 子色（spec 批④ §5） */
function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export function avatarStyleOf(issuer: string): { background: string; color: string } | null {
  const name = issuer.trim()
  if (name === '') return null
  const hex = THEME_PALETTES[fnv1a(name) % THEME_PALETTES.length]!.hex
  return {
    background: `color-mix(in srgb, ${hex} 22%, var(--md-sys-color-surface))`,
    color: `color-mix(in srgb, ${hex} 55%, var(--md-sys-color-on-surface))`,
  }
}
```

- [ ] **Step 3: OtpListItem 接线**——script 加：

```ts
import { avatarStyleOf } from './avatarColor'
const avatarStyle = computed(() => (props.icon?.html || props.icon?.src ? undefined : avatarStyleOf(props.entry.issuer)))
```

模板 avatar：`<span class="avatar" :style="avatarStyle ?? undefined">`（scoped CSS 的 `.avatar` 背景声明保留作 `?` 兜底与 icon 场景底色，内联 style 仅无图标时覆盖）。`OtpListItem.test.ts` 追加：`icon` 缺省挂载断言根内 avatar 带 style 属性、传入 `icon.html` 时不带。

- [ ] **Step 4: 跑通过 + Commit**

```bash
pnpm --filter @totp/ui test -- avatarColor
pnpm --filter @totp/ui test -- OtpListItem
git add packages/ui/src/components packages/ui/test
git commit -m "feat(ui): 无图标条目首字母头像按 issuer 哈希多彩取色（批④ §5）"
```

---

## Part 5：i18n D2 全量收尾

### Task 22: 全量抽串 + en 资源 + 验收

**Files:**
- Modify: `packages/ui/src/pages/`（CodesPage、ImportPage、SyncPage、SecurityPage、SettingsPage）
- Modify: `packages/ui/src/components/`（EntryForm、EntryFormDialog、BatchPastePanel、OtpQrDialog、QrSheetDialog、TagManagerDialog、TagFilterRow、RevealDialog、BackupCard、BackupSecretCard、CloudCard、ImportCard、SecurityCard、SyncCard、OtpListItem、SearchBar；NavigationShell/LockScreen 已在 Task 3 完成）
- Modify: `apps/extension/entrypoints/popup/App.vue`、`apps/desktop/src/`（壳层文案）
- Modify: `packages/ui/src/i18n/locales/{zh,en}/`（按模块拆分新 JSON：`nav/lock/pages/<页名>/components/<组件名>`）
- Test: 各组件既有测试（挂 Task 3 的 `test/helpers/i18n.ts` 插件；断言保持 zh 不改）

**Interfaces:**
- Consumes: `createAppI18n`（Task 1）、key 命名约定（Task 3）
- Produces: 全 UI 文案 key 化；zh 资源 = 现状文案原样；en 资源 = 对应英译

- [ ] **Step 1: 生成全量文案清单**（工作底稿，放 `.temp/i18n-inventory.md`，不入库）

```bash
rg -n "\p{Han}" packages/ui/src apps/extension/entrypoints apps/desktop/src --glob '*.vue' --glob '*.ts' --glob '!**/i18n/**' --glob '!**/*.test.*' > .temp/i18n-inventory.md
```

- [ ] **Step 2: 按组件批量迁移**（机械操作，模式与 Task 3 相同；每组件三步：列文案 → 建 key（模块前缀 = 文件名 camelCase，如 `backupCard.exportBtn`）→ 替换为 `t()`；`<script>` 内字符串（错误消息、确认文案）同样经 `t()`——`useI18n()` 的 `t` 在 setup 顶层解构后 setup 内任意函数可用）。每完成 4-6 个组件跑一次该组件测试并 commit：

```bash
pnpm --filter @totp/ui test
git add packages/ui/src packages/ui/test
git commit -m "refactor(i18n): <组件组> 文案 key 化（D2）"
```

- [ ] **Step 3: en 资源补齐**——逐 key 英译（技术词表：vault=Vault、保管区=Secret bag、条目=Entry、密钥=Secret、口令=Passphrase、验证码=Code；品牌词不动）。翻译为执行者产出，完成后在任务汇报中列 10 条代表性译文请需求方抽查。

- [ ] **Step 4: 验收（spec §6）**

```bash
rg -n "\p{Han}" packages/ui/src apps/extension/entrypoints apps/desktop/src --glob '*.vue' --glob '*.ts' --glob '!**/i18n/**' --glob '!**/*.test.*'
```

Expected: 输出仅剩**代码注释**与**测试文件**命中（测试保持中文断言属既定策略）；逐一肉眼核对输出行均处于 `//` 或 `/* */` 注释内，任何字符串字面量命中即回到 Step 2 补迁移。

- [ ] **Step 5: 全量回归 + Commit**

```bash
pnpm test && pnpm typecheck
git add -A
git commit -m "refactor(i18n): 全量文案 key 化与英文资源（D2 收尾，spec §6 验收通过）"
```

---

## 执行说明

- 顺序强制：Part 0 → Part 1 → Part 2 → Part 3 → Part 4 → Part 5（spec §7）；Task 内部步骤按序，Step「跑测试确认失败」不得跳过（TDD 门）。
- 每任务结束的状态：对应包测试全绿 + typecheck 无新增错误 + 独立 commit。
- 两个「实施时核对」点均为明确的核对动作而非自由发挥：Task 19 `tokens.css` 变量名核对（删补 CSS 行）、Task 17 真机 activeTab 验证（降级路径已写死，扩权须回报）。
- 黄金向量（Task 18）与 7z 集成样本（Task 19）由执行者运行脚本/本地工具产出，产物不制造占位符。
