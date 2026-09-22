# 同步体验优化（逻辑时钟 + 活动目标 + 三方合并）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 云同步判定从字节 hash 基线换成逻辑时钟版本号（envelope v3），引入 primary/replica 活动目标与条目级三方合并，冲突强提示（badge/横幅/列表，废除自动弹下载），并修复 single-flight、内容门持久化、进度指示、OAuth 刷新。

**Architecture:** core 层新增 canonical hash、syncState、merge 纯函数模块并重写 syncOrchestrator/multiTarget；宿主 runner（packages/ui cloudRunner 双端共享）换新 deps（sync state 读写、DEK seal、手动合并预览确认、进度回调）；UI 层 CloudCard 增冲突区块/差异预览/进度。extension 冲突副本从自动下载改为 storage.local 列表 + badge。

**Tech Stack:** TypeScript + Vue3（packages/core 零依赖 WebCrypto）、vitest（colocated `*.test.ts`）、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-09-22-sync-ux-mcp-tools-design.md`（§1-§5、§7；MCP 部分见姊妹计划 `2026-09-22-mcp-trigger-tools.md`）

## Global Constraints

- 全链路端到端加密：网络上只有 envelope 密文；锁定态零网络写（runner 守护不变）。
- `baseSnapshot`/`mergeConflicts` 含 vault 明文与条目 secret：启用库加密时必须 DEK 加密落盘（spec §1.2 静态保护）。
- 本地备份/导出文件保持 `v: 2` 不变；`v: 3` 仅用于云同步对象。
- F8 防回滚水位（`securityStore.ts:42-52`）、envelope KDF 钳制（`envelope.ts:59-67`）不动。
- 手动通道合并前必须预览确认；自动通道静默合并 + 冲突提示（spec §3）。
- 单目标失败不阻断其余目标（沿用 core 编排隔离语义）。
- 文案一律 zh/en 双语 i18n（`packages/ui/src/i18n/locales/{zh,en}/common.json`）。
- 测试命令：`pnpm --filter @totp/core test`（core）/ `pnpm -r --no-bail run test`（全仓）；每任务收尾须通过 `pnpm -r run typecheck`。
- 提交原子化：每任务一个 commit，Angular 规范。

---

### Task 1: canonicalJson 与内容 hash（core 纯函数）

**Files:**
- Create: `packages/core/src/cloud/canonical.ts`
- Test: `packages/core/src/cloud/canonical.test.ts`
- Modify: `packages/core/src/index.ts`（re-export）

**Interfaces:**
- Produces: `canonicalJson(x: unknown): string`、`contentHash(vaultJson: string): Promise<string>`（后续 Task 7/9 消费）

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/cloud/canonical.test.ts
import { describe, expect, it } from 'vitest'
import { canonicalJson, contentHash } from './canonical'

describe('canonicalJson', () => {
  it('键序无关：相同对象不同插入序产出同一字符串', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })
  it('数组保持顺序（条目 order 语义）', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
  it('undefined 字段与缺失等价', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })
})

describe('contentHash', () => {
  it('键序抖动不改变 hash（消除随机 IV/键序影响）', async () => {
    const a = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 1 })
    const b = JSON.stringify({ updatedAt: 1, tags: [], entries: [], version: 2 })
    expect(await contentHash(a)).toBe(await contentHash(b))
  })
  it('内容不同 hash 不同', async () => {
    expect(await contentHash('{"a":1}')).not.toBe(await contentHash('{"a":2}'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/core exec vitest run src/cloud/canonical.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/cloud/canonical.ts
/** 规范化 JSON 与内容 hash（spec §1.3 内容门）：对解密后 vault JSON 做稳定序列化再 sha256，
 *  消除键序抖动——「内容未变」判定与字节形态解耦。 */

export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null'
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`
  const keys = Object.keys(x as Record<string, unknown>)
    .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((x as Record<string, unknown>)[k])}`).join(',')}}`
}

export async function contentHash(vaultJson: string): Promise<string> {
  const stable = canonicalJson(JSON.parse(vaultJson))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable) as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
```

在 `packages/core/src/index.ts` 的 cloud 导出区追加 `export { canonicalJson, contentHash } from './cloud/canonical'`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @totp/core exec vitest run src/cloud/canonical.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cloud/canonical.ts packages/core/src/cloud/canonical.test.ts packages/core/src/index.ts
git commit -m "feat(core): canonicalJson与内容hash纯函数（同步内容门地基）"
```

---

### Task 2: OtpEntry.updatedAt 字段与写路径推进

**Files:**
- Modify: `packages/core/src/model.ts:9-29`（OtpEntry）
- Modify: `packages/core/src/vault.ts`（updateEntry/addEntry）
- Test: `packages/core/src/vault.test.ts`（既有文件追加用例）

**Interfaces:**
- Produces: `OtpEntry.updatedAt?: number`（缺省 0 语义，合并规则消费）

- [ ] **Step 1: Write the failing test**（追加到既有 `vault.test.ts`）

```ts
describe('entry updatedAt', () => {
  it('addEntry 盖 createdAt 同值 updatedAt', () => {
    const now = 1_700_000_000_000
    const v = addEntry(emptyVault(), { baseEntry(now), uuid: 'e1' } as never)
    expect(v.entries[0]!.updatedAt).toBe(now)
  })
  it('updateEntry 推进 updatedAt；未变字段不动 createdAt', () => {
    let v = addEntry(emptyVault(), { ...baseEntry(1000), uuid: 'e1' } as never)
    vi.spyOn(Date, 'now').mockReturnValue(2000)
    v = updateEntry(v, 'e1', { label: 'x' })
    expect(v.entries[0]!.updatedAt).toBe(2000)
    expect(v.entries[0]!.createdAt).toBe(1000)
    vi.restoreAllMocks()
  })
})
```

（`baseEntry(n)` 若测试文件无现成工厂，就地写一个返回完整 OtpEntry 的辅助函数；沿用文件内既有构造模式。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/core exec vitest run src/vault.test.ts`
Expected: FAIL（updatedAt undefined）

- [ ] **Step 3: Implement**

`model.ts` OtpEntry 在 `createdAt: number` 后追加：

```ts
  /** 条目级最后修改时间（条目级三方合并裁决用）；缺省 0=旧数据无时间戳（合并 tie 判云端胜） */
  updatedAt?: number
```

`vault.ts` 的 `addEntry`：入参 entry 若无 `updatedAt` 则置为 `entry.createdAt`；`updateEntry`：patch 应用后设 `updatedAt: Date.now()`（imports 处已有 Date 使用则复用）。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @totp/core exec vitest run src/vault.test.ts`
Expected: PASS（含既有用例回归）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/model.ts packages/core/src/vault.ts packages/core/src/vault.test.ts
git commit -m "feat(core): OtpEntry.updatedAt字段与写路径推进（三方合并裁决依据）"
```

---

### Task 3: envelope v3（云同步专用信封）

**Files:**
- Modify: `packages/core/src/backup/envelope.ts`
- Test: `packages/core/src/backup/envelope.test.ts`（既有文件追加）

**Interfaces:**
- Produces: `SyncMeta { rev; deviceId; baseRev; baseContentHash }`、`SyncEnvelope`、`createSyncEnvelope(vaultJson, password, profile, sync): Promise<SyncEnvelope>`、`isSyncEnvelope(x): x is SyncEnvelope`、`readSyncHeader(x: unknown): SyncMeta | null`（v2 → null = 无版本祖先）；`openBackupEnvelope` 接受 v2/v3

- [ ] **Step 1: Write the failing test**（追加）

```ts
import { createSyncEnvelope, isSyncEnvelope, readSyncHeader, openBackupEnvelope } from './envelope'

