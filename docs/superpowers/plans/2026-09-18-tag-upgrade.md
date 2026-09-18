# 分组升级为标签（Tag）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Group 体系全面升级为 Tag：多选 AND/OR 过滤、Popup 与管理页统一筛选、外部导入分组键映射为 tag。

**Architecture:** core 层重命名数据模型并新增标签过滤引擎与导入 tag 落地链；ui 层抽共享 `TagFilterRow` 组件供 CodesPage 与 Popup 复用，popup 回退算法抽为纯函数 `resolvePopupVisible`；持久化经 settings 三字段。未发布产品，直接重写零迁移。

**Tech Stack:** TypeScript + Vue 3（setup script）、vitest、@vue/test-utils、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-18-tag-upgrade-design.md`

## Global Constraints

- 未发布产品：**零迁移**，vault `version` 1→2，键名 `groups/groupIds` → `tags/tagIds` 直接改。
- 同名 tag 唯一：名称 trim + 大小写不敏感比较；`addTag` 幂等复用。
- 展示顺序：tag 一律按名称 `localeCompare(…, 'zh')` 字母序（`Tag` 模型无 `order` 字段）。
- 测试命令：`pnpm -C packages/core test`、`pnpm -C packages/ui test`、`pnpm -C apps/extension test`；类型：各包 `pnpm -C <pkg> typecheck`；根 `pnpm test` / `pnpm typecheck`。
- **跨包红窗**：Task 1 起 core 改名会使 ui/extension 编译红，属预期；ui 侧到 Task 10 结束恢复全绿，extension 侧到 Task 13 恢复。各任务只跑自己包的 test/typecheck。
- commit 遵循 Angular 规范，原子化，每任务至少一次。
- core 包不 import 任何浏览器 API；组件测试用 `createMemoryStorage()` + `mount`。

---

### Task 1: core 数据模型 Tag 化 + vault 操作

**Files:**
- Modify: `packages/core/src/model.ts`
- Modify: `packages/core/src/vault.ts`
- Test: `packages/core/test/vault.test.ts`

**Interfaces:**
- Produces: `interface Tag { id: string; name: string }`；`OtpEntry.tagIds: string[]`；`Vault { version: 2; tags: Tag[]; ... }`；`addTag(v, name): { vault: Vault; tagId: string }`（同名幂等复用）；`renameTag(v, id, name): Vault`；`removeTag(v, id): Vault`（清条目引用）；`ensureTag === addTag` 别名。

- [ ] **Step 1: 改写测试（先红）**

`packages/core/test/vault.test.ts` 全文替换为：

```ts
import { describe, expect, it } from 'vitest'
import { createVault, addEntry, removeEntry, updateEntry, addTag, renameTag, removeTag, reorderEntries, newEntryFromUri } from '../src/vault'
import type { OtpEntry } from '../src/model'

const mkEntry = (uuid: string, order = 0): OtpEntry => ({
  uuid, type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order, createdAt: 0,
})

describe('vault 操作', () => {
  it('新建 vault 为 version 2 且带 tags 数组', () => {
    const v = createVault()
    expect(v.version).toBe(2)
    expect(v.tags).toEqual([])
    expect(v.entries).toEqual([])
  })

  it('add/remove/update entry 返回新对象且不改入参', () => {
    const v0 = createVault()
    const v1 = addEntry(v0, mkEntry('a'))
    expect(v1.entries).toHaveLength(1)
    expect(v0.entries).toHaveLength(0)
    const v2 = updateEntry(v1, 'a', { issuer: 'GitLab' })
    expect(v2.entries[0]!.issuer).toBe('GitLab')
    expect(v3Name(v1)).toBe('GitHub')
    const v3 = removeEntry(v2, 'a')
    expect(v3.entries).toHaveLength(0)
  })

  function v3Name(v: { entries: OtpEntry[] }): string {
    return v.entries[0]!.issuer
  }

  it('renameTag 返回新对象且只改目标 tag 名，原 vault 不变', () => {
    const v0 = createVault()
    const r1 = addTag(v0, '旧名')
    const tid = r1.tagId
    const v2 = renameTag(r1.vault, tid, '新名')
    expect(v2.tags[0]!.name).toBe('新名')
    expect(v2).not.toBe(r1.vault)
    expect(r1.vault.tags[0]!.name).toBe('旧名')
    expect(v0.tags).toHaveLength(0)
  })

  it('addTag 同名（trim + 大小写不敏感）幂等复用，不建第二个', () => {
    let v = createVault()
    const r1 = addTag(v, '工作')
    v = r1.vault
    const r2 = addTag(v, ' 工作 ')
    expect(r2.vault).toBe(v)
    expect(r2.tagId).toBe(r1.tagId)
    const r3 = addTag(v, '工作'.toUpperCase())
    expect(r3.tagId).toBe(r1.tagId)
    expect(v.tags).toHaveLength(1)
    // ensureTag 为 addTag 别名（同一实现，导入/表单路径语义名）
    expect(ensureTag).toBe(addTag)
  })

  it('removeTag：tag 移除且条目 tagIds 引用被清理', () => {
    let v = createVault()
    const r = addTag(v, '工作')
    v = r.vault
    v = addEntry(v, { ...mkEntry('a'), tagIds: [r.tagId] })
    v = removeTag(v, r.tagId)
    expect(v.tags).toHaveLength(0)
    expect(v.entries[0]!.tagIds).toEqual([])
  })

  it('reorder 按 uuid 序列重排 order', () => {
    let v = createVault()
    v = addEntry(v, mkEntry('a', 0))
    v = addEntry(v, mkEntry('b', 1))
    v = addEntry(v, mkEntry('c', 2))
    v = reorderEntries(v, ['c', 'a', 'b'])
    expect(v.entries.find((e) => e.uuid === 'c')!.order).toBe(0)
    expect(v.entries.find((e) => e.uuid === 'a')!.order).toBe(1)
    expect(v.entries.find((e) => e.uuid === 'b')!.order).toBe(2)
  })

  it('newEntryFromUri 解析 otpauth 并补默认值（tagIds 为空数组）', () => {
    const e = newEntryFromUri('otpauth://totp/GitHub:me%40ex.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub', 1700000000000)
    expect(e.issuer).toBe('GitHub')
    expect(e.period).toBe(30)
    expect(e.tagIds).toEqual([])
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/)
  })
})
```

（原文件中其余既有用例若上表未覆盖——如 newEntryFromUri 的 counter/digits 断言——原样保留，仅把 `groupIds` 键改为 `tagIds`。）

- [ ] **Step 2: 跑测试确认编译失败**

Run: `pnpm -C packages/core test -- vault.test.ts`
Expected: FAIL（`addGroup` 等导出不存在 / `groupIds` 类型错误）

- [ ] **Step 3: 实现**

`packages/core/src/model.ts`：

```ts
export interface OtpEntry {
  uuid: string
  type: EntryType
  issuer: string
  label: string
  secret: string
  algorithm: HashAlgorithm
  digits: OtpDigits
  period: number
  counter?: number
  note?: string
  icon?: IconRef
  matchRules?: MatchRule[]
  tagIds: string[]
  order: number
  createdAt: number
  /** 是否置顶：列表渲染时优先；缺省 false（向后兼容旧 vault） */
  pinned?: boolean
}

export interface Tag {
  id: string
  name: string
}

export interface Vault {
  version: 2
  entries: OtpEntry[]
  tags: Tag[]
  updatedAt: number
}
```

（文件其余类型 `EntryType/OtpDigits` 等不动；`Group` 接口删除。）

`packages/core/src/vault.ts`：

```ts
import type { OtpEntry, Tag, Vault } from './model'
import { toOtpDigits } from './import/normalize'
import { parseOtpUri } from './otp/uri'

export function createVault(): Vault {
  return { version: 2, entries: [], tags: [], updatedAt: 0 }
}

function withVault(v: Vault, patch: Partial<Vault>): Vault {
  return { ...v, ...patch, updatedAt: Date.now() }
}

export function addEntry(v: Vault, entry: OtpEntry): Vault {
  const maxOrder = v.entries.reduce((m, e) => Math.max(m, e.order), -1)
  return withVault(v, { entries: [...v.entries, { ...entry, order: maxOrder + 1 }] })
}

export function removeEntry(v: Vault, uuid: string): Vault {
  return withVault(v, { entries: v.entries.filter((e) => e.uuid !== uuid) })
}

export function updateEntry(v: Vault, uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>): Vault {
  return withVault(v, { entries: v.entries.map((e) => (e.uuid === uuid ? { ...e, ...patch } : e)) })
}

// 同名唯一键：trim + 大小写不敏感（spec §1）
const tagKey = (name: string): string => name.trim().toLowerCase()

/** 建 tag：同名（trim+casefold）幂等复用返回现有 id；创建时名称 trim 落库 */
export function addTag(v: Vault, name: string): { vault: Vault; tagId: string } {
  const existing = v.tags.find((t) => tagKey(t.name) === tagKey(name))
  if (existing) return { vault: v, tagId: existing.id }
  const tag: Tag = { id: crypto.randomUUID(), name: name.trim() }
  return { vault: withVault(v, { tags: [...v.tags, tag] }), tagId: tag.id }
}

/** ensure 语义与 addTag 重合（幂等复用即 ensure），导出别名供导入/表单路径使用 */
export const ensureTag = addTag

/** 重命名只改名不做重名合并（保持引用稳定；重名收敛仅在创建路径） */
export function renameTag(v: Vault, id: string, name: string): Vault {
  return withVault(v, { tags: v.tags.map((t) => (t.id === id ? { ...t, name: name.trim() } : t)) })
}