describe('sync envelope v3', () => {
  const sync = { rev: 7, deviceId: 'dev-a', baseRev: 6, baseContentHash: 'ab12' }
  it('create→isSyncEnvelope→open 往返', async () => {
    const env = await createSyncEnvelope('{"a":1}', 'pw', 'balanced', sync)
    expect(isSyncEnvelope(env)).toBe(true)
    expect(await openBackupEnvelope(JSON.parse(JSON.stringify(env)), 'pw')).toBe('{"a":1}')
  })
  it('isBackupEnvelope 对 v2 仍真、对 v3 假', async () => {
    const v2 = await createBackupEnvelope('{}', 'pw')
    expect(isBackupEnvelope(v2)).toBe(true)
    const v3 = await createSyncEnvelope('{}', 'pw', 'balanced', sync)
    expect(isBackupEnvelope(v3)).toBe(false)
  })
  it('readSyncHeader：v3 返回 sync；v2/垃圾返回 null', async () => {
    const v3 = await createSyncEnvelope('{}', 'pw', 'balanced', sync)
    expect(readSyncHeader(v3)).toEqual(sync)
    expect(readSyncHeader(await createBackupEnvelope('{}', 'pw'))).toBeNull()
    expect(readSyncHeader({ v: 3 })).toBeNull()
  })
  it('openBackupEnvelope 接受 v3', async () => {
    const v3 = await createSyncEnvelope('{"k":2}', 'pw', 'balanced', sync)
    expect(await openBackupEnvelope(JSON.parse(JSON.stringify(v3)), 'pw')).toBe('{"k":2}')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/core exec vitest run src/backup/envelope.test.ts`
Expected: FAIL（createSyncEnvelope 未导出）

- [ ] **Step 3: Implement**（envelope.ts 追加；`openBackupEnvelope` 的 `o['v'] === 2` 改为 `(o['v'] === 2 || o['v'] === 3)`）

```ts
/** 云同步信封扩展（spec §1.1）：v3 = v2 加密体 + sync 元数据。本地备份/导出恒为 v2 不变。 */
export interface SyncMeta {
  /** 云端逻辑时钟：单调递增，每次上传 = 读到的远端 rev + 1 */
  rev: number
  /** 写入设备标识（本机持久 UUID，并列裁决与展示用，非秘密） */
  deviceId: string
  /** 上传方声明的共同祖先：其本地上次收敛时的云端 rev 与该版本内容 hash */
  baseRev: number
  baseContentHash: string
}

export interface SyncEnvelope extends BackupEnvelope {
  v: 3
  sync: SyncMeta
}

export function isSyncEnvelope(x: unknown): x is SyncEnvelope {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  const s = o['sync'] as Record<string, unknown> | undefined
  return (
    o['v'] === 3 && isBackupEnvelope({ ...o, v: 2 } as unknown) === false ? false : o['v'] === 3 &&
    typeof s === 'object' && s !== null &&
    typeof s['rev'] === 'number' && Number.isInteger(s['rev']) && s['rev'] >= 1 &&
    typeof s['deviceId'] === 'string' && s['deviceId'] !== '' &&
    typeof s['baseRev'] === 'number' && Number.isInteger(s['baseRev']) && s['baseRev'] >= 0 &&
    typeof s['baseContentHash'] === 'string'
  )
}

export function readSyncHeader(x: unknown): SyncMeta | null {
  return isSyncEnvelope(x) ? { ...x.sync } : null
}

export async function createSyncEnvelope(vaultJson: string, password: string, profile: KdfProfile, sync: SyncMeta): Promise<SyncEnvelope> {
  const env = await createBackupEnvelope(vaultJson, password, profile)
  return { ...env, v: 3, sync }
}
```

（注意 `isSyncEnvelope` 不要写成上面的短路技巧——直接独立实现：`o['v'] === 3 && typeof s === 'object' && ...字段逐个校验`。上面示意中的 `isBackupEnvelope({...o, v:2})` 写法禁止采用，实现时直接展开字段校验。）

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @totp/core exec vitest run src/backup/envelope.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/backup/envelope.ts packages/core/src/backup/envelope.test.ts packages/core/src/index.ts
git commit -m "feat(core): 云同步信封v3（rev逻辑时钟+共同祖先指针），v2仅存量备份"
```

---

### Task 4: SourceSyncState 持久化与 deviceId（DEK seal 静态保护）

**Files:**
- Create: `packages/core/src/cloud/syncState.ts`
- Test: `packages/core/src/cloud/syncState.test.ts`
- Modify: `packages/core/src/index.ts`（re-export）

**Interfaces:**
- Produces: `SourceSyncState { lastKnownRemoteRev: number | null; baseSnapshot: string | null; primaryRev?: Record<string, number> }`、`loadSyncState(adapter, sourceId, seal?): Promise<SourceSyncState>`、`saveSyncState(adapter, sourceId, state, seal?): Promise<void>`、`loadDeviceId(adapter): Promise<string>`、`Seal { seal(plain): Promise<string>; unseal(sealed): Promise<string> }`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/cloud/syncState.test.ts
import { describe, expect, it } from 'vitest'
import { createMemoryAdapter } from '../storage/memory'
import { loadDeviceId, loadSyncState, saveSyncState } from './syncState'

describe('syncState', () => {
  it('无 seal：明文往返；缺省状态 lastKnownRemoteRev=null', async () => {
    const a = createMemoryAdapter()
    expect(await loadSyncState(a, 's1')).toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })
    await saveSyncState(a, 's1', { lastKnownRemoteRev: 5, baseSnapshot: '{"v":2}' })
    expect(await loadSyncState(a, 's1')).toEqual({ lastKnownRemoteRev: 5, baseSnapshot: '{"v":2}' })
  })
  it('有 seal：落盘为密文（不含明文子串），读回一致', async () => {
    const a = createMemoryAdapter()
    const seal = {
      seal: async (p: string) => 'ENC[' + btoa(p) + ']',
      unseal: async (s: string) => atob(s.slice(4, -1)),
    }
    await saveSyncState(a, 's1', { lastKnownRemoteRev: 5, baseSnapshot: '{"secretField":"TOPSECRET"}' }, seal)
    const raw = await a.get('cloudSyncState')
    expect(raw).not.toContain('TOPSECRET')
    expect(await loadSyncState(a, 's1', seal)).toEqual({ lastKnownRemoteRev: 5, baseSnapshot: '{"secretField":"TOPSECRET"}' })
  })
  it('unseal 失败（换 DEK）→ 回落缺省状态不抛错', async () => {
    const a = createMemoryAdapter()
    await a.set('cloudSyncState', 'ENC[bad]')
    expect(await loadSyncState(a, 's1', { seal: async () => '', unseal: async () => { throw new Error('no') } }))
      .toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })
  })
  it('loadDeviceId：首次生成并持久，二次读取同值', async () => {
    const a = createMemoryAdapter()
    const id1 = await loadDeviceId(a)
    expect(id1).toMatch(/^[0-9a-f-]{36}$/)
    expect(await loadDeviceId(a)).toBe(id1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/core exec vitest run src/cloud/syncState.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/cloud/syncState.ts
/** 云同步本端持久状态（spec §1.2）。baseSnapshot 是 vault 明文副本：seal 提供时整状态
 *  JSON 加密落盘（DEK 静态保护，宿主在解锁态注入）；seal 缺省=明文库场景明文落盘。 */
import type { StorageAdapter } from '../storage/adapter'

export interface SourceSyncState {
  /** 上次见到的云端 rev；null=该源从未同步过 */
  lastKnownRemoteRev: number | null
  /** 上次与本端内容收敛一致的完整 vault JSON（共同祖先快照）；null=无祖先（两方合并降级） */
  baseSnapshot: string | null
  /** replica 目标的 rev 记录（spec §2 收敛复制跳过判定） */
  primaryRev?: Record<string, number>
}

export interface Seal {
  seal(plain: string): Promise<string>
  unseal(sealed: string): Promise<string>
}

export const SYNC_STATE_KEY = 'cloudSyncState'
export const DEVICE_ID_KEY = 'cloudDeviceId'

function emptyState(): SourceSyncState {
  return { lastKnownRemoteRev: null, baseSnapshot: null }
}

export async function loadSyncState(adapter: StorageAdapter, sourceId: string, seal?: Seal): Promise<SourceSyncState> {
  let raw: string | null = null
  try {
    raw = await adapter.get(SYNC_STATE_KEY)
  } catch {
    return emptyState()
  }
  if (!raw) return emptyState()
  let bag: Record<string, unknown>
  try {
    bag = JSON.parse(seal ? await seal.unseal(raw) : raw) as Record<string, unknown>
  } catch {
    return emptyState() // 换 DEK/损坏：回落缺省，下轮全量重建（不抛错阻断同步）
  }
  const s = bag[sourceId] as Partial<SourceSyncState> | undefined
  if (!s || typeof s !== 'object') return emptyState()
  return {
    lastKnownRemoteRev: typeof s.lastKnownRemoteRev === 'number' ? s.lastKnownRemoteRev : null,
    baseSnapshot: typeof s.baseSnapshot === 'string' ? s.baseSnapshot : null,
    ...(s.primaryRev !== undefined && typeof s.primaryRev === 'object' ? { primaryRev: s.primaryRev as Record<string, number> } : {}),
  }
}

export async function saveSyncState(adapter: StorageAdapter, sourceId: string, state: SourceSyncState, seal?: Seal): Promise<void> {
  let bag: Record<string, unknown> = {}
  try {
    const raw = await adapter.get(SYNC_STATE_KEY)
    bag = raw ? JSON.parse(seal ? await seal.unseal(raw) : raw) as Record<string, unknown> : {}
  } catch {
    bag = {}
  }
  bag[sourceId] = state
  const plain = JSON.stringify(bag)
  await adapter.set(SYNC_STATE_KEY, seal ? await seal.seal(plain) : plain)
}

export async function loadDeviceId(adapter: StorageAdapter): Promise<string> {
  const existing = await adapter.get(DEVICE_ID_KEY).catch(() => null)
  if (existing) return existing
  const id = crypto.randomUUID()
  await adapter.set(DEVICE_ID_KEY, id)
  return id
}
```

（`storage/adapter` 路径与 `createMemoryAdapter` 导出名以 `packages/core/src/storage/memory.ts` 实际为准，先读再写测试。）

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @totp/core exec vitest run src/cloud/syncState.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cloud/syncState.ts packages/core/src/cloud/syncState.test.ts packages/core/src/index.ts
git commit -m "feat(core): 云同步状态持久化（DEK seal静态保护+deviceId）"
```

---

### Task 5: 条目级三方合并 vaultMerge

**Files:**
- Create: `packages/core/src/merge/vaultMerge.ts`
- Test: `packages/core/src/merge/vaultMerge.test.ts`
- Modify: `packages/core/src/index.ts`（re-export）

**Interfaces:**
- Consumes: `OtpEntry`（含 Task 2 的 `updatedAt`）、`Vault`
- Produces: `EntryConflict { entryId; issuer; label; ours: OtpEntry | null; theirs: OtpEntry | null; base: OtpEntry | null }`、`MergeResult { vault: Vault; conflicts: EntryConflict[]; degraded: boolean }`、`mergeVaults(base: Vault | null, ours: Vault, theirs: Vault): MergeResult`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/src/merge/vaultMerge.test.ts
import { describe, expect, it } from 'vitest'
import { mergeVaults, type EntryConflict } from './vaultMerge'
import type { OtpEntry, Vault } from '../model'

function entry(p: Partial<OtpEntry> & { uuid: string }): OtpEntry {
  return { type: 'totp', issuer: 'I', label: p.uuid, secret: 'S', algorithm: 'SHA1', digits: 6, period: 30,
    tagIds: [], order: 0, createdAt: 1, updatedAt: 1, ...p }
}
function vault(entries: OtpEntry[], updatedAt = 1): Vault {
  return { version: 2, entries, tags: [], updatedAt }
}

describe('mergeVaults', () => {
  it('仅一方改/增 → 采纳该方', () => {
    const base = vault([entry({ uuid: 'a', label: 'old' })])
    const ours = vault([entry({ uuid: 'a', label: 'old' }), entry({ uuid: 'b', label: 'new-ours' })])
    const theirs = vault([entry({ uuid: 'a', label: 'renamed' })])
    const r = mergeVaults(base, ours, theirs)
    expect(r.conflicts).toEqual([])
    expect(r.vault.entries.map((e) => e.uuid).sort()).toEqual(['a', 'b'])
    expect(r.vault.entries.find((e) => e.uuid === 'a')!.label).toBe('renamed')
  })
  it('双方同改同值 → 任取无冲突', () => {
    const base = vault([entry({ uuid: 'a', label: 'old' })])
    const r = mergeVaults(base, vault([entry({ uuid: 'a', label: 'same' })]), vault([entry({ uuid: 'a', label: 'same' })]))
    expect(r.conflicts).toEqual([])
    expect(r.vault.entries[0]!.label).toBe('same')
  })
  it('一方删另一方未动 → 删除生效', () => {
    const base = vault([entry({ uuid: 'a' }), entry({ uuid: 'b' })])
    const r = mergeVaults(base, vault([entry({ uuid: 'a' })]), vault([entry({ uuid: 'a' }), entry({ uuid: 'b' })]))
    expect(r.vault.entries.map((e) => e.uuid)).toEqual(['a'])
  })
  it('一方删另一方改 → 保留修改 + 冲突记录', () => {
    const base = vault([entry({ uuid: 'a', label: 'old' })])
    const ours = vault([]) // 本方删除
    const theirs = vault([entry({ uuid: 'a', label: 'edited' })])
    const r = mergeVaults(base, ours, theirs)
    expect(r.vault.entries.map((e) => e.uuid)).toEqual(['a'])
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0]!.ours).toBeNull()
    expect(r.conflicts[0]!.theirs!.label).toBe('edited')
  })
  it('双方改成不同内容 → updatedAt 新者为主体，另一方入冲突', () => {
    const base = vault([entry({ uuid: 'a', label: 'old', updatedAt: 1 })])
    const ours = vault([entry({ uuid: 'a', label: 'ours-new', updatedAt: 100 })])
    const theirs = vault([entry({ uuid: 'a', label: 'theirs-new', updatedAt: 200 })])
    const r = mergeVaults(base, ours, theirs)
    expect(r.vault.entries[0]!.label).toBe('theirs-new')
    expect(r.conflicts[0]!.ours!.label).toBe('ours-new')
  })
  it('双方增同 id 不同内容 → 冲突，tie 时云端为主体', () => {
    const ours = vault([entry({ uuid: 'x', label: 'o', updatedAt: 10 })])
    const theirs = vault([entry({ uuid: 'x', label: 't', updatedAt: 10 })])
    const r = mergeVaults(null, ours, theirs)
    expect(r.vault.entries[0]!.label).toBe('t')
    expect(r.conflicts).toHaveLength(1)
  })
  it('base=null 降级两方合并：并集 + 同 id 冲突取新者，degraded=true', () => {
    const ours = vault([entry({ uuid: 'a', label: 'o', updatedAt: 5 }), entry({ uuid: 'only-ours' })])
    const theirs = vault([entry({ uuid: 'a', label: 't', updatedAt: 9 }), entry({ uuid: 'only-theirs' })])
    const r = mergeVaults(null, ours, theirs)
    expect(r.degraded).toBe(true)
    expect(r.vault.entries.map((e) => e.uuid).sort()).toEqual(['a', 'only-ours', 'only-theirs'])
    expect(r.vault.entries.find((e) => e.uuid === 'a')!.label).toBe('t')
  })
  it('vault.updatedAt 取两侧较大值', () => {
    const r = mergeVaults(vault([], 1), vault([entry({ uuid: 'n' })], 50), vault([], 30))
    expect(r.vault.updatedAt).toBe(50)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/core exec vitest run src/merge/vaultMerge.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/merge/vaultMerge.ts
/** 条目级三方合并（spec §3）：base=共同祖先（null=降级两方合并），ours=本地，theirs=云端。
 *  条目身份=uuid；裁决表见 spec；非条目域：tags 按 id 并集（同 id 不同名取 ours，确定性、低风险），
 *  vault.updatedAt 取两侧较大值（防回滚由既有水位键把守，此处不涉 rev）。 */
import type { OtpEntry, Vault } from '../model'

export interface EntryConflict {
  entryId: string
  issuer: string
  label: string
  ours: OtpEntry | null
  theirs: OtpEntry | null
  base: OtpEntry | null
}

export interface MergeResult {
  vault: Vault
  conflicts: EntryConflict[]
  /** true=base 缺失走两方合并降级 */
  degraded: boolean
}

const updatedAtOf = (e: OtpEntry | null | undefined): number => e?.updatedAt ?? 0

function mergeTags(ours: Vault, theirs: Vault): Vault['tags'] {
  const out = new Map(ours.tags.map((t) => [t.id, t]))
  for (const t of theirs.tags) if (!out.has(t.id)) out.set(t.id, t)
  return [...out.values()]
}

export function mergeVaults(base: Vault | null, ours: Vault, theirs: Vault): MergeResult {
  const degraded = base === null
  const baseMap = new Map((base?.entries ?? []).map((e) => [e.uuid, e]))
  const oursMap = new Map(ours.entries.map((e) => [e.uuid, e]))
  const theirsMap = new Map(theirs.entries.map((e) => [e.uuid, e]))
  const conflicts: EntryConflict[] = []
  const out = new Map<string, OtpEntry>()

  const ids = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()])
  for (const id of ids) {
    const b = baseMap.get(id) ?? null
    const o = oursMap.get(id) ?? null
    const t = theirsMap.get(id) ?? null
    if (JSON.stringify(o) === JSON.stringify(t)) {
      if (o !== null) out.set(id, o) // 双方一致（含双方都删）
      continue
    }
    if (JSON.stringify(o) === JSON.stringify(b)) {
      if (t !== null) out.set(id, t) // 本方未动 → 取云方（含本方未动云方删=删除生效）
      continue
    }
    if (JSON.stringify(t) === JSON.stringify(b)) {
      if (o !== null) out.set(id, o) // 云方未动 → 取本方
      continue
    }
    // 剩余：删/改对撞 或 双方改成不同内容 → 新者为主体，另一方入冲突
    const subject = updatedAtOf(t) > updatedAtOf(o) ? t : o // tie（含双方都无 updatedAt）→ ours 先写再被覆盖规则：此处 t 与 o 相等时取 t（云端胜 tie，与测试一致）
    const winner = updatedAtOf(t) > updatedAtOf(o) ? t : (updatedAtOf(t) < updatedAtOf(o) ? o : t)
    if (winner !== null) out.set(id, winner)
    conflicts.push({ entryId: id, issuer: (o ?? t ?? b)!.issuer, label: (o ?? t ?? b)!.label, ours: o, theirs: t, base: b })
  }
  const entries = [...out.values()].sort((a, b2) => a.order - b2.order)
  return {
    vault: { version: 2, entries, tags: mergeTags(ours, theirs), updatedAt: Math.max(ours.updatedAt, theirs.updatedAt) },
    conflicts,
    degraded,
  }
}
```

（实现时清理上面 subject/winner 的冗余——只保留 winner 一行，tie 取 `t`。）

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @totp/core exec vitest run src/merge/vaultMerge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/merge/vaultMerge.ts packages/core/src/merge/vaultMerge.test.ts packages/core/src/index.ts
git commit -m "feat(core): 条目级三方合并vaultMerge（含两方合并降级与冲突记录）"
```

---

### Task 6: BackupSource.role（primary/replica）

**Files:**
- Modify: `packages/core/src/backup/sources.ts`
- Test: `packages/core/src/backup/sources.test.ts`（既有文件追加；无则新建）

**Interfaces:**
- Produces: `BackupSource.role: 'primary' | 'replica'`；`normalizeSourceRoles(sources): BackupSource[]`（首个 enabled=primary，其余 replica；全 disabled 保持原 role）；`loadSources` 出口自动 normalize

- [ ] **Step 1: Write the failing test**

```ts
it('normalizeSourceRoles：首个启用=primary，其余 replica', () => {
  const r = normalizeSourceRoles([
    { id: 'a', kind: 'webdav', name: 'a', retention: { type: 'overwrite' }, enabled: false, role: 'replica' },
    { id: 'b', kind: 's3', name: 'b', retention: { type: 'overwrite' }, enabled: true, role: 'replica' },
    { id: 'c', kind: 'gist', name: 'c', retention: { type: 'overwrite' }, enabled: true, role: 'primary' },
  ])
  expect(r.find((s) => s.id === 'b')!.role).toBe('primary')
  expect(r.find((s) => s.id === 'c')!.role).toBe('replica')
  expect(r.find((s) => s.id === 'a')!.role).toBe('replica') // disabled 不参与，保持归一为 replica
})
it('loadSources 对无 role 存量数据归一（首个 enabled=primary）', async () => {
  const a = createMemoryAdapter()
  await a.set('backupSources', JSON.stringify([
    { id: 'x', kind: 'webdav', name: 'x', retention: { type: 'overwrite' }, enabled: true },
  ]))
  const list = await loadSources(a)
  expect(list[0]!.role).toBe('primary')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/core exec vitest run src/backup/sources.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

`BackupSource` 增加 `role: 'primary' | 'replica'`（必填，`isBackupSource` 校验值域；存量数据经 normalize 补齐）。`loadSources` 返回前过 `normalizeSourceRoles`。`normalizeSourceRoles` 实现：找第一个 `enabled` 的源置 `primary`，其余（含 disabled）置 `replica`。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @totp/core exec vitest run src/backup/sources.test.ts`
Expected: PASS（若既有 sources 消费方类型报错，随 compile 修复：构造处补 role）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/backup/sources.ts packages/core/src/backup/sources.test.ts
git commit -m "feat(core): 备份源primary/replica角色与加载归一"
```

---

### Task 7: syncOrchestrator 重写（rev 四分支判定 + 预览模式）

**Files:**
- Modify: `packages/core/src/cloud/syncOrchestrator.ts`（保留 `sha256Hex`/`pushEnvelope` 既有导出与签名兼容，`pushEnvelope` 增加可选 `sync?: SyncMeta` 参数——提供时写 v3 信封）
- Test: `packages/core/src/cloud/syncOrchestrator.test.ts`（既有文件追加/改造）

**Interfaces:**
- Consumes: Task 1/3/4/5 的 `contentHash`、`createSyncEnvelope`、`readSyncHeader`、`SourceSyncState`、`mergeVaults`
- Produces:
  - `RevSyncAction = 'uploaded' | 'downloaded' | 'merged' | 'in-sync'`
  - `RevSyncOutcome { action: RevSyncAction; remoteRev: number; newRev?: number; appliedVaultJson?: string; conflicts?: EntryConflict[]; mergeDegraded?: boolean }`
  - `syncWithCloudRev(opts: { backend; path; vaultJson; password; profile?; state: SourceSyncState; deviceId: string; mode?: 'apply' | 'preview'; onConflictBackup? }): Promise<RevSyncOutcome>`（无 `hash` 字段——基线改由 rev 状态承载；旧的 `syncWithCloud` 删除，调用方仅 multiTarget/cloudRunner，随 Task 8/9 一并切换）

- [ ] **Step 1: Write the failing test**（用既有测试文件中的 fake CloudBackend 模式；示意）

```ts
describe('syncWithCloudRev', () => {
  const deviceId = 'dev-a'
  const pw = 'pw'
  async function sealedLocal(rev: number, content: string): Promise<Uint8Array> {
    return encoder(JSON.stringify(await createSyncEnvelope(content, pw, 'balanced',
      { rev, deviceId: 'dev-b', baseRev: rev - 1, baseContentHash: await contentHash(content) })))
  }
  it('云端无对象 → uploaded newRev=1', async () => {
    const be = fakeBackend()
    const r = await syncWithCloudRev({ backend: be, path: 'p', vaultJson: '{"a":1}', password: pw,
      state: { lastKnownRemoteRev: null, baseSnapshot: null }, deviceId })
    expect(r.action).toBe('uploaded')
    expect(r.newRev).toBe(1)
  })
  it('双方未动 → in-sync 零写', async () => {
    const content = '{"a":1}'
    const be = fakeBackend()
    await be.put('p', await sealedLocal(3, content))
    const r = await syncWithCloudRev({ backend: be, path: 'p', vaultJson: content, password: pw,
      state: { lastKnownRemoteRev: 3, baseSnapshot: content }, deviceId })
    expect(r.action).toBe('in-sync')
  })
  it('本地未动云端较新 → downloaded 且 applied=远端', async () => {
    const local = '{"a":1}'
    const remote = '{"a":2}'
    const be = fakeBackend()
    await be.put('p', await sealedLocal(4, remote))
    const r = await syncWithCloudRev({ backend: be, path: 'p', vaultJson: local, password: pw,
      state: { lastKnownRemoteRev: 3, baseSnapshot: local }, deviceId })
    expect(r.action).toBe('downloaded')
    expect(r.appliedVaultJson).toBe(remote)
  })
  it('云端未动本地较新 → uploaded newRev=remote+1', async () => {
    const base = '{"a":1}'
    const be = fakeBackend()
    await be.put('p', await sealedLocal(3, base))
    const r = await syncWithCloudRev({ backend: be, path: 'p', vaultJson: '{"a":9}', password: pw,
      state: { lastKnownRemoteRev: 3, baseSnapshot: base }, deviceId })
    expect(r.action).toBe('uploaded')
    expect(r.newRev).toBe(4)
  })
  it('双方都动 → merged：条目并集 + 上传 newRev=remote+1；baseContentHash 不匹配降级 degraded', async () => {
    const base = JSON.stringify({ version: 2, entries: [e('a')], tags: [], updatedAt: 1 })
    const ours = JSON.stringify({ version: 2, entries: [e('a'), e('b')], tags: [], updatedAt: 2 })
    const theirs = JSON.stringify({ version: 2, entries: [e('a'), e('c')], tags: [], updatedAt: 3 })
    const be = fakeBackend()
    // 故意给错误 baseContentHash → 降级两方合并（base=null）
    await be.put('p', encoder(JSON.stringify(await createSyncEnvelope(theirs, pw, 'balanced',
      { rev: 5, deviceId: 'dev-b', baseRev: 4, baseContentHash: 'wrong' }))))
    const r = await syncWithCloudRev({ backend: be, path: 'p', vaultJson: ours, password: pw,
      state: { lastKnownRemoteRev: 4, baseSnapshot: base }, deviceId })
    expect(r.action).toBe('merged')
    expect(r.mergeDegraded).toBe(true)
    expect(r.newRev).toBe(6)
    expect(JSON.parse(r.appliedVaultJson!).entries.map((x: { uuid: string }) => x.uuid).sort()).toEqual(['a', 'b', 'c'])
  })
  it('preview 模式：merged 分支不写云，返回预览', async () => {
    // 同上装配；mode:'preview' → action 'merged'、newRev undefined、backend 写计数为 0
  })
  it('口令不匹配 → 抛中文错误不写', async () => {})
})
```

（`fakeBackend`/`encoder`/`e()` 复用/仿照该测试文件既有的 helper；若既有 fake 不记录写计数，为其加 `puts` 计数。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/core exec vitest run src/cloud/syncOrchestrator.test.ts`
Expected: FAIL（syncWithCloudRev 未导出）

- [ ] **Step 3: Implement**（`syncOrchestrator.ts`：文件头注释重写为 rev 语义；保留 `sha256Hex`、`pushEnvelope`（增可选 sync 参数 → v3）；删除 `syncWithCloud`，新增 `syncWithCloudRev`）

核心判定骨架（按 spec §1.3，含回退处理）：

```ts
export async function syncWithCloudRev(opts: {...}): Promise<RevSyncOutcome> {
  const { backend, path, vaultJson, password, profile, state, deviceId, onConflictBackup } = opts
  const mode = opts.mode ?? 'apply'
  const remote = (await backend.exists(path)) ? await backend.get(path) : null
  if (remote === null) {
    if (mode === 'preview') return { action: 'uploaded', remoteRev: 0 }
    const newRev = (state.lastKnownRemoteRev ?? 0) + 1
    await pushEnvelope({ backend, path, vaultJson, password, profile,
      sync: { rev: newRev, deviceId, baseRev: state.lastKnownRemoteRev ?? 0, baseContentHash: await contentHash(state.baseSnapshot ?? vaultJson) } })
    return { action: 'uploaded', remoteRev: 0, newRev }
  }
  const header = readSyncHeader(JSON.parse(decoder.decode(remote)))
  const remoteJson = await openBackupEnvelope(JSON.parse(decoder.decode(remote)), password) // 口令错抛中文错误（既有文案）
  const remoteRev = header?.rev ?? 0
  const remoteContentHash = await contentHash(remoteJson)
  const localUnchanged = state.baseSnapshot !== null && (await contentHash(vaultJson)) === (await contentHash(state.baseSnapshot))
  const remoteChanged = remoteRev !== (state.lastKnownRemoteRev ?? 0) || header === null

  if (!remoteChanged && localUnchanged) return { action: 'in-sync', remoteRev }
  if (remoteChanged && remoteContentHash === await contentHash(vaultJson) && localUnchanged) {
    return { action: 'in-sync', remoteRev } // 内容相等仅刷基线（调用方落 state）
  }
  if (remoteChanged && localUnchanged) {
    return { action: 'downloaded', remoteRev, appliedVaultJson: remoteJson }
  }
  if (!remoteChanged) {
    if (mode === 'preview') return { action: 'uploaded', remoteRev }
    const newRev = remoteRev + 1
    await pushEnvelope({ backend, path, vaultJson, password, profile,
      sync: { rev: newRev, deviceId, baseRev: remoteRev, baseContentHash: await contentHash(vaultJson) } })
    return { action: 'uploaded', remoteRev, newRev }
  }
  // 双方都动 → 合并
  const baseOk = header !== null && state.baseSnapshot !== null
    && header.baseContentHash === await contentHash(state.baseSnapshot)
  const merged = mergeVaults(baseOk ? JSON.parse(state.baseSnapshot!) : null, JSON.parse(vaultJson), JSON.parse(remoteJson))
  const mergedJson = JSON.stringify(merged.vault)
  if (mode === 'preview') {
    return { action: 'merged', remoteRev, appliedVaultJson: mergedJson, conflicts: merged.conflicts, mergeDegraded: merged.degraded }
  }
  // 本地旧内容存冲突副本（无 base 的 downloaded 首次语义并入 merged，不细分）
  if (onConflictBackup) {
    const copyJson = JSON.stringify(await createBackupEnvelope(vaultJson, password, profile))
    await onConflictBackup(encoder.encode(copyJson))
  }
  const newRev = remoteRev + 1
  await pushEnvelope({ backend, path, vaultJson: mergedJson, password, profile,
    sync: { rev: newRev, deviceId, baseRev: remoteRev, baseContentHash: remoteContentHash } })
  return { action: 'merged', remoteRev, newRev, appliedVaultJson: mergedJson, conflicts: merged.conflicts, mergeDegraded: merged.degraded }
}
```

（实现时按仓库实际代码风格整理：decoder 复用既有模块常量；错误文案沿用 `'云端备份口令不匹配，无法合并——请确认口令或手动下载处理'`；v2 远端 `header===null` 时按 `remoteChanged=true` 处理并走保守内容比对路径——上面 `remoteChanged` 定义已覆盖。）

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @totp/core exec vitest run src/cloud/syncOrchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cloud/syncOrchestrator.ts packages/core/src/cloud/syncOrchestrator.test.ts packages/core/src/index.ts
git commit -m "feat(core): rev逻辑时钟同步编排（四分支判定+合并预览模式），替代字节hash基线"
```

---

### Task 8: multiTarget 重写（primary 裁决 + replica 收敛复制）

**Files:**
- Modify: `packages/core/src/cloud/multiTarget.ts`
- Test: `packages/core/src/cloud/multiTarget.test.ts`（既有文件改造）

**Interfaces:**
- Consumes: Task 6/7 的 role 与 `syncWithCloudRev`
- Produces:
  - `MultiTargetInput { key; backend; path; source: BackupSource; state: SourceSyncState }`
  - `TargetResult { key; outcome: RevSyncOutcome | null; error?; errorStatus?; convergeError? }`（去重后字段沿用；`outcome.action` 新增 `'merged'`）
  - `MultiTargetSyncResult { results; finalVaultJson; adopted; conflicts: EntryConflict[]; states: Record<string, SourceSyncState> }`（`hashes` 字段删除——基线改 `states` 承载）
  - `syncMultipleTargets(opts: { targets: MultiTargetInput[]; vaultJson; password; profile?; deviceId; mode?: 'apply' | 'preview'; onConflictBackup? }): Promise<MultiTargetSyncResult>`
  - 错误语义：targets 为空或无 enabled primary → 抛 `Error('no primary target')`（MCP 触发器 reason 复用此消息）

- [ ] **Step 1: Write the failing test**（改造既有 multiTarget 测试为 rev 装配；关键新增用例）

```ts
it('primary 裁决后 replica 推平：replica 内容一致且 rev 匹配 → 跳过零写', async () => {})
it('replica 内容落后 → 推平 final（newRev=replica remote+1），states.primaryRev 更新', async () => {})
it('replica rev 领先（误配置他设备写入）→ 先拉取与 final 三方合并再推平，不丢数据', async () => {})
it('单目标失败不阻断：primary 失败时……（primary 失败=本轮终止该源，replica 仍按 final=本地内容推平）', async () => {})
it('无 primary → 抛 no primary target', async () => {})
it('preview 模式：任一目标 merged → 不写云，conflicts 汇总返回', async () => {})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/core exec vitest run src/cloud/multiTarget.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**（流程）

```
1. primary = targets.find(t => t.source.enabled && t.source.role === 'primary')；无 → throw
2. r0 = syncWithCloudRev(primary, mode)   // try/catch → outcome=null 继续 replica（final=本地）
3. final = r0.appliedVaultJson ?? vaultJson；primaryState = 按outcome推导（见下）
4. for replica of targets.filter(role==='replica' && enabled):
     r = syncWithCloudRev(replica, state=replica.state, mode)
     若 r.action==='merged'/'downloaded' 且 applied ≠ final → final 与 applied 再 mergeVaults并入 final（误配置保护）
     推平：若 replica 内容 ≠ final → pushEnvelope(v3, rev=replicaRemoteRev+1)；outcome 改写 uploaded；失败记 convergeError
5. states[key] 推导：
     uploaded → { lastKnownRemoteRev: newRev, baseSnapshot: 该源实际上传内容(final), primaryRev: {各replica: 其newRev} }
     downloaded/merged → { lastKnownRemoteRev: remoteRev, baseSnapshot: applied }
     in-sync → 原状态保留
   conflicts 汇总 = 各目标 outcome.conflicts 拼接
```

（`errorStatus` 透传、收敛失败 `convergeError` 语义沿用既有实现口径。）

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @totp/core exec vitest run src/cloud/multiTarget.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cloud/multiTarget.ts packages/core/src/cloud/multiTarget.test.ts packages/core/src/index.ts
git commit -m "feat(core): 多目标同步改primary裁决+replica收敛复制（rev基线）"
```

---

### Task 9: cloudRunner 改造（single-flight 链、内容门持久化、新 deps、pull 合并感知）

**Files:**
- Modify: `packages/ui/src/components/cloudRunner.ts`
- Test: `packages/ui/src/components/cloudRunner.test.ts`（既有则改造，无则新建；fake deps 模式仿 `apps/desktop/src/cloudSyncConflict.test.ts`）

**Interfaces:**
- Consumes: Task 4/7/8 全部产物
- Produces（`CloudRunnerDeps` 增量；全部必填除非注明）:
  - `loadSyncState(sourceId: string): Promise<SourceSyncState>`
  - `saveSyncState(sourceId: string, state: SourceSyncState): Promise<void>`
  - `deviceId(): Promise<string>`
  - `loadContentHash(): Promise<string | null>` / `saveContentHash(h: string | null): Promise<void>`（替代实例内存 `lastAutoVaultHash`）
  - `onManualConfirm?(preview: { conflicts: EntryConflict[]; mergeDegraded: boolean; sourceName: string }): Promise<boolean>`（手动合并预览确认；缺省=直接执行）
  - `onProgress?(done: number, total: number): void`
  - `onConflicts?(count: number): void`（冲突提示：badge/横幅；0=清除）
  - 删除：`loadTargetHash`/`saveTargetHash`（由 `loadSyncState`/`saveSyncState` 取代）
- 行为：
  - `run(mode)` 串行化：实例闭包内 `chain` promise 链——手动到来时自动在跑则排队（spec §5 ④），替换原 `busy` 直接 return
  - auto 内容门：`loadContentHash()` 持久基线 + `contentHash(vaultJson)`，成功后 `saveContentHash`
  - manual：先 `mode:'preview'` 跑一轮，任一目标 `merged` 且 `onManualConfirm` 返回 false → 中止（recordStatus 记跳过）；返回 true → `mode:'apply'` 重跑
  - pull 通道：走 `syncWithCloudRev` 只读形态（downloaded/merged 都只 `persistAdopted` 不写云；merged 冲突进 conflicts 提示）
  - 每轮结束 `onConflicts(未裁决冲突数)`（读 store mergeConflicts 长度，由宿主闭包提供——deps `conflictCount?(): number`）
  - `recordStatus` summary 新增 `'merged'`/降级文案 key：`cloudRunner.action.merged`、`cloudRunner.action.mergedDegraded`

- [ ] **Step 1: Write the failing test**（关键用例）

```ts
it('auto：内容门持久化——新 runner 实例（模拟页面重开）loadContentHash 命中 → 零网络', async () => {
  // saveContentHash 落到外部 map；第二个 createCloudSyncRunner 实例共享 map；断言 fakeBackend.puts === 0
})
it('single-flight：并发 run() 排队串行完成（第二排在第一后），均执行而非丢弃', async () => {
  // fake loadSources 挂起首拍；两次 run() 都 await；断言两次 recordStatus 都被调用
})
it('manual：merge 预览 → onManualConfirm=false → 不写云；true → apply 完成', async () => {})
it('pull：云端较新且本地也变 → 本地变合并结果被采纳，但云端零写（pull-only）', async () => {})
it('进度回调：onProgress 逐源推进 (1/2) (2/2)', async () => {})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/ui exec vitest run src/components/cloudRunner.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**（按 Interfaces 块重写 `createCloudSyncRunner`；保留守护与 recordStatus 骨架、keep 滚动删除逻辑；`pullAll` 内部改为对每源 `syncWithCloudRev`（永不 pushEnvelope）；装配 `inputs` 时补 `source` 与 `state`；`makeBackend` 不变）

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @totp/ui exec vitest run src/components/cloudRunner.test.ts`
Expected: PASS（注意 `apps/desktop/src/cloudSyncConflict.test.ts` 与其他 runner 消费方测试需同步改造到新 deps——随本任务一并修复）

- [ ] **Step 5: 全仓回归 + Commit**

Run: `pnpm -r --no-bail run test && pnpm -r run typecheck`

```bash
git add -A packages/ui/src/components/cloudRunner.ts packages/ui/src/components/cloudRunner.test.ts apps/desktop/src/cloudSyncConflict.test.ts
git commit -m "feat(ui): 云同步runner换rev编排（single-flight链+持久内容门+合并预览+进度）"
```

---

### Task 10: store 增量（DEK seal、mergeConflicts、冲突裁决 op）与双端装配

**Files:**
- Modify: `packages/ui/src/store.ts`（导出 `sealWithDek`/`unsealWithDek`/`mergeConflicts` ref/`resolveMergeConflictOp`/`conflictCount`；解锁时装载 mergeConflicts）
- Create: `packages/core/src/merge/conflictStore.ts`（`loadMergeConflicts(adapter, seal?)` / `saveMergeConflicts(adapter, list, seal?)`，key `mergeConflicts`，上限 100 条裁最旧；DEK seal 同 Task 4 语义）+ test `conflictStore.test.ts`
- Modify: `apps/desktop/src/App.vue:404-438`（runner deps 换新接口：`loadSyncState/saveSyncState`（adapter+store seal）、`deviceId`、`loadContentHash/saveContentHash`（localStorage 键 `cloudContentHash`）、`onManualConfirm`（接 CloudCard 对话框，见 Task 11 桥）、`onProgress`、`onConflicts`、`conflictCount`）
- Modify: `apps/extension/src/cloudRunnerFactory.ts`（同上；`loadContentHash/saveContentHash` 落 `storageAdapter` 键 `cloudContentHash`）
- Create: `apps/extension/src/conflictCopies.ts`（冲突副本 storage.local 列表：`addConflictCopy(bytes, sourceId)` 命名 `conflict-{id}-{ts}`、上限 5 份滚动删、`listConflictCopies()`、`removeConflictCopy(name)`、`exportConflictCopy(name)` 触发下载）+ test
- Modify: `apps/extension/src/cloudRunnerFactory.ts:69-71`（`saveConflictBackup` 改调 `addConflictCopy`，废除自动 `downloadConflictBackup` 自动触发——导出仅由 UI 显式调用）
- Test: `packages/core/src/merge/conflictStore.test.ts`、`apps/extension/src/conflictCopies.test.ts`

**Interfaces:**
- Consumes: Task 4 Seal、`store.ts` 内部 `dekByWin`/`encryptVaultWithDek`/`decryptVaultWithDek`
- Produces: `store.sealWithDek(plain): Promise<string | null>`（锁定/未启用加密 → null）；`store.mergeConflicts: Ref<EntryConflict[]>`；`store.resolveMergeConflictOp(entryId, pick: 'ours' | 'theirs'): Promise<void>`（写回 vault + 从列表删除 + commit 触发常规同步）

- [ ] **Step 1: conflictStore 与 conflictCopies 的失败测试**（模式同 Task 4/extension 既有 storage fake；上限裁剪用例必含）

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @totp/core exec vitest run src/merge/conflictStore.test.ts && cd apps/extension && pnpm exec vitest run src/conflictCopies.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**（core conflictStore 按 Task 4 模式；extension conflictCopies 用 `chrome.storage.local` 经既有 `storageAdapter` 键 `conflictCopies`，元素 `{ name, at, bytesBase64 }`；store.ts 的 seal 助手：

```ts
async function sealWithDekOp(plain: string): Promise<string | null> {
  const dek = dekByWin.get(windowId)
  if (dek === undefined) return null // 锁定/未启用加密
  return JSON.stringify(await encryptVaultWithDek(dek, plain))
}
```

`resolveMergeConflictOp`：`pick==='theirs'` 时以 conflict.theirs 替换/恢复条目（theirs=null → 删除条目），ours=null 且 pick==='ours' → 恢复 base；写经 `commit`（自动推进 vault.rev 与同步触发）。）

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm -r --no-bail run test && pnpm -r run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/merge/conflictStore.ts packages/core/src/merge/conflictStore.test.ts packages/core/src/index.ts packages/ui/src/store.ts apps/desktop/src/App.vue apps/extension/src/cloudRunnerFactory.ts apps/extension/src/conflictCopies.ts apps/extension/src/conflictCopies.test.ts
git commit -m "feat(ui,ext): DEKseal助手/冲突裁决op与双端runner新deps装配，扩展冲突副本入列表"
```

---

### Task 11: CloudCard 冲突区块 + 差异预览 + 进度 + 配置归位 + 同步健康条

**Files:**
- Create: `packages/ui/src/components/MergeConflictList.vue`（条目冲突裁决列表：issuer/label + 「取本地方/取云地方」按钮）
- Create: `packages/ui/src/components/SyncHealthBar.vue`（两通道状态汇总条：云同步状态 + 浏览器同步状态 + 冲突数徽标）
- Create: `packages/ui/src/components/MergePreviewDialog.vue`（manual 预览：本地新增/云端新增/冲突三段列表 + 确认/取消）
- Modify: `packages/ui/src/components/CloudCard.vue`（挂载上述组件；同步中逐源 spinner + 「x/y 源完成」；「冲突」区块；云凭据失效警示移入本卡）
- Modify: `packages/ui/src/components/SyncCard.vue:111-116`（删除云凭据失效警示——职责移交 CloudCard）
- Modify: `packages/ui/src/pages/SyncPage.vue`（顶部插 `SyncHealthBar`）
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`（`cloudCard.conflict*`、`cloudCard.preview*`、`cloudRunner.action.merged`、`cloudRunner.action.mergedDegraded`、`syncHealth.*` 等键）
- Test: `packages/ui/src/components/MergeConflictList.test.ts`、`MergePreviewDialog.test.ts`

**Interfaces:**
- Consumes: Task 10 的 `store.mergeConflicts`/`resolveMergeConflictOp`；runner 的 `onManualConfirm`/`onProgress`/`onConflicts` 桥（宿主 App.vue 用一个模块级 pending resolver 把 runner 回调转成 CloudCard 对话框——`provide/inject` 或既有事件模式，实现取简）

- [ ] **Step 1: 组件失败测试**（MergeConflictList：渲染冲突行、点「取本地方」emit resolve(entryId,'ours')；MergePreviewDialog：三段渲染、确认/取消 emit）

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @totp/ui exec vitest run src/components/MergeConflictList.test.ts src/components/MergePreviewDialog.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement 组件与 CloudCard 接线**（MdCard/MdButton 既有组件体系；进度状态由 CloudCard 内 ref 承接 runner 回调；凭据失效警示迁移=把 `SyncCard.vue:111-116` 的模板块与对应 props 移到 CloudCard，options App.vue 传参随之调整）

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm -r --no-bail run test && pnpm -r run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components packages/ui/src/pages/SyncPage.vue packages/ui/src/i18n
git commit -m "feat(ui): 冲突裁决列表/合并预览/逐源进度与健康摘要条，凭据警示归位CloudCard"
```

---

### Task 12: GDrive/OneDrive OAuth 刷新

**Files:**
- Modify: `packages/core/src/cloud/backend.ts`（`CloudCred` gdrive/onedrive 变体增可选 `oauth?: { clientId: string; clientSecret: string; refreshToken: string }`）
- Modify: `packages/core/src/cloud/gdrive.ts`、`packages/core/src/cloud/onedrive.ts`（请求前取会话 access token；401 且有 oauth → 刷新重试一次）
- Create: `packages/core/src/cloud/oauthRefresh.ts`（`refreshAccessToken(cred): Promise<string>`，模块级 `Map<credKey, {token, expiresAt}>` 会话缓存；credKey=clientId+refreshToken 的 sha256 前 16 字符）+ test `oauthRefresh.test.ts`
- Modify: `packages/ui/src/components/CloudCard.vue`（凭据表单模式切换：手工 token / OAuth 三字段；i18n）
- Test: `packages/core/src/cloud/oauthRefresh.test.ts`、`gdrive.test.ts` 追加 401→刷新→重试用例（fetch fake 模式仿既有后端测试）

**Interfaces:**
- Produces: `oauth?: { clientId; clientSecret; refreshToken }`（凭据整体经 `saveSourceCredOp` 入 secretBag，敏感字段天然 DEK 加密——无需新存储通道）

- [ ] **Step 1: Write the failing test**

```ts
it('401 且带 oauth → POST token 端点刷新并重试成功', async () => {
  // fake fetch：首次返回 401，断言第二次请求带新 token；token 端点收到 clientId/secret/refreshToken
})
it('会话缓存未过期不重复刷新', async () => {})
it('刷新失败（refresh_token 失效）→ 抛原 401 语义错误', async () => {})
it('无 oauth 字段 → 行为与现状一致（401 直接抛）', async () => {})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @totp/core exec vitest run src/cloud/oauthRefresh.test.ts src/cloud/gdrive.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**（gdrive: `https://oauth2.googleapis.com/token`，grant_type=refresh_token；onedrive: `https://login.microsoftonline.com/common/oauth2/v2.0/token`。刷新调用走既有 `cloudFetch` 错误翻译通道之外的原生 fetch（token 端点非 API 域），失败抛结构化 401。）

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm -r --no-bail run test && pnpm -r run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cloud packages/ui/src/components/CloudCard.vue packages/ui/src/i18n
git commit -m "feat(core,ui): GDrive/OneDrive OAuth refresh_token自动刷新（会话缓存+401重试）"
```

---

### Task 13: 双设备收敛集成测试（E2E 口径）

**Files:**
- Create: `packages/core/src/cloud/twoDevice.test.ts`

**Interfaces:**
- Consumes: Task 3-8 全部（fake CloudBackend 模拟云对象，两个独立 StorageAdapter 模拟设备）

- [ ] **Step 1: Write the integration test**（验收口径 1/2 的自动化形态）

```ts
// 场景1：两设备改不同条目 → 各自轮转同步后收敛，双方条目都在，无整库覆盖
// 场景2：同条目两设备改成不同内容 → 合并取新者 + conflicts 非空；裁决后（按 pick 重写）二次同步收敛且 conflicts 清空
// 场景3：v2 旧信封 → 首轮同步后云端对象升级为 v3（readSyncHeader 非 null）
// 每场景断言：两端 loadVault 内容一致、云对象 rev 单调、无多余 conflict 副本文件
```

（装配：`device(vaultJson)` 返回 `{ adapter, state, deviceId }`；同步一步 = `syncMultipleTargets({ targets: [primary], ... })` + 持久 state 回写；两设备交替执行直至双侧 in-sync。）

- [ ] **Step 2: Run to verify fail/pass cycle**（本任务为纯测试任务：先确认新编排下测试通过；若暴露编排缺陷，修复归属对应任务的文件并在该任务内补回归用例）

Run: `pnpm --filter @totp/core exec vitest run src/cloud/twoDevice.test.ts`
Expected: PASS（3 场景全绿）

- [ ] **Step 3: 全仓回归**

Run: `pnpm -r --no-bail run test && pnpm -r run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/cloud/twoDevice.test.ts
git commit -m "test(core): 双设备收敛集成测试（并发合并/冲突裁决/v3升级）"
```

---

## Self-Review 记录

- Spec 覆盖：§1→Task 1/2/3/4/7；§2→Task 6/8；§3→Task 5/7/8；§4→Task 10/11；§5④→Task 9、⑤→Task 11、⑥→Task 9/11、⑦→Task 12；§7 测试→各任务+Task 13。② 按裁定不实施。
- 类型一致性：`SourceSyncState`（Task 4）→ Task 7/8/9 同名同形；`EntryConflict`（Task 5）→ Task 7/8/10/11 同名同形；`syncWithCloudRev`/`syncMultipleTargets` 签名 Task 7→8→9 传递一致。
- 已知取舍：`isSyncEnvelope` 独立实现字段校验（Task 3 示意中的短路写法禁止）；`OtpEntry.updatedAt` 缺省 0、tie 判云端胜——旧数据首合并即全量入冲突列表属可接受一次性成本（裁决 UI 提供一键取云地方）。