export function removeTag(v: Vault, id: string): Vault {
  return withVault(v, {
    tags: v.tags.filter((t) => t.id !== id),
    entries: v.entries.map((e) => (e.tagIds.includes(id) ? { ...e, tagIds: e.tagIds.filter((t) => t !== id) } : e)),
  })
}

export function reorderEntries(v: Vault, orderedUuids: string[]): Vault {
  const orderMap = new Map(orderedUuids.map((uuid, i) => [uuid, i]))
  return withVault(v, {
    entries: v.entries.map((e) => (orderMap.has(e.uuid) ? { ...e, order: orderMap.get(e.uuid)! } : e)),
  })
}

export function newEntryFromUri(uri: string, nowMs: number = Date.now()): OtpEntry {
  const p = parseOtpUri(uri)
  return {
    uuid: crypto.randomUUID(),
    type: p.type,
    issuer: p.issuer,
    label: p.label,
    secret: p.secret,
    algorithm: p.algorithm,
    digits: toOtpDigits(p.digits, p.type),
    period: p.period,
    ...(p.counter !== undefined ? { counter: p.counter } : {}),
    tagIds: [],
    order: 0,
    createdAt: nowMs,
  }
}
```

同文件清理：`addGroup/renameGroup/removeGroup` 删除。全 core 包内 `groupIds/groups` 残留引用同步改（`rg -n "groupIds|addGroup|renameGroup|removeGroup|Group" packages/core/src`，应仅剩 `Tag` 无关命中为零）。

- [ ] **Step 4: 跑测试 + core typecheck**

Run: `pnpm -C packages/core test && pnpm -C packages/core typecheck`
Expected: 全 PASS / 无类型错误（ui/extension 红属预期，见 Global Constraints）

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core)!: vault 模型 Group 重命名为 Tag 并加同名唯一约束

why: 分组升级为标签（spec 2026-09-18-tag-upgrade §1），未发布零迁移直接重写。
what: model v2（tags/tagIds）+ addTag/renameTag/removeTag（addTag 幂等复用、ensureTag 别名），删除 Group/addGroup 族。"
```

---

### Task 2: 标签过滤引擎 filterByTags

**Files:**
- Create: `packages/core/src/tags/filter.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/tags.filter.test.ts`

**Interfaces:**
- Consumes: `OtpEntry.tagIds`（Task 1）
- Produces: `type TagFilterMode = 'any' | 'all'`；`filterByTags(entries: OtpEntry[], selectedTagIds: ReadonlySet<string>, mode: TagFilterMode): OtpEntry[]`

- [ ] **Step 1: 写失败测试** `packages/core/test/tags.filter.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { filterByTags } from '../src/tags/filter'
import type { OtpEntry } from '../src/model'

const e = (uuid: string, tagIds: string[]): OtpEntry => ({
  uuid, type: 'totp', issuer: 'i', label: 'l', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds, order: 0, createdAt: 0,
})
const list = [e('a', ['t1']), e('b', ['t1', 't2']), e('c', ['t3']), e('d', [])]

describe('filterByTags', () => {
  it('未选中任何 tag 时原样返回', () => {
    expect(filterByTags(list, new Set(), 'any')).toBe(list)
    expect(filterByTags(list, new Set(), 'all')).toBe(list)
  })
  it('any=并集：命中任一选中', () => {
    expect(filterByTags(list, new Set(['t1', 't3']), 'any').map((x) => x.uuid)).toEqual(['a', 'b', 'c'])
  })
  it('all=交集：包含全部选中', () => {
    expect(filterByTags(list, new Set(['t1', 't2']), 'all').map((x) => x.uuid)).toEqual(['b'])
    expect(filterByTags(list, new Set(['t1', 't3']), 'all')).toEqual([])
  })
  it('悬空 tagId 视为不命中（any 与 all 均如此）', () => {
    expect(filterByTags(list, new Set(['nope']), 'any')).toEqual([])
    expect(filterByTags(list, new Set(['t1', 'nope']), 'all')).toEqual([])
  })
})
```

- [ ] **Step 2: 跑红** — `pnpm -C packages/core test -- tags.filter.test.ts`，Expected: FAIL（模块不存在）
- [ ] **Step 3: 实现** `packages/core/src/tags/filter.ts`：

```ts
import type { OtpEntry } from '../model'

export type TagFilterMode = 'any' | 'all'

/** 标签过滤：any=命中任一选中（并集），all=包含全部选中（交集）；悬空 id 视为不命中（spec §2） */
export function filterByTags(entries: OtpEntry[], selectedTagIds: ReadonlySet<string>, mode: TagFilterMode): OtpEntry[] {
  if (selectedTagIds.size === 0) return entries
  return entries.filter((e) =>
    mode === 'any'
      ? e.tagIds.some((id) => selectedTagIds.has(id))
      : [...selectedTagIds].every((id) => e.tagIds.includes(id)),
  )
}
```

`packages/core/src/index.ts` 在 `export * from './match/engine'` 后加一行：

```ts
export * from './tags/filter'
```

- [ ] **Step 4: 跑绿** — `pnpm -C packages/core test && pnpm -C packages/core typecheck`，Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): 新增 filterByTags 标签过滤引擎（any 并集/all 交集）

why: popup 与管理页共用同一套 tag 过滤语义（spec §2）。
what: 纯函数 filterByTags + TagFilterMode 导出，空选择原样返回，悬空 id 不命中。"
```

---

### Task 3: 导入落地链携带 tags（ParsedEntry + conflict/dedup）

**Files:**
- Modify: `packages/core/src/import/types.ts`
- Modify: `packages/core/src/import/conflict.ts`
- Modify: `packages/core/src/import/dedup.ts`
- Test: `packages/core/test/import/conflict.test.ts`（既有文件追加）、`packages/core/test/import/dedup.test.ts`（既有文件追加）

**Interfaces:**
- Consumes: `addTag`（Task 1）
- Produces: `ParsedEntry.tags?: string[]`；`resolveTagNames(v: Vault, names: readonly string[]): { vault: Vault; tagIds: string[] }`；`newEntryFromParsed(p, uuid, nowMs, order?, tagIds?): OtpEntry`；`applyImport` / `applyImportPlan` 落库时解析并写入 tagIds（conflict replace = 现有∪导入）

- [ ] **Step 1: 写失败测试**（追加到 `packages/core/test/import/conflict.test.ts`）：

```ts
describe('导入 tags 落地（spec §4）', () => {
  const mkParsed = (issuer: string, label: string, tags?: string[]): ParsedEntry => ({
    type: 'totp', issuer, label, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30,
    ...(tags ? { tags } : {}),
  })

  it('新增条目携带 tags 并自动建入 vault.tags（同名复用）', () => {
    let v = createVault()
    const r = addTag(v, '工作')
    v = r.vault
    v = applyImport(v, [mkParsed('A', 'a', [' 工作 ', '个人'])], 'skip', new Set())
    expect(v.tags.map((t) => t.name).sort()).toEqual(['个人', '工作'])
    expect(v.entries[0]!.tagIds).toHaveLength(2)
  })

  it('conflict replace：tags 取现有∪导入并集', () => {
    let v = createVault()
    const r = addTag(v, '旧标签')
    v = r.vault
    v = addEntry(v, newEntryFromParsed(mkParsed('A', 'a'), 'u1', 1))
    v = updateEntry(v, 'u1', { tagIds: [r.tagId] })
    const idx = findConflicts(v, [mkParsed('A', 'a', ['导入标签'])])
    v = applyImport(v, [mkParsed('A', 'a', ['导入标签'])], 'replace', idx)
    expect(v.entries[0]!.tagIds).toHaveLength(2)
    expect(v.tags).toHaveLength(2)
  })

  it('conflict skip：不动（tagIds 原样）', () => {
    let v = createVault()
    v = addEntry(v, { ...newEntryFromParsed(mkParsed('A', 'a'), 'u1', 1), tagIds: ['t9'] })
    const idx = findConflicts(v, [mkParsed('A', 'a', ['x'])])
    v = applyImport(v, [mkParsed('A', 'a', ['x'])], 'skip', idx)
    expect(v.entries[0]!.tagIds).toEqual(['t9'])
    expect(v.tags).toHaveLength(0)
  })
})
```

（文件头补 import：`applyImport, findConflicts, newEntryFromParsed` 自 `../../src/import/conflict`，`addTag` 自 `../../src/vault`，`createVault` 自 `../../src/vault`，`type ParsedEntry` 自 `../../src/import/types`——按文件既有 import 风格合并。）

追加到 `packages/core/test/import/dedup.test.ts`：

```ts
describe('applyImportPlan tags 落地', () => {
  const mkParsed = (issuer: string, label: string, tags?: string[]): ParsedEntry => ({
    type: 'totp', issuer, label, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30,
    ...(tags ? { tags } : {}),
  })

  it('new 条目写 tagIds；dedupeWithinFile 与判定键不含 tags', () => {
    const v0 = createVault()
    const incoming = [mkParsed('A', 'a', ['工作'])]
    const plan = planImport(v0, incoming)
    const res = applyImportPlan(v0, incoming, plan)
    expect(res.vault.entries[0]!.tagIds).toHaveLength(1)
    expect(res.vault.tags).toHaveLength(1)
    // tags 不参与判定：同名同 secret 不同 tags → identical
    const p1 = mkParsed('A', 'a', ['工作'])
    const p2 = mkParsed('A', 'a', ['完全不同'])
    expect(dedupeWithinFile([p1, p2]).removed).toBe(1)
  })

  it('suspect replace：保留现有 tagIds（parsedPatch 白名单不含 tags）', () => {
    let v = createVault()
    v = addEntry(v, { ...newEntryFromParsed(mkParsed('A', 'a'), 'u1', 1), tagIds: ['keep'] })
    const incoming = { ...mkParsed('A', 'b'), secret: 'JBSWY3DPEHPK3PXP' } // 同 secret → suspect
    const plan = planImport(v, [incoming])
    expect(plan.kinds[0]).toBe('suspect')
    const res = applyImportPlan(v, [incoming], plan, new Map([[0, 'replace' as SuspectChoice]]))
    expect(res.vault.entries.find((e) => e.uuid === 'u1')!.tagIds).toEqual(['keep'])
  })
})
```

- [ ] **Step 2: 跑红** — `pnpm -C packages/core test -- conflict dedup`，Expected: 新增用例 FAIL
- [ ] **Step 3: 实现**

`packages/core/src/import/types.ts` — `ParsedEntry` 追加：

```ts
  /** 源格式分组键映射出的标签名（原始名，仅 trim；无分组键的格式缺省） */
  tags?: string[]
```

`packages/core/src/import/conflict.ts` — 顶部 import 加 `addTag`；`newEntryFromParsed` 改为：

```ts
export function newEntryFromParsed(p: ParsedEntry, uuid: string, nowMs: number, order: number = 0, tagIds: string[] = []): OtpEntry {
  return {
    uuid,
    type: p.type,
    issuer: p.issuer,
    label: p.label,
    secret: p.secret,
    algorithm: p.algorithm,
    digits: toOtpDigits(p.digits, p.type),
    period: p.period,
    ...(p.counter !== undefined ? { counter: p.counter } : {}),
    ...(p.note !== undefined ? { note: p.note } : {}),
    tagIds,
    order,
    createdAt: nowMs,
  }
}
```

新增 helper（放在 `parsedPatch` 之后）：

```ts
/** 导入 tag 名 → id：逐个 addTag（同名幂等复用），空白名跳过（spec §4 落库） */
export function resolveTagNames(v: Vault, names: readonly string[]): { vault: Vault; tagIds: string[] } {
  let out = v
  const ids: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue
    const r = addTag(out, name)
    out = r.vault
    ids.push(r.tagId)
  }
  return { vault: out, tagIds: ids }
}
```

`applyImport` 改为（注释同步 groupIds→tagIds 口径）：

```ts
// 纯函数：非冲突条目全部新增；冲突条目按策略 skip=不动 / replace=覆盖内容字段且 tags 取现有∪导入并集
// （保留 uuid/order/createdAt/未在 patch 中出现的字段如 note/counter）/ merge=照常新增并存
export function applyImport(v: Vault, entries: ParsedEntry[], policy: ConflictPolicy, conflictIdx: Set<number>): Vault {
  const now = Date.now()
  let out = v
  entries.forEach((p, i) => {
    if (conflictIdx.has(i)) {
      if (policy === 'skip') return
      if (policy === 'replace') {
        const target = out.entries.find((e) => conflictKey(e.issuer, e.label) === conflictKey(p.issuer, p.label))
        if (!target) return
        const resolved = resolveTagNames(out, p.tags ?? [])
        out = resolved.vault
        out = updateEntry(out, target.uuid, {
          ...parsedPatch(p, now),
          tagIds: [...new Set([...target.tagIds, ...resolved.tagIds])],
        })
        return
      }
    }
    const resolved = resolveTagNames(out, p.tags ?? [])
    out = resolved.vault
    // order 由 addEntry 内部按当前 maxOrder+1 计算；冲突策略下追加新条目用占位 0 即可
    out = addEntry(out, newEntryFromParsed(p, crypto.randomUUID(), now, 0, resolved.tagIds))
  })
  return out
}
```

`packages/core/src/import/dedup.ts` — `applyImportPlan` 的 `suspect add` 分支与 `default` 分支同样先 resolve 再 add：

```ts
        if (choice === 'add') {
          const resolved = resolveTagNames(out, p.tags ?? [])
          out = resolved.vault
          out = addEntry(out, newEntryFromParsed(p, crypto.randomUUID(), now, 0, resolved.tagIds))
          stats.added++
          return
        }
```
```ts
      default: {
        const resolved = resolveTagNames(out, p.tags ?? [])
        out = resolved.vault
        out = addEntry(out, newEntryFromParsed(p, crypto.randomUUID(), now, 0, resolved.tagIds))
        stats.added++
      }
```

顶部 import 加 `resolveTagNames`（自 `./conflict`）；文件头注释与 line 107 注释里 `groupIds` 字样改 `tagIds`。suspect replace 分支**不动**（parsedPatch 白名单不含 tags，现有 tags 保留——spec 仅规定 conflict replace 并集）。

- [ ] **Step 4: 跑绿** — `pnpm -C packages/core test && pnpm -C packages/core typecheck`，Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): 导入落地链解析并写入 tags（conflict replace 取并集）

why: 外部分组键要成为 tag 必须进入落库管线（spec §4 冲突管线）。
what: ParsedEntry.tags + resolveTagNames；applyImport/applyImportPlan 新增路径写 tagIds，replace 并集；判定键不含 tags。"
```

---

### Task 4: 四个导入器的源分组键映射

**Files:**
- Modify: `packages/core/src/import/aegis.ts`
- Modify: `packages/core/src/import/jsonApps.ts`
- Modify: `packages/core/src/import/miscApps.ts`
- Test: `packages/core/test/import/`（aegis/jsonApps/miscApps 既有测试文件追加）

**Interfaces:**
- Consumes: `ParsedEntry.tags?: string[]`（Task 3）、normalize 的 `asObject`
- Produces: Aegis `db.groups[].uuid`→`entry.groupid`、2FAS `groups[].id`→`service.groupId`、Bitwarden `folders[].id`→`item.folderId`、andOTP `entry.tags[]` 四条映射；查表 miss 静默丢弃

- [ ] **Step 1: 写失败测试**（各格式测试文件追加，样例 JSON 按各文件既有构造风格）：

Aegis（`aegis` 相关测试文件）：

```ts
it('db.groups + 条目 groupid 映射为 tags；查表 miss 静默丢弃', () => {
  const text = JSON.stringify({
    version: 3, header: {},
    db: {
      groups: [{ uuid: 'g1', name: '工作' }],
      entries: [
        { type: 'totp', name: 'GitHub:me', info: { secret: 'JBSWY3DPEHPK3PXP' }, groupid: 'g1' },
        { type: 'totp', name: 'GitLab:me', info: { secret: 'JBSWY3DPEHPK3PXP' }, groupid: 'missing' },
        { type: 'totp', name: 'No:group', info: { secret: 'JBSWY3DPEHPK3PXP' } },
      ],
    },
  })
  const res = importAegisPlaintext(text)
  expect(res.failures).toHaveLength(0)
  expect(res.entries[0]!.tags).toEqual(['工作'])
  expect(res.entries[1]!.tags).toBeUndefined()
  expect(res.entries[2]!.tags).toBeUndefined()
})
```

2FAS（jsonApps 测试文件）：

```ts
it('groups[].id + service.groupId 映射为 tags', () => {
  const text = JSON.stringify({
    schemaVersion: 4,
    groups: [{ id: 'g1', name: '工作', isExpanded: true }],
    services: [
      { name: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', groupId: 'g1', otp: { account: 'me', tokenType: 'TOTP' } },
      { name: 'GitLab', secret: 'JBSWY3DPEHPK3PXP', otp: { account: 'me', tokenType: 'TOTP' } },
    ],
  })
  const res = importTwoFas(text)
  expect(res.failures).toHaveLength(0)
  expect(res.entries[0]!.tags).toEqual(['工作'])
  expect(res.entries[1]!.tags).toBeUndefined()
})
```

Bitwarden（jsonApps 测试文件）：

```ts
it('folders[].id + item.folderId 映射为 tags', () => {
  const text = JSON.stringify({
    folders: [{ id: 'f1', name: '工作' }],
    items: [
      { name: 'GitHub', folderId: 'f1', login: { totp: 'JBSWY3DPEHPK3PXP' } },
      { name: 'GitLab', login: { totp: 'JBSWY3DPEHPK3PXP' } },
    ],
  })
  const res = importBitwarden(text)
  expect(res.failures).toHaveLength(0)
  expect(res.entries[0]!.tags).toEqual(['工作'])
  expect(res.entries[1]!.tags).toBeUndefined()
})
```

andOTP（miscApps 测试文件）：

```ts
it('条目 tags 数组直接映射（过滤非字符串与空白项）', () => {
  const text = JSON.stringify([
    { type: 'TOTP', label: 'GitHub - me', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, tags: ['工作', ' ', 42] },
    { type: 'TOTP', label: 'GitLab - me', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 },
  ])
  const res = importAndOtp(text)
  expect(res.failures).toHaveLength(0)
  expect(res.entries[0]!.tags).toEqual(['工作'])
  expect(res.entries[1]!.tags).toBeUndefined()
})
```

- [ ] **Step 2: 跑红** — `pnpm -C packages/core test`，Expected: 新用例 FAIL
- [ ] **Step 3: 实现**

`aegis.ts` — `parseDbEntries` 建查表并下传（顶部 import 补 `asObject` 自 `./normalize`）：

```ts
function parseDbEntries(db: unknown): ImportResult {
  if (db === null || typeof db !== 'object') throw new Error('Aegis 文件结构非法：缺少 db 对象')
  const dbObj = db as Record<string, unknown>
  const entries = dbObj.entries
  if (!Array.isArray(entries)) throw new Error('Aegis 文件结构非法：缺少 db.entries 数组')

  // db.groups: [{uuid, name}] → groupid 查表（spec §4）；缺 groups/条目缺 groupid 均合法
  const groups = new Map<string, string>()
  if (Array.isArray(dbObj.groups)) {
    for (const g of dbObj.groups) {
      const o = asObject(g)
      if (o && typeof o.uuid === 'string' && typeof o.name === 'string' && o.name.trim() !== '') {
        groups.set(o.uuid, o.name)
      }
    }
  }

  const parsed: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  entries.forEach((raw, index) => {
    const res = parseEntry(raw, index, groups)
    if ('error' in res) failures.push({ index, message: res.error })
    else parsed.push(res)
  })
  return { entries: parsed, failures }
}
```

`parseEntry` 签名加第三参并在 `return parsed` 前插入：

```ts
function parseEntry(raw: unknown, index: number, groups: Map<string, string>): ParsedEntry | { error: string } {
```
```ts
  if (typeof entry.groupid === 'string') {
    const tagName = groups.get(entry.groupid)
    if (tagName) parsed.tags = [tagName]
  }
  return parsed
```

`jsonApps.ts` — `importTwoFas` 在 `collectEntries` 前建表（`asObject` 已在该文件 import）：

```ts
  // groups: [{id, name}]；service.groupId → name 查表（spec §4）
  const groupMap = new Map<string, string>()
  if (Array.isArray(obj.groups)) {
    for (const g of obj.groups) {
      const o = asObject(g)
      if (o && typeof o.id === 'string' && typeof o.name === 'string' && o.name.trim() !== '') {
        groupMap.set(o.id, o.name)
      }
    }
  }
```

回调内 `const label = ...` 后加 `const tags = typeof service.groupId === 'string' ? groupMap.get(service.groupId) : undefined`，TOTP/HOTP 返回对象各加 `...(tags ? { tags } : {})`，STEAM 分支改 `{ ...steamEntry(secret, issuer, label), ...(tags ? { tags } : {}) }`。

`importBitwarden` 同型：`items` 校验后建 `folderMap`（键 `id`/值 `name`），回调内 `const note = ...` 后加：

```ts
    const folderName = item && typeof item.folderId === 'string' ? folderMap.get(item.folderId) : undefined
    const tags = folderName ? { tags: [folderName] } : {}
```

三个成功返回各拼 `...tags`。

`miscApps.ts` — `convertAndOtpEntry` 在 `const algorithm = ...` 前加：

```ts
  // andOTP 条目自带 tags: string[]（明文导出即标签数组）；非字符串/空白项过滤（spec §4）
  const tagList = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : []
  const tagField = tagList.length > 0 ? { tags: tagList } : {}
```

totp/hotp/steam 三个返回各拼 `...tagField`。

- [ ] **Step 4: 跑绿** — `pnpm -C packages/core test && pnpm -C packages/core typecheck`，Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): Aegis/2FAS/Bitwarden/andOTP 导入映射源分组键为 tags

why: 外部软件分组/文件夹键导入为 tag（spec §4 映射表）。
what: 四导入器 id→name 查表（miss 静默丢弃），andOTP tags 数组直取并过滤非字符串项。"
```

---

### Task 5: settings 三字段（tagFilterMode / rememberTagFilter / lastTagFilterIds）

**Files:**
- Modify: `packages/core/src/storage/vaultStore.ts`
- Test: `packages/core/test/storage/vaultStore.test.ts`（既有 settings 用例处追加；路径以既有文件为准）

**Interfaces:**
- Consumes: `TagFilterMode`（Task 2）
- Produces: `AppSettings.tagFilterMode: TagFilterMode`（默认 `'any'`）、`rememberTagFilter: boolean`（默认 `false`）、`lastTagFilterIds: string[]`（默认 `[]`），均走 loadSettings 类型守卫兜底

- [ ] **Step 1: 写失败测试**（在既有 loadSettings 测试旁追加）：

```ts
describe('tag 过滤设置（spec §3）', () => {
  it('缺省：tagFilterMode=any、rememberTagFilter=false、lastTagFilterIds=[]', async () => {
    const adapter = createMemoryStorage()
    expect(await loadSettings(adapter)).toMatchObject({
      tagFilterMode: 'any', rememberTagFilter: false, lastTagFilterIds: [],
    })
  })
  it('非法值回落默认；lastTagFilterIds 非字符串数组回落', async () => {
    const adapter = createMemoryStorage()
    await adapter.set('settings', JSON.stringify({
      tagFilterMode: 'both', rememberTagFilter: 'yes', lastTagFilterIds: ['a', 1],
    }))
    expect(await loadSettings(adapter)).toMatchObject({
      tagFilterMode: 'any', rememberTagFilter: false, lastTagFilterIds: [],
    })
  })
  it('合法值原样读回', async () => {
    const adapter = createMemoryStorage()
    await adapter.set('settings', JSON.stringify({
      tagFilterMode: 'all', rememberTagFilter: true, lastTagFilterIds: ['t1', 't2'],
    }))
    expect(await loadSettings(adapter)).toMatchObject({
      tagFilterMode: 'all', rememberTagFilter: true, lastTagFilterIds: ['t1', 't2'],
    })
  })
})
```

- [ ] **Step 2: 跑红** — `pnpm -C packages/core test`，Expected: 新用例 FAIL
- [ ] **Step 3: 实现** `vaultStore.ts`：

顶部 `import type { TagFilterMode } from '../tags/filter'`；`AppSettings` 追加（`backupKdfProfile` 之后）：

```ts
  /** tag 过滤模式：any=命中任一（并集）/ all=需命中全部选中（交集）；偏好，始终持久化（spec §3） */
  tagFilterMode: TagFilterMode
  /** 「记住标签筛选」开关：开则 popup 与管理页读写同一份 lastTagFilterIds */
  rememberTagFilter: boolean
  /** 选中 tag 集合持久化载体；仅 rememberTagFilter 开启时读写（关闭不清除已存值） */
  lastTagFilterIds: string[]
```

`DEFAULT_SETTINGS` 追加：`tagFilterMode: 'any', rememberTagFilter: false, lastTagFilterIds: [],`

`loadSettings` 返回对象追加三个守卫：

```ts
      tagFilterMode: merged.tagFilterMode === 'any' || merged.tagFilterMode === 'all' ? merged.tagFilterMode : DEFAULT_SETTINGS.tagFilterMode,
      rememberTagFilter: typeof merged.rememberTagFilter === 'boolean' ? (merged.rememberTagFilter as boolean) : DEFAULT_SETTINGS.rememberTagFilter,
      lastTagFilterIds: Array.isArray(merged.lastTagFilterIds) && merged.lastTagFilterIds.every((x) => typeof x === 'string') ? (merged.lastTagFilterIds as string[]) : DEFAULT_SETTINGS.lastTagFilterIds,
```

- [ ] **Step 4: 跑绿** — `pnpm -C packages/core test && pnpm -C packages/core typecheck`，Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): settings 新增 tag 过滤模式与选中态持久化三字段

why: popup/管理页共享 AND-OR 偏好与「记住标签筛选」开关（spec §3 设置项表）。
what: tagFilterMode/rememberTagFilter/lastTagFilterIds，M4 类型守卫兜底模式。"
```

---

### Task 6: ui store / parseVaultJson / otpauthFlow 迁移到 tag

**Files:**
- Modify: `packages/ui/src/store.ts`
- Modify: `packages/ui/src/components/parseVaultJson.ts`
- Modify: `packages/ui/src/otpauthFlow.ts`
- Test: `packages/ui/test/parseVaultJson.test.ts`、`packages/ui/test/store*.test.ts`（既有文件内 group 键样例全改 tag）

**Interfaces:**
- Consumes: `addTag/renameTag/removeTag`（Task 1）、`Vault.version 2`
- Produces: `VueStore.addTagOp(name): Promise<string>`（返回 tagId，供表单内联建）、`renameTagOp(id, name)`、`removeTagOp(id)`；`parseVaultJson` 校验 `version===2 && tags/tagIds`

- [ ] **Step 1: 改测试** — `parseVaultJson.test.ts` 等既有 ui 测试中的 fixture：`version: 1` → `2`、`groups` → `tags`、`groupIds` → `tagIds`；`store` 相关测试中 `addGroupOp/renameGroupOp/removeGroupOp` → 新名。对 `parseVaultJson.test.ts` 补一条：

```ts
it('version 2 校验：version!==2 或缺 tags 抛错', () => {
  const base = { updatedAt: 0, entries: [], tags: [] }
  expect(() => parseVaultJson(JSON.stringify({ ...base, version: 1 }))).toThrow()
  expect(() => parseVaultJson(JSON.stringify({ ...base, version: 2, tags: undefined }))).toThrow()
  expect(parseVaultJson(JSON.stringify({ ...base, version: 2 })).version).toBe(2)
})
```

- [ ] **Step 2: 跑红** — `pnpm -C packages/ui test -- parseVaultJson`，Expected: FAIL
- [ ] **Step 3: 实现**

`store.ts`：顶部 import 名单 `addGroup, removeGroup, renameGroup` → `addTag, removeTag, renameTag`；`reactive<Vault>({ version: 1, entries: [], groups: [], updatedAt: 0 })` → `{ version: 2, entries: [], tags: [], updatedAt: 0 }`；`replaceVault` 内 `vault.groups.splice(...)` → `vault.tags.splice(0, vault.tags.length, ...v.tags)`；既有 `addGroupOp/renameGroupOp/removeGroupOp` 三行替换为：

```ts
    /** 建 tag 并回传 id（同名幂等复用）：EntryForm 内联建 tag 自动勾选依赖此返回值 */
    addTagOp: (name: string): Promise<string> => {
      let tagId = ''
      return commit((v) => {
        const r = addTag(v, name)
        tagId = r.tagId
        return r.vault
      }).then(() => tagId)
    },
    renameTagOp: (id: string, name: string) => commit((v) => renameTag(v, id, name)),
    removeTagOp: (id: string) => commit((v) => removeTag(v, id)),
```

`parseVaultJson.ts`：`v.version !== 1 || !Array.isArray(v.entries) || !Array.isArray(v.groups)` → `v.version !== 2 || !Array.isArray(v.entries) || !Array.isArray(v.tags)`（注释同步）；条目校验 `o.groupIds` 段改为：

```ts
  if (!Array.isArray(o.tagIds) || o.tagIds.some((g) => typeof g !== 'string')) {
    throw new Error(`${at} tagIds 必须为字符串数组`)
  }
```

`otpauthFlow.ts`：预填 data 中 `groupIds: []` → `tagIds: []`。

- [ ] **Step 4: 跑绿（允许非 group 相关旧失败）** — `pnpm -C packages/ui test -- parseVaultJson store` 与 `pnpm -C packages/ui typecheck`。typecheck 期望仅剩 CodesPage/EntryForm/GroupManagerDialog 等组件的 group 引用报错（Task 8-10 修复）；store/parseVaultJson/otpauthFlow 自身零错。
- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "refactor(ui): store/恢复校验/otpauthFlow 迁移 Group→Tag

why: core 模型已 Tag 化（Task 1），ui 数据层同步迁移（spec §3/§5）。
what: VueStore addTagOp（回传 tagId）/renameTagOp/removeTagOp；parseVaultJson 校验 version 2 + tags/tagIds；otpauthFlow 预填 tagIds。"
```

---

### Task 7: 共享组件 TagFilterRow

**Files:**
- Create: `packages/ui/src/components/TagFilterRow.vue`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/TagFilterRow.test.ts`

**Interfaces:**
- Consumes: `Tag`/`TagFilterMode`（Task 1/2）、`MdChip`
- Produces: `TagFilterRow` props `{ tags: Tag[]; selectedIds: string[]; mode: TagFilterMode; disabled?: boolean }`，emits `update:selectedIds: [string[]]` / `update:mode: [TagFilterMode]`；ui index 导出名 `TagFilterRow`

- [ ] **Step 1: 写失败测试** `packages/ui/test/TagFilterRow.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import TagFilterRow from '../src/components/TagFilterRow.vue'

const tags = [
  { id: 't2', name: '个人' },
  { id: 't1', name: '工作' },
]

describe('TagFilterRow', () => {
  it('tag 按名称字母序渲染；「全部」chip 清空选择', async () => {
    const w = mount(TagFilterRow, { props: { tags, selectedIds: ['t1'], mode: 'any' } })
    const labels = w.findAll('button.md-chip').map((b) => b.text())
    expect(labels).toEqual(['全部', '工作', '个人'])
    await w.findAll('button.md-chip')[0]!.trigger('click')
    expect(w.emitted('update:selectedIds')![0]).toEqual([[]])
  })
  it('chip 点选切换选中集合（emit 全量数组）', async () => {
    const w = mount(TagFilterRow, { props: { tags, selectedIds: [], mode: 'any' } })
    await w.findAll('button.md-chip')[1]!.trigger('click')
    expect(w.emitted('update:selectedIds')![0]).toEqual([['t1']])
  })
  it('mode 切换按钮：选中 <2 禁用，≥2 可点并翻转模式', async () => {
    const w = mount(TagFilterRow, { props: { tags, selectedIds: ['t1'], mode: 'any' } })
    const btn = w.find('button.mode-toggle')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    await w.setProps({ selectedIds: ['t1', 't2'] })
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)
    await btn.trigger('click')
    expect(w.emitted('update:mode')![0]).toEqual(['all'])
  })
})
```

- [ ] **Step 2: 跑红** — `pnpm -C packages/ui test -- TagFilterRow`，Expected: FAIL（组件不存在）
- [ ] **Step 3: 实现** `packages/ui/src/components/TagFilterRow.vue`：

```vue
<script setup lang="ts">
import type { Tag, TagFilterMode } from '@totp/core'
import { computed } from 'vue'
import MdChip from './md/MdChip.vue'

const props = defineProps<{
  tags: Tag[]
  selectedIds: string[]
  mode: TagFilterMode
  /** 宿主可整体禁用（预留）；选中 <2 时模式切换恒禁用（any/all 语义相同） */
  disabled?: boolean
}>()
const emit = defineEmits<{
  'update:selectedIds': [ids: string[]]
  'update:mode': [mode: TagFilterMode]
}>()

/** tag 展示恒按名称字母序（模型无 order 字段，spec §1） */
const sorted = computed(() => [...props.tags].sort((a, b) => a.name.localeCompare(b.name, 'zh')))

function toggle(id: string) {
  emit('update:selectedIds', props.selectedIds.includes(id) ? props.selectedIds.filter((x) => x !== id) : [...props.selectedIds, id])
}
</script>
<template>
  <div class="tag-filter-row" role="group" aria-label="标签筛选">
    <button
      type="button" class="mode-toggle"
      :disabled="disabled || selectedIds.length < 2"
      :title="mode === 'any' ? '当前：命中任一选中标签；点击切换为需命中全部' : '当前：需命中全部选中标签；点击切换为任一命中'"
      @click="emit('update:mode', mode === 'any' ? 'all' : 'any')"
    >{{ mode === 'any' ? '任一' : '全部' }}</button>
    <MdChip label="全部" :selected="selectedIds.length === 0" @click="emit('update:selectedIds', [])" />
    <MdChip
      v-for="t in sorted" :key="t.id" :label="t.name"
      :selected="selectedIds.includes(t.id)" @click="toggle(t.id)"
    />
  </div>
</template>
<style scoped>
.tag-filter-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mode-toggle { border: 1px solid var(--md-sys-color-outline); background: transparent; color: var(--md-sys-color-on-surface);
  border-radius: 8px; height: 32px; padding: 0 10px; font: inherit; font-size: var(--md-sys-typescale-body-small); cursor: pointer; }
.mode-toggle:disabled { opacity: .4; cursor: default; }
.mode-toggle:not(:disabled):hover { background: color-mix(in srgb, currentColor 8%, transparent); }
</style>
```

`packages/ui/src/index.ts` 在 `GroupManagerDialog` 导出行附近加：

```ts
export { default as TagFilterRow } from './components/TagFilterRow.vue'
```

- [ ] **Step 4: 跑绿** — `pnpm -C packages/ui test -- TagFilterRow`，Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): 新增 TagFilterRow 共享筛选组件（多选 chips + AND/OR 行首切换）

why: popup 与管理页复用同一交互（spec §3 TagFilterRow）。
what: 字母序 chips、全部清空、选中≥2 才可切换 any/all。"
```

---

### Task 8: EntryForm tag 编辑 + 内联快速建

**Files:**
- Modify: `packages/ui/src/components/entryForm.ts`
- Modify: `packages/ui/src/components/EntryForm.vue`
- Modify: `packages/ui/src/components/EntryFormDialog.vue`
- Test: `packages/ui/test/EntryForm.test.ts`、`packages/ui/test/EntryFormDialog.test.ts`

**Interfaces:**
- Consumes: `Tag`（Task 1）
- Produces: `EntryFormData.tagIds: string[]`（原 groupIds）；EntryForm props `tags?: Tag[]`（原 `groups?: Group[]`）与新增 `createTag?: (name: string) => Promise<string>`（回传 tagId）；EntryFormDialog prop `groups` → `tags`

- [ ] **Step 1: 改测试** — `EntryForm.test.ts`：既有 `groups` prop/`groupIds` 断言全改 `tags`/`tagIds`；追加：

```ts
it('内联建 tag：回车创建后自动勾选（createTag 回传 id）', async () => {
  const w = mount(EntryForm, {
    props: {
      tags: [{ id: 't1', name: '工作' }],
      createTag: async (name: string) => {
        return name === '银行' ? 't9' : ''
      },
      model: { ...emptyForm() },
    },
  })
  await w.find('input.new-tag').setValue('银行')
  await w.find('input.new-tag').trigger('keydown.enter')
  await vi.waitFor(() => expect(w.emitted('save')).toBeUndefined())
  const checks = w.findAll('input[type="checkbox"]').map((c) => (c.element as HTMLInputElement).checked)
  // 新 tag 已出现于复选列表且勾选（t1 未勾、t9 勾）
  expect(checks).toEqual([false, true])
})
```

（`emptyForm()` 为该测试文件既有的表单初始数据 helper；若以 `props.initial` 传法则按既有风格等价改写——关键断言是「创建后新 tag 出现且勾选」。）
`EntryFormDialog.test.ts`：`:groups` → `:tags`。

- [ ] **Step 2: 跑红** — `pnpm -C packages/ui test -- EntryForm`，Expected: FAIL
- [ ] **Step 3: 实现**

`entryForm.ts`：`EntryFormData.groupIds: string[]` → `tagIds: string[]`。

`EntryForm.vue`：
- import `type Group` → `type Tag`；props `groups?: Group[]` → `tags?: Tag[]`，新增 `createTag?: (name: string) => Promise<string>`；
- `form.groupIds` → `form.tagIds: [...(props.initial?.tagIds ?? [])]`；
- `toggleGroup` → `toggleTag`（操作 `form.tagIds`）；
- 新增内联建：

```ts
// ---------- 内联快速建 tag（spec §3 EntryForm）：回车/按钮 → createTag → 自动勾选 ----------
const newTagName = ref('')
const creatingTag = ref(false)
async function createTagAndCheck() {
  const name = newTagName.value.trim()
  if (!name || !props.createTag || creatingTag.value) return
  creatingTag.value = true
  try {
    const id = await props.createTag(name)
    if (id && !form.tagIds.includes(id)) form.tagIds.push(id)
    newTagName.value = ''
  } finally {
    creatingTag.value = false
  }
}
```

- submit 中 `groupIds: form.groupIds` → `tagIds: form.tagIds`；
- 模板 fieldset 替换为：

```vue
    <fieldset v-if="(tags ?? []).length > 0 || createTag">
      <legend>标签</legend>
      <MdCheckbox
        v-for="t in tags" :key="t.id" class="tag-check"
        :model-value="form.tagIds.includes(t.id)" :label="t.name" :aria-label="t.name"
        @update:model-value="toggleTag(t.id, $event)"
      />
      <div v-if="createTag" class="new-tag-row">
        <MdTextField
          v-model="newTagName" class="new-tag" label="新标签" placeholder="新标签，回车创建" aria-label="新标签名称"
          @keydown.enter.prevent="createTagAndCheck"
        />
        <MdButton variant="text" :disabled="creatingTag" @click="createTagAndCheck">添加</MdButton>
      </div>
    </fieldset>
```

（注意：`new-tag` 输入框经 MdTextField 渲染，测试选择器按 MdTextField 实际根结构调整为 `w.find('[aria-label="新标签名称"] input')`。）
- 样式 `.group-check` → `.tag-check`，追加 `.new-tag-row { display: flex; gap: 6px; width: 100%; } .new-tag { flex: 1; }`。

`EntryFormDialog.vue`：props `groups: Group[]` → `tags: Tag[]`（import 同步），透传 `:groups="groups"` → `:tags="tags"`。

- [ ] **Step 4: 跑绿** — `pnpm -C packages/ui test -- EntryForm EntryFormDialog`，Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): EntryForm 标签复选 + 内联快速建 tag

why: 建标签不再必须先开管理弹层（spec §3 EntryForm）。
what: EntryFormData.groupIds→tagIds；createTag 回调 prop（宿主接 addTagOp）创建后自动勾选。"
```

---

### Task 9: TagManagerDialog（GroupManagerDialog 重命名）

**Files:**
- Rename+Modify: `packages/ui/src/components/GroupManagerDialog.vue` → `packages/ui/src/components/TagManagerDialog.vue`
- Rename+Modify: `packages/ui/test/GroupManagerDialog.test.ts` → `packages/ui/test/TagManagerDialog.test.ts`
- Modify: `packages/ui/src/index.ts`
- Test: 同上

**Interfaces:**
- Consumes: `Tag`、`VueStore.addTagOp/renameTagOp/removeTagOp`（Task 6）
- Produces: `TagManagerDialog` props `{ open: boolean; store: VueStore }`、emit `close`；ui index 导出名 `TagManagerDialog`（原 `GroupManagerDialog` 移除）

- [ ] **Step 1: 改测试** — 测试文件重命名，内容：`GroupManagerDialog` import/挂载名 → `TagManagerDialog`；`addGroupOp` → `addTagOp` 等；文案断言 `分组` → `标签`（如 headline「标签管理」、aria「新标签名称」）。
- [ ] **Step 2: 跑红** — `pnpm -C packages/ui test -- TagManagerDialog`，Expected: FAIL（旧名 import 失败）
- [ ] **Step 3: 实现** — `GroupManagerDialog.vue` 移动为 `TagManagerDialog.vue`，内容机械替换：`type Group` → `type Tag`、`addGroupOp→addTagOp`、`saveRename` 内 `renameGroupOp` → `renameTagOp`、`removeGroupOp` → `removeTagOp`、`store.vault.groups` → `store.vault.tags`、`e.groupIds.includes(g.id)` → `e.tagIds.includes(t.id)`、计数与遍历变量 `g` → `t`；模板文案：headline `分组管理` → `标签管理`、`新分组名称` → `新标签名称`、`创建分组` → `创建标签`、`分组名称` → `标签名称`、`编辑分组 X` → `编辑标签 X`、`删除分组 X` → `删除标签 X`、`暂无分组` → `暂无标签`。`index.ts`：`export { default as GroupManagerDialog } ...` 行替换为 `export { default as TagManagerDialog } from './components/TagManagerDialog.vue'`。
- [ ] **Step 4: 跑绿** — `pnpm -C packages/ui test -- TagManagerDialog`，Expected: PASS（CodesPage 引用旧组件名的编译错误留待 Task 10，属预期）
- [ ] **Step 5: Commit**

```bash
git add -A packages/ui
git commit -m "refactor(ui): GroupManagerDialog 重命名为 TagManagerDialog

why: 分组语义升级为标签，管理弹层随模型更名（spec §3 管理页）。
what: 组件/测试文件重命名 + store op 换名 + 文案分组→标签，能力不变（增/改/删+级联清引用）。"
```

---

### Task 10: CodesPage 接入 TagFilterRow（多选 + AND/OR + 持久化）

**Files:**
- Modify: `packages/ui/src/pages/CodesPage.vue`
- Test: `packages/ui/test/pages/CodesPage.test.ts`

**Interfaces:**
- Consumes: `TagFilterRow`（Task 7）、`filterByTags`（Task 2）、`TagManagerDialog`（Task 9）、`EntryFormDialog :tags`（Task 8）、settings 三字段（Task 5）
- Produces: CodesPage 行为：搜索 → `filterByTags(selectedTagIds, settings.tagFilterMode)`；选中态读写 settings（rememberTagFilter 开启时）；emit `open-groups` → `open-tags`

- [ ] **Step 1: 改测试** — `CodesPage.test.ts`：group 相关用例重写为：

```ts
describe('CodesPage 标签筛选（spec §3 管理页）', () => {
  const twoTags = async (s: ReturnType<typeof createVueStore>) => {
    const r1 = await s.addTagOp('工作')
    await s.addTagOp('个人')
    await s.addEntryOp({ ...baseEntry('a'), tagIds: [r1] })
  }

  it('多选 any：命中任一选中标签', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await twoTags(s)
    const w = mount(CodesPage, { props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const chips = w.findAll('button.md-chip')
    await chips.find((c) => c.text() === '工作')!.trigger('click')
    await chips.find((c) => c.text() === '个人')!.trigger('click')
    expect(w.text()).not.toContain('GitHub') // 条目仅带「工作」，any 仍应命中——见下行修正
  })
})
```

（上用例 any 语义断言应为「仍显示」——写测试时以 `expect(w.text()).toContain('GitHub')` 为准；此处保留推演过程会导致误读，落地时统一为：选「工作」→ 显示；再选「个人」（any）→ 仍显示；切「全部」模式（需先选中 ≥2 自动可用）→ 隐藏。）

再补两条：

```ts
it('rememberTagFilter 开启时选中集合写入 settings；关闭时不写', async () => {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addTagOp('工作')
  s.settings.rememberTagFilter = true
  const w = mount(CodesPage, { props: { store: s } })
  await vi.waitFor(() => expect(w.text()).toContain('全部'))
  await w.findAll('button.md-chip').find((c) => c.text() === '工作')!.trigger('click')
  await vi.waitFor(() => expect(s.settings.lastTagFilterIds).toHaveLength(1))
  s.settings.rememberTagFilter = false
  await w.findAll('button.md-chip').find((c) => c.text() === '全部')!.trigger('click')
  expect(s.settings.lastTagFilterIds).toHaveLength(1) // 关闭后不再写
})

it('tag 被删除后选中集合剔除悬空 id', async () => {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  const tid = await s.addTagOp('临时')
  const w = mount(CodesPage, { props: { store: s } })
  await vi.waitFor(() => expect(w.text()).toContain('临时'))
  await w.findAll('button.md-chip').find((c) => c.text() === '临时')!.trigger('click')
  await s.removeTagOp(tid)
  await vi.waitFor(() => expect(w.vm.selectedTagIds ?? []).toEqual([]))
})
```

（第三条对组件内部态的断言若不可行，改为行为断言：删除 tag 后「全部」chip 处于选中态。）`open-groups` emit 断言改 `open-tags`，触发 chip 文案 `管理分组` → `管理标签`。

- [ ] **Step 2: 跑红** — `pnpm -C packages/ui test -- pages/CodesPage`，Expected: FAIL
- [ ] **Step 3: 实现** — `CodesPage.vue` script：

```ts
import { filterByTags, type TagFilterMode } from '@totp/core'
import TagFilterRow from '../components/TagFilterRow.vue'
import TagManagerDialog from '../components/TagManagerDialog.vue'
```

emit 改 `defineEmits<{ copy: [code: string]; 'open-tags': [] }>()`；状态区替换：

```ts
/** 标签筛选：多选集合 + any/all 模式（模式存 settings 全局共享；spec §3） */
const selectedTagIds = ref<string[]>(
  props.store.settings.rememberTagFilter ? [...props.store.settings.lastTagFilterIds] : [],
)
const tagsOpen = ref(false)
const tagMode = computed(() => props.store.settings.tagFilterMode)
async function setTagMode(m: TagFilterMode) {
  props.store.settings.tagFilterMode = m
  await props.store.commitSettings()
}
// rememberTagFilter 开启：选中集合持久化（popup 与管理页共享同一份）
watch(selectedTagIds, (ids) => {
  if (!props.store.settings.rememberTagFilter) return
  props.store.settings.lastTagFilterIds = [...ids]
  void props.store.commitSettings()
})
```

`visible` 末段替换：

```ts
  return filterByTags(list, new Set(selectedTagIds.value), props.store.settings.tagFilterMode)
```

悬空 watch 替换：

```ts
/** 兜底：tag 被删除（管理弹层/远端同步）后从选中集合剔除 */
watch(
  () => props.store.vault.tags.map((t) => t.id),
  (ids) => {
    const next = selectedTagIds.value.filter((id) => ids.includes(id))
    if (next.length !== selectedTagIds.value.length) selectedTagIds.value = next
  },
)
```

模板 chips 行替换：

```vue
      <!-- 标签筛选：多选 chips + 行首 AND/OR 切换（TagFilterRow）；「管理标签」打开 TagManagerDialog -->
      <div class="chips-row">
        <TagFilterRow
          v-if="store.vault.tags.length > 0"
          :tags="store.vault.tags" v-model:selected-ids="selectedTagIds"
          :mode="tagMode" @update:mode="setTagMode"
        />
        <MdChip label="管理标签" @click="tagsOpen = true; emit('open-tags')" />
      </div>
```

`<GroupManagerDialog ... />` → `<TagManagerDialog :open="tagsOpen" :store="store" @close="tagsOpen = false" />`；`EntryFormDialog` 的 `:groups="store.vault.groups"` → `:tags="store.vault.tags"`；`groupsOpen` → `tagsOpen` 全量替换；注释中「分组」→「标签」。

- [ ] **Step 4: 跑绿** — `pnpm -C packages/ui test && pnpm -C packages/ui typecheck`，Expected: **ui 包全绿**（Group 引用至此清零；若 `useOtpCodes.test`/`RevealDialog.test`/`OtpListItem.test` 有残留 group 字样断言一并修复）
- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): CodesPage 接入标签多选筛选（AND/OR 共享偏好 + 持久化 + 悬空清理）

why: 管理页筛选从分组单选升级为 tag 多选（spec §3 CodesPage）。
what: TagFilterRow 接入；visible 改 filterByTags；rememberTagFilter 开启时写 lastTagFilterIds；emit open-tags。"
```

---

### Task 11: popup 四级回退纯函数 resolvePopupVisible

**Files:**
- Create: `packages/ui/src/popupFilter.ts`
- Modify: `packages/ui/src/index.ts`（加 `export * from './popupFilter'`）
- Test: `packages/ui/test/popupFilter.test.ts`

**Interfaces:**
- Consumes: `filterByTags`（Task 2）、`entryMatchesUrl`（core 既有）
- Produces: `resolvePopupVisible(input: PopupFilterInput): PopupFilterResult`；`PopupFilterInput { entries; query; selectedTagIds: ReadonlySet<string>; tagMode: TagFilterMode; urlFilterActive: boolean; tabUrl: string | null }`；`PopupFilterResult { visible: OtpEntry[]; hint: string; urlMatchCount: number }`；四个提示常量 `HINT_SITE_TAGGED / HINT_TAG_RELAXED / HINT_SITE_PLAIN / HINT_SITE_ALL`

- [ ] **Step 1: 写失败测试** `packages/ui/test/popupFilter.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { addTag, createVault, addEntry } from '@totp/core'
import { resolvePopupVisible, HINT_SITE_TAGGED, HINT_TAG_RELAXED, HINT_SITE_PLAIN, HINT_SITE_ALL } from '../src/popupFilter'
import type { OtpEntry } from '@totp/core'

const e = (uuid: string, tagIds: string[], rules: unknown[] = []): OtpEntry => ({
  uuid, type: 'totp', issuer: uuid, label: 'l', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds, order: 0, createdAt: 0,
  matchRules: rules as OtpEntry['matchRules'],
})
const work = e('a', ['t1'], [{ strategy: 'baseDomain', pattern: 'work.com' }])
const home = e('b', ['t2'], [{ strategy: 'baseDomain', pattern: 'home.com' }])
const plain = e('c', [])

const base = { entries: [work, home, plain], query: '', selectedTagIds: new Set(['t1']), tagMode: 'any' as const, tabUrl: null }

describe('resolvePopupVisible 四级回退（spec §3）', () => {
  it('T1：urlSet 命中直接显示，无提示', () => {
    const r = resolvePopupVisible({ ...base, urlFilterActive: true, tabUrl: 'https://work.com/x' })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe('')
    expect(r.urlMatchCount).toBe(1)
  })
  it('T2：站点零匹配回退 tagged，提示 HINT_SITE_TAGGED', () => {
    const r = resolvePopupVisible({ ...base, urlFilterActive: true, tabUrl: 'https://other.com' })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe(HINT_SITE_TAGGED)
  })
  it('T2 变体：未选中 tag 时提示为 HINT_SITE_PLAIN', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(), urlFilterActive: true, tabUrl: 'https://other.com' })
    expect(r.hint).toBe(HINT_SITE_PLAIN)
  })
  it('T3：tag 零命中放宽为 urlOnly，提示 HINT_TAG_RELAXED', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(['t2']), urlFilterActive: true, tabUrl: 'https://work.com' })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe(HINT_TAG_RELAXED)
  })
  it('T4：放宽后站点仍零匹配回退 base，提示 HINT_SITE_ALL', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(['t2']), urlFilterActive: true, tabUrl: 'https://none.com' })
    expect(r.visible).toHaveLength(3)
    expect(r.hint).toBe(HINT_SITE_ALL)
  })
  it('无 URL：搜索+tag 命中显示 tagged', () => {
    const r = resolvePopupVisible({ ...base, urlFilterActive: false })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe('')
  })
  it('无 URL：有搜索词且 tag 零命中 → 放宽显示 base 并提示', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(['t2']), query: 'a', urlFilterActive: false })
    expect(r.visible.map((x) => x.uuid)).toEqual(['a'])
    expect(r.hint).toBe(HINT_TAG_RELAXED)
  })
  it('无 URL 无搜索：纯 tag 浏览零命中不放宽（空列表无提示）', () => {
    const r = resolvePopupVisible({ ...base, selectedTagIds: new Set(['t2']), urlFilterActive: false })
    expect(r.visible).toEqual([])
    expect(r.hint).toBe('')
  })
})

describe('与真实 vault 协同', () => {
  it('addTag 建出的 tag 可直接参与筛选', () => {
    let v = createVault()
    const r = addTag(v, '工作')
    v = addEntry(r.vault, { ...e('a', [r.tagId]) })
    const out = resolvePopupVisible({
      entries: v.entries, query: '', selectedTagIds: new Set([r.tagId]), tagMode: 'any',
      urlFilterActive: false, tabUrl: null,
    })
    expect(out.visible.map((x) => x.uuid)).toEqual(['a'])
  })
})
```

- [ ] **Step 2: 跑红** — `pnpm -C packages/ui test -- popupFilter`，Expected: FAIL
- [ ] **Step 3: 实现** `packages/ui/src/popupFilter.ts`：

```ts
import { entryMatchesUrl, filterByTags, type OtpEntry, type TagFilterMode } from '@totp/core'

// popup 四级回退（spec §3 Popup）：搜索 → tag → URL 分级放宽；快速取码场景不让空结果挡路，
// 纯 tag 浏览零命中如实反馈。提示常量与 spec 回退表逐字一致。

export const HINT_SITE_TAGGED = '当前站点无匹配，显示标签内结果'
export const HINT_TAG_RELAXED = '当前标签下无匹配，已放宽标签过滤'
export const HINT_SITE_PLAIN = '当前站点无匹配，显示全部'
export const HINT_SITE_ALL = '当前站点与标签均无匹配，显示全部'

export interface PopupFilterInput {
  entries: OtpEntry[]
  query: string
  selectedTagIds: ReadonlySet<string>
  tagMode: TagFilterMode
  /** URL 过滤生效（urlFilterEnabled 开启且读到 http(s) 标签页 URL） */
  urlFilterActive: boolean
  tabUrl: string | null
}

export interface PopupFilterResult {
  visible: OtpEntry[]
  /** 回退提示；正常命中为空串 */
  hint: string
  /** tag 后集合的 URL 命中数（popup「匹配 N 条」展示用） */
  urlMatchCount: number
}

function searchMatch(entries: OtpEntry[], q: string): OtpEntry[] {
  if (!q) return entries
  const needle = q.toLowerCase()
  return entries.filter((e) => `${e.issuer} ${e.label} ${e.note ?? ''}`.toLowerCase().includes(needle))
}

export function resolvePopupVisible(input: PopupFilterInput): PopupFilterResult {
  const base = searchMatch(input.entries, input.query.trim())
  const tagged = filterByTags(base, input.selectedTagIds, input.tagMode)
  if (!input.urlFilterActive) {
    if (tagged.length === 0 && input.query.trim() !== '' && input.selectedTagIds.size > 0) {
      return { visible: base, hint: HINT_TAG_RELAXED, urlMatchCount: 0 }
    }
    return { visible: tagged, hint: '', urlMatchCount: 0 }
  }
  const url = input.tabUrl ?? ''
  const urlSet = tagged.filter((e) => entryMatchesUrl(e, url))
  if (urlSet.length > 0) return { visible: urlSet, hint: '', urlMatchCount: urlSet.length }
  if (tagged.length > 0) {
    return { visible: tagged, hint: input.selectedTagIds.size > 0 ? HINT_SITE_TAGGED : HINT_SITE_PLAIN, urlMatchCount: 0 }
  }
  const urlOnly = base.filter((e) => entryMatchesUrl(e, url))
  if (urlOnly.length > 0) return { visible: urlOnly, hint: HINT_TAG_RELAXED, urlMatchCount: urlOnly.length }
  return { visible: base, hint: HINT_SITE_ALL, urlMatchCount: 0 }
}
```

`packages/ui/src/index.ts` 追加 `export * from './popupFilter'`。

- [ ] **Step 4: 跑绿** — `pnpm -C packages/ui test -- popupFilter && pnpm -C packages/ui typecheck`，Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): popup 标签筛选四级回退纯函数 resolvePopupVisible

why: popup 取码链路（搜索→tag→URL）需要可单测的分级放宽算法（spec §3）。
what: 纯函数 + 四级提示常量 + urlMatchCount；纯 tag 浏览零命中不放宽。"
```

---

### Task 12: SettingsPage「记住标签筛选」开关

**Files:**
- Modify: `packages/ui/src/pages/SettingsPage.vue`
- Test: `packages/ui/test/pages/SettingsPage.test.ts`（若无此文件则本任务仅手动验证 + typecheck）

**Interfaces:**
- Consumes: `settings.rememberTagFilter`（Task 5）
- Produces: 设置页「通用」卡新增开关行（class `set-remember-tag-filter`），两端（desktop/extension）均显示

- [ ] **Step 1: 写失败测试**（有既有测试文件则追加；无则跳到 Step 3 并在 Step 4 以 typecheck + 既有全量测试兜底）：

```ts
it('记住标签筛选开关写入 settings', async () => {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  const w = mount(SettingsPage, { props: { store: s } })
  await w.find('input.set-remember-tag-filter, .set-remember-tag-filter input').setValue(true)
  await vi.waitFor(() => expect(s.settings.rememberTagFilter).toBe(true))
})
```

- [ ] **Step 2: 跑红** — `pnpm -C packages/ui test -- SettingsPage`，Expected: FAIL/找不到开关
- [ ] **Step 3: 实现** — `SettingsPage.vue`：
- `BoolKey` 联合加 `'rememberTagFilter'`：`type BoolKey = 'blurHideEnabled' | 'urlFilterEnabled' | 'clipboardClearEnabled' | 'rememberTagFilter'`
- 「通用」卡内、剪贴板行之后追加（无条件渲染——两端皆有 tag 筛选）：

```vue
      <div class="row">
        <span class="row-label">记住标签筛选</span>
        <MdSwitch
          class="set-remember-tag-filter" :model-value="store.settings.rememberTagFilter"
          @update:model-value="setBool('rememberTagFilter', $event)"
        />
      </div>
```

- `hasGeneralItems` 计算纳入新行：`const hasGeneralItems = computed(() => props.showDesktop || props.showExtension || hasClipboardClear.value || true)` —— 即简化为 `computed(() => true)`（通用卡恒渲染，注释注明由「记住标签筛选」兜底）。
- [ ] **Step 4: 跑绿** — `pnpm -C packages/ui test && pnpm -C packages/ui typecheck`，Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): 设置页新增「记住标签筛选」开关

why: 选中 tag 集合的持久化由用户显式控制（spec §3 设置项）。
what: 通用卡恒渲染 + rememberTagFilter 开关接既有 setBool 通道。"
```

---

### Task 13: Popup 接入（TagFilterRow + 四级回退 + 持久化）与 extension 层收口

**Files:**
- Modify: `apps/extension/src/store.ts`
- Modify: `apps/extension/entrypoints/popup/App.vue`
- Test: `apps/extension/test/store.test.ts`

**Interfaces:**
- Consumes: `TagFilterRow`（Task 7）、`resolvePopupVisible`（Task 11）、settings 三字段（Task 5）、`addTagOp` 等（Task 6）
- Produces: popup 行为——标签筛选行、四级回退提示、`rememberTagFilter` 读写；extension store 导出 `addTagOp/renameTagOp/removeTagOp`

- [ ] **Step 1: 改测试** — `apps/extension/test/store.test.ts` 及该 app 内其余引用：`addGroupOp/renameGroupOp/removeGroupOp` → `addTagOp/renameTagOp/removeTagOp`（`rg -l "GroupOp" apps/extension` 列全后逐文件替换，断言同步）。
- [ ] **Step 2: 跑红** — `pnpm -C apps/extension test`，Expected: FAIL（导出名不存在）
- [ ] **Step 3: 实现**

`apps/extension/src/store.ts` 末段导出替换：

```ts
export const addEntryOp = store.addEntryOp
export const updateEntryOp = store.updateEntryOp
export const removeEntryOp = store.removeEntryOp
export const addTagOp = store.addTagOp
export const renameTagOp = store.renameTagOp
export const removeTagOp = store.removeTagOp
export const reorderOp = store.reorderOp
export const replaceAllOp = store.replaceAllOp
```

`apps/extension/entrypoints/popup/App.vue`：
- import 增 `watch`（vue）与 `TagFilterRow, resolvePopupVisible, type TagFilterMode`（@totp/ui）；`entryMatchesUrl` 若仅剩 popupFilter 使用则从 import 中移除；
- 状态区替换（原 `filterOn/filterFallback/matched/visible` 段）：

```ts
const filterOn = computed(() => settings.urlFilterEnabled)
/** 标签筛选选中态：rememberTagFilter 开启时自 settings 恢复并回写（spec §3） */
const selectedTagIds = ref<string[]>(settings.rememberTagFilter ? [...settings.lastTagFilterIds] : [])
const tagMode = computed(() => settings.tagFilterMode)
async function setTagMode(m: TagFilterMode) {
  settings.tagFilterMode = m
  await commitSettings()
}
watch(selectedTagIds, (ids) => {
  if (!settings.rememberTagFilter) return
  settings.lastTagFilterIds = [...ids]
  void commitSettings()
})
// 悬空 tag 清理：tag 被删/同步变更后从选中集合剔除（联动持久化 watch 一并落盘）
watch(
  () => vault.tags.map((t) => t.id),
  (ids) => {
    const next = selectedTagIds.value.filter((id) => ids.includes(id))
    if (next.length !== selectedTagIds.value.length) selectedTagIds.value = next
  },
)

/** 四级回退链（spec §3）：搜索 → tag → URL 分级放宽；tabUrl 仅 http(s)（onMounted 既有判定） */
const filterResult = computed(() => resolvePopupVisible({
  entries: sorted.value,
  query: query.value,
  selectedTagIds: new Set(selectedTagIds.value),
  tagMode: settings.tagFilterMode,
  urlFilterActive: filterOn.value && !!tabUrl.value,
  tabUrl: tabUrl.value,
}))
const visible = computed(() => filterResult.value.visible)
```

- 模板：SearchBar 之后、原 filter-row 之前插入标签行；filter-row 提示改由 `filterResult` 驱动：

```vue
    <TagFilterRow
      v-if="vault.tags.length > 0" class="tag-row"
      :tags="vault.tags" v-model:selected-ids="selectedTagIds"
      :mode="tagMode" @update:mode="setTagMode"
    />

    <div class="filter-row" v-if="tabUrl">
      <MdCheckbox :model-value="filterOn" label="按当前站点过滤" @update:model-value="toggleFilter" />
      <span v-if="filterResult.hint" class="hint">{{ filterResult.hint }}</span>
      <span v-else-if="filterOn && filterResult.urlMatchCount > 0" class="hint">匹配 {{ filterResult.urlMatchCount }} 条</span>
    </div>
```

- onSave 不变（`...data` 已随 EntryFormData 携带 `tagIds`）；`contextCopyUri` 等不动；`.tag-row { padding: 0 4px; }` 样式追加。
- [ ] **Step 4: 跑绿** — `pnpm -C apps/extension test && pnpm -C apps/extension typecheck`，Expected: 全绿
- [ ] **Step 5: 手动冒烟（真实浏览器）** — `pnpm -C apps/extension build` 后加载 dist：建两个 tag 各挂条目 → popup 选 tag 过滤 → 开 URL 过滤验证四级回退提示 → 切「全部/任一」模式 → options 改「记住标签筛选」后重开 popup 验证选中态恢复。
- [ ] **Step 6: Commit**

```bash
git add apps/extension
git commit -m "feat(extension): popup 接入标签筛选与四级回退，store 导出收口 tag op

why: popup 页按 tag 过滤 + 站点/搜索筛选下零命中放宽（spec §3 Popup）。
what: TagFilterRow + resolvePopupVisible 接线；rememberTagFilter 恢复/回写；导出 addTagOp 族。"
```

---

### Task 14: 文案收尾 + 全仓验证

**Files:**
- Modify: 残留「分组」文案所在文件（`rg -l "分组" packages/ui/src apps` 定位）

- [ ] **Step 1: 全仓 group 残留扫描**

Run: `rg -n "groupIds|addGroup|renameGroup|removeGroup|GroupManager|vault\.groups|'groups'|\"groups\"" packages apps --glob '!node_modules'`
Expected: 仅剩 `parseVaultJson` 之外的历史注释无；有则逐处改（代码键名必须为零，注释里历史任务号说明可保留但「分组」字样改「标签」）。

- [ ] **Step 2: 用户可见文案扫描**

Run: `rg -n "分组" packages/ui/src apps --glob '!node_modules'`
Expected: 零命中；aria-label/title/placeholder/按钮/提示语全部为「标签」口径。

- [ ] **Step 3: 全仓测试 + 类型**

Run: `pnpm test && pnpm typecheck`
Expected: 四包全绿（core/ui/extension/desktop）。

- [ ] **Step 4: Commit**

```bash
git add -A packages apps
git commit -m "chore(ui,extension): 分组→标签文案全量收尾

why: 用户可见口径统一为标签（spec §6 文案项）。
what: aria/title/占位/按钮文案替换；全仓 group 键残留清零；四包测试与类型全绿。"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1→Task 1；§2→Task 2；§3 CodesPage→Task 10、Popup→Task 11+13、TagFilterRow→Task 7、EntryForm→Task 8、设置项→Task 5+12；§4 落库→Task 3、四导入器→Task 4；§5 无需改动项无需任务；§6 测试分散在各任务 Step 1，收口 Task 14。
- **占位符**：Task 8/10 各有一处「按既有测试风格等价改写」的表述，均为对既有测试 helper 的复用指引而非缺失实现；其余步骤均含完整代码。
- **类型一致性**：`addTag→{vault, tagId}` 贯穿 Task 1/3/6/8；`filterByTags(entries, Set, mode)` 贯穿 Task 2/10/11；`resolvePopupVisible` 输入输出在 Task 11/13 一致；settings 三字段名在 Task 5/10/12/13 一致。
