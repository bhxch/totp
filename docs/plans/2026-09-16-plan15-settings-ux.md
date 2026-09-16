# 设置体验与 M3 合规 实施计划（plan15）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 落地 `docs/plans/2026-09-16-settings-ux-design.md`（D1–D6）：口令聚合+备份口令入库、变更后/定时自动触发+变更检测、桌面备份目录与云端目标路径、云同步多目标、说明文案、M3 字阶 token 化与视觉修正。

**Architecture:** 纯逻辑全部下沉 `packages/core`（决策/调度/信封推送/目标路径/口令保管），UI 卡片只做展示与会话态接线，两端宿主只做平台适配（Tauri 命令 / chrome API）。复用点：store 既有 `onCommitted` 队列回调作变更触发统一入口；`DpapiUnlockOps` 泛化为三平台 osAutoUnlock；`syncWithCloud` 三分支原样保留、多目标编排叠加其上。

**Tech Stack:** TypeScript + Vue3 + vitest 2（core=node / ui=jsdom+@vue/test-utils）+ Tauri 2（Rust）+ WXT。两端双支持：desktop 全功能；extension 自动触发仅云同步（会话口令约束，见 Task 12 的设计勘误）。

**Spec:** `docs/plans/2026-09-16-settings-ux-design.md`。上游事实核查结论（写码前必读的三个陷阱）：

1. `packages/ui/src/store.ts:54-59` `replaceVault` 逐字段拷贝——Vault 新增顶层字段**必须**在此同步拷贝，否则每次写盘被清空。
2. settings 走独立明文存储键（`vaultStore.ts:21`），不经 DEK——备份口令只能放 Vault 内（随库加密），绝不能放 settings。
3. cloudRev 持久化端口是 `CloudPlatform.loadHash/saveHash`（desktop=AppData `cloudRev` 键 / extension=storage `cloudRev` 键）——多目标需按 backend 键各自存。

**测试约定：** core 测试在 `packages/core/test/*.test.ts`（vitest node）；ui 测试在 `packages/ui/test/*.test.ts`（jsdom+@vue/test-utils）；运行 `pnpm --filter @totp/core test` / `pnpm --filter @totp/ui test`；typecheck `pnpm -r run typecheck`。每任务先写失败测试。新增 core/ui 模块要求行覆盖 100%（Task 17 用 coverage 验证）。

---

## 里程碑总览

| 阶段 | 任务 | 内容 |
|---|---|---|
| A core 纯逻辑 | 1–4 | vault 口令字段 / 自动运行决策+调度器 / 目标路径 / 多目标编排 |
| B ui 层 | 5–9 | store 会话口令 / 备份口令卡 / BackupCard 改造 / ImportCard+SecurityCard 文案 |
| C 宿主接线 | 10–13 | desktop 目录+触发器 / desktop 云多目标 / extension 云多目标+触发器 / CloudCard 目标列表 |
| D 解锁与视觉 | 14–16 | osAutoUnlock 三平台 / 字阶 token 化 / M3 审查报告+修正 |
| E 收尾 | 17 | 文档勘误 + 全量验证（含 coverage） |

依赖：A→B→C 顺序严格；D 可与 C 并行；17 最后。

---

### Task 1: core — Vault 备份口令字段与保管纯函数

**Files:**
- Modify: `packages/core/src/model.ts:35-40`（Vault 增可选字段）
- Create: `packages/core/src/backup/vaultSecret.ts`
- Test: `packages/core/test/vaultSecret.test.ts`

**Step 1: 写失败测试**

```ts
// packages/core/test/vaultSecret.test.ts
import { describe, expect, it } from 'vitest'
import { createVault } from '../src/vault'
import { readVaultBackupSecret, withVaultBackupSecret } from '../src/backup/vaultSecret'

describe('vault 备份口令保管', () => {
  it('未设置时读出 null', () => {
    expect(readVaultBackupSecret(createVault())).toBeNull()
  })
  it('写入后可读回', () => {
    const v = withVaultBackupSecret(createVault(), '口令A')
    expect(readVaultBackupSecret(v)).toBe('口令A')
  })
  it('null 与空串均为清除', () => {
    expect(readVaultBackupSecret(withVaultBackupSecret(createVault(), ''))).toBeNull()
    expect(readVaultBackupSecret(withVaultBackupSecret(createVault(), null))).toBeNull()
  })
  it('覆盖写入', () => {
    const v = withVaultBackupSecret(withVaultBackupSecret(createVault(), '旧'), '新')
    expect(readVaultBackupSecret(v)).toBe('新')
  })
  it('不影响其他字段与 updatedAt 刷新', () => {
    const base = createVault()
    const v = withVaultBackupSecret(base, 'x')
    expect(v.version).toBe(1); expect(v.entries).toEqual([])
    expect(v.updatedAt).toBeGreaterThanOrEqual(base.updatedAt)
  })
})
```

**Step 2: 跑测确认失败** — `pnpm --filter @totp/core test -- vaultSecret` → FAIL（模块不存在）。

**Step 3: 实现**

```ts
// packages/core/src/backup/vaultSecret.ts
import type { Vault } from '../model'

/** 库内保管的备份口令（仅随 DEK 加密的 vault JSON 落盘/同步；明文库禁存，守护在 ui store 层） */
export function readVaultBackupSecret(vault: Vault): string | null {
  const s = vault.backupSecret
  return typeof s === 'string' && s.length > 0 ? s : null
}

export function withVaultBackupSecret(vault: Vault, secret: string | null): Vault {
  const next: Vault = { ...vault, updatedAt: Date.now() }
  if (secret === null || secret.length === 0) delete next.backupSecret
  else next.backupSecret = secret
  return next
}
```

`model.ts` Vault 增一行：`backupSecret?: string`。

**Step 4: 跑测通过** → **Step 5: Commit**

```bash
git add packages/core/src/model.ts packages/core/src/backup/vaultSecret.ts packages/core/test/vaultSecret.test.ts
git commit -m "feat(core): vault备份口令保管字段与纯函数(D1前置)"
```

---

### Task 2: core — 自动运行决策 + 可注入定时器调度器

**Files:**
- Create: `packages/core/src/backup/autoRun.ts`
- Test: `packages/core/test/autoRun.test.ts`

**Step 1: 写失败测试**

```ts
// packages/core/test/autoRun.test.ts
import { describe, expect, it, vi } from 'vitest'
import { decideAutoRun } from '../src/backup/autoRun'
import { createAutoRunScheduler } from '../src/backup/autoRunScheduler'

describe('decideAutoRun', () => {
  const base = { currentHash: 'h2', lastHash: 'h1', locked: false, hasSecret: true }
  it('内容变化→run', () => expect(decideAutoRun(base)).toEqual({ action: 'run' }))
  it('内容未变→skip unchanged', () =>
    expect(decideAutoRun({ ...base, lastHash: 'h2' })).toEqual({ action: 'skip', cause: 'unchanged' }))
  it('无基线(首次)→run', () =>
    expect(decideAutoRun({ ...base, lastHash: null })).toEqual({ action: 'run' }))
  it('锁定→skip locked（优先于未变判断）', () =>
    expect(decideAutoRun({ ...base, lastHash: 'h2', locked: true })).toEqual({ action: 'skip', cause: 'locked' }))
  it('无会话口令→skip no-secret', () =>
    expect(decideAutoRun({ ...base, hasSecret: false })).toEqual({ action: 'skip', cause: 'no-secret' }))
})

describe('createAutoRunScheduler', () => {
  it('变更防抖合并：多次 notify 只在窗口后跑一次', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(undefined)
    const s = createAutoRunScheduler({ debounceMs: 10_000, intervalMs: () => null, run })
    s.notifyChanged(); s.notifyChanged(); s.notifyChanged()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('change')
    vi.useRealTimers()
  })
  it('防抖窗口内再次变更则重置计时', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(undefined)
    const s = createAutoRunScheduler({ debounceMs: 10_000, intervalMs: () => null, run })
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(5_000)
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('定时启用时按间隔触发 run(interval)，未启用不触发', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(undefined)
    let interval: number | null = 60_000
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => interval, run })
    s.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledWith('interval')
    expect(run.mock.calls.filter((c) => c[0] === 'interval').length).toBe(2)
    interval = null // 动态关闭
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run.mock.calls.filter((c) => c[0] === 'interval').length).toBe(2)
    s.stop()
    vi.useRealTimers()
  })
  it('stop 后变更不再触发', async () => {
    vi.useFakeTimers()
    const run = vi.fn().mockResolvedValue(undefined)
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => null, run })
    s.notifyChanged(); s.stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('上一次 run 未结束时不重叠触发', async () => {
    vi.useFakeTimers()
    let resolveRun!: () => void
    const run = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRun = r }))
    const s = createAutoRunScheduler({ debounceMs: 1_000, intervalMs: () => 1_000, run })
    s.start(); s.notifyChanged()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1)
    s.notifyChanged()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run).toHaveBeenCalledTimes(1) // 仍在执行，跳过
    resolveRun(); await vi.advanceTimersByTimeAsync(0)
    vi.useRealTimers()
  })
})
```

**Step 2: 跑测确认失败** — `pnpm --filter @totp/core test -- autoRun` → FAIL。

**Step 3: 实现**

```ts
// packages/core/src/backup/autoRun.ts
export type AutoRunDecision = { action: 'run' } | { action: 'skip'; cause: 'unchanged' | 'locked' | 'no-secret' }

/** 自动备份/同步执行前判定（手动操作不经此函数，始终执行） */
export function decideAutoRun(input: {
  currentHash: string | null
  lastHash: string | null
  locked: boolean
  hasSecret: boolean
}): AutoRunDecision {
  if (input.locked) return { action: 'skip', cause: 'locked' }
  if (!input.hasSecret) return { action: 'skip', cause: 'no-secret' }
  if (input.lastHash !== null && input.lastHash === input.currentHash) return { action: 'skip', cause: 'unchanged' }
  return { action: 'run' }
}
```

```ts
// packages/core/src/backup/autoRunScheduler.ts
export type AutoRunReason = 'change' | 'interval'

export interface SchedulerOptions {
  debounceMs: number
  /** 返回当前应启用的定时间隔毫秒；null=未启用。每次触发后重新求值（支持运行中改配置） */
  intervalMs: () => number | null
  run: (reason: AutoRunReason) => Promise<void>
}

export interface AutoRunScheduler {
  notifyChanged(): void
  start(): void
  stop(): void
}

/** 定时策略与宿主解耦：desktop 传真定时器，测试传 fake；extension 仅用 change 通道（见 plan Task 12 勘误） */
export function createAutoRunScheduler(opts: SchedulerOptions): AutoRunScheduler {
  let changeTimer: ReturnType<typeof setTimeout> | undefined
  let intervalTimer: ReturnType<typeof setInterval> | undefined
  let running = false

  async function invoke(reason: AutoRunReason): Promise<void> {
    if (running) return
    running = true
    try { await opts.run(reason) } finally { running = false }
  }

  return {
    notifyChanged() {
      if (changeTimer !== undefined) clearTimeout(changeTimer)
      changeTimer = setTimeout(() => { changeTimer = undefined; void invoke('change') }, opts.debounceMs)
    },
    start() {
      if (intervalTimer !== undefined) return
      intervalTimer = setInterval(() => {
        const ms = opts.intervalMs()
        if (ms === null) return
        void invoke('interval')
      }, Math.max(30_000, /* 轮询粒度 */ 30_000))
    },
    stop() {
      if (changeTimer !== undefined) { clearTimeout(changeTimer); changeTimer = undefined }
      if (intervalTimer !== undefined) { clearInterval(intervalTimer); intervalTimer = undefined }
    },
  }
}
```

> 实现注意：`intervalMs()` 语义按测试裁定为「间隔值本身」而非开关——`setInterval` 以**最小粒度 30s** 轮询、由 `intervalMs()` 返回 null 关闭；真正的「到点判断」在宿主 run 内用 `lastRunAt + intervalMinutes` 比较（Task 10/12 宿主实现给出 `shouldRunInterval(now, lastRunAt, intervalMinutes): boolean` 小函数并配测试）。**若实现时发现上述测试第三条与轮询粒度冲突，以测试为准改调度器：`start()` 直接 `setInterval(tick, 30_000)`，tick 内比较 `Date.now() - lastIntervalRunAt >= intervalMs()` 才 invoke 并刷新 lastIntervalRunAt。**此语义更贴测试，优先采用：

修正后的 tick 语义（以此为准）：调度器内部维护 `lastIntervalRunAt`，`start()` 时置为 `Date.now()`；tick 每 30s 检查 `intervalMs() !== null && now - lastIntervalRunAt >= intervalMs()` → invoke('interval') 并刷新。上测试第三条（60s 间隔、120s 内触发 2 次）在该语义下成立。

**Step 4: 跑测通过** → **Step 5: Commit**

```bash
git add packages/core/src/backup/autoRun.ts packages/core/src/backup/autoRunScheduler.ts packages/core/test/autoRun.test.ts
git commit -m "feat(core): 自动运行决策与可注入定时器调度器(D2)"
```

---

### Task 3: core — 云目标路径解析 + CloudCred 增 objectPath

**Files:**
- Modify: `packages/core/src/cloud/backend.ts:16-60`（五种 Cred 各增 `objectPath?: string`）
- Create: `packages/core/src/cloud/targetPath.ts`
- Test: `packages/core/test/targetPath.test.ts`

**Step 1: 写失败测试**

```ts
// packages/core/test/targetPath.test.ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_OBJECT_PATH, resolveObjectPath } from '../src/cloud/targetPath'

describe('resolveObjectPath', () => {
  it('无 objectPath 时各后端用默认值', () => {
    expect(resolveObjectPath({ backend: 'webdav', serverUrl: 'https://x', username: 'u', password: 'p' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveObjectPath({ backend: 'onedrive', accessToken: 't' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveObjectPath({ backend: 'gdrive', accessToken: 't' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveObjectPath({ backend: 'gist', token: 't', gistId: 'g' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveObjectPath({ backend: 's3', region: 'r', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' })).toBe(DEFAULT_OBJECT_PATH)
  })
  it('自定义值生效（trim）', () => {
    expect(resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: ' dir/my.totpbackup ' })).toBe('dir/my.totpbackup')
  })
  it('空白串回退默认', () => {
    expect(resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: '   ' })).toBe(DEFAULT_OBJECT_PATH)
  })
  it('拒绝路径穿越与非法字符', () => {
    expect(() => resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'a/../b' })).toThrow()
    expect(() => resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'a\u0000b' })).toThrow()
  })
})
```

**Step 2: 失败** → **Step 3: 实现**

```ts
// packages/core/src/cloud/targetPath.ts
import type { CloudCred } from './backend'

export const DEFAULT_OBJECT_PATH = 'totp-backup.totpbackup'

/** 云端对象路径：凭据可自定义（objectPath），缺省回落历史固定值；写盘前校验防穿越 */
export function resolveObjectPath(cred: CloudCred): string {
  const raw = cred.objectPath?.trim()
  if (raw === undefined || raw === '') return DEFAULT_OBJECT_PATH
  if (raw.includes('\0')) throw new Error('云端路径含非法字符')
  const segments = raw.split(/[\\/]/).filter((s) => s !== '')
  if (segments.some((s) => s === '.' || s === '..')) throw new Error('云端路径不允许相对段（. / ..）')
  return segments.join('/')
}
```

backend.ts 五个 Cred 接口各加 `objectPath?: string`。

**Step 4: 通过** → **Step 5: Commit** `feat(core): 云目标路径解析与凭据objectPath字段(D4)`

---

### Task 4: core — 多目标同步编排（收敛规则）

**Files:**
- Modify: `packages/core/src/cloud/syncOrchestrator.ts`（导出 `pushEnvelope`；原 `syncWithCloud` 行为不变）
- Create: `packages/core/src/cloud/multiTarget.ts`
- Test: `packages/core/test/multiTarget.test.ts`

**Step 1: 写失败测试**（用最小 fake backend，envelope 用真实 `createBackupEnvelope/openBackupEnvelope`）

```ts
// packages/core/test/multiTarget.test.ts
import { describe, expect, it } from 'vitest'
import { createBackupEnvelope } from '../src/backup/envelope'
import { syncMultipleTargets, pushEnvelope } from '../src/cloud/multiTarget'
import type { CloudBackend } from '../src/cloud/backend'
import { sha256Hex } from '../src/crypto/sha256' // 以实际导出路径为准（syncOrchestrator 同源）

function fakeBackend(initial?: Uint8Array): CloudBackend & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  if (initial) store.set('p', initial)
  return {
    store,
    id: 'fake',
    async put(path, data) { store.set(path, data) },
    async get(path) { return store.get(path) ?? null },
    async delete(path) { store.delete(path) },
    async exists(path) { return store.has(path) },
  }
}

const A = JSON.stringify({ version: 1, entries: [{ label: 'A' }] })
const B = JSON.stringify({ version: 1, entries: [{ label: 'B' }] })

describe('pushEnvelope', () => {
  it('上传并回读校验', async () => {
    const b = fakeBackend()
    const r = await pushEnvelope({ backend: b, path: 'p', vaultJson: A, password: 'pw' })
    expect(r.hash).toBe(await sha256Hex(A))
    expect(b.store.has('p')).toBe(true)
  })
})

describe('syncMultipleTargets', () => {
  it('本地新→双目标都 uploaded', async () => {
    const t1 = fakeBackend(), t2 = fakeBackend()
    const r = await syncMultipleTargets({
      targets: [ { key: 'webdav', backend: t1, path: 'p', hash: null }, { key: 'onedrive', backend: t2, path: 'p', hash: null } ],
      vaultJson: A, password: 'pw',
    })
    expect(r.adopted).toBe(false)
    expect(r.results.map((x) => x.outcome?.action)).toEqual(['uploaded', 'uploaded'])
    expect(t1.store.get('p')).toEqual(t2.store.get('p'))
  })

  it('目标2云端较新→采纳，并把胜出版本回推目标1（收敛）', async () => {
    const newerEnv = await createBackupEnvelope(B, 'pw')
    const t1 = fakeBackend() // 空：目标1从没同步过 → uploaded(旧本地)
    const t2 = fakeBackend(new TextEncoder().encode(JSON.stringify(newerEnv))) // 云端有较新 B
    const r = await syncMultipleTargets({
      targets: [ { key: 'webdav', backend: t1, path: 'p', hash: null }, { key: 'onedrive', backend: t2, path: 'p', hash: null } ],
      vaultJson: A, password: 'pw',
    })
    expect(r.adopted).toBe(true)
    expect(r.finalVaultJson).toBe(B)
    // 收敛：目标1最终也被推送为 B
    const env1 = JSON.parse(new TextDecoder().decode(t1.store.get('p')!))
    expect(await import('../src/backup/envelope').then((m) => m.openBackupEnvelope(env1, 'pw'))).toBe(B)
    // 目标2不再变化（仍是 B 的信封，可保持原样或重推，判定键：hash 相等则跳过）
  })

  it('全部 in-sync → adopted=false 且不重写', async () => {
    const env = await createBackupEnvelope(A, 'pw')
    const bytes = new TextEncoder().encode(JSON.stringify(env))
    const t = fakeBackend(bytes)
    const h = await sha256Hex(A)
    const r = await syncMultipleTargets({
      targets: [{ key: 'k', backend: t, path: 'p', hash: h }],
      vaultJson: A, password: 'pw',
    })
    expect(r.adopted).toBe(false)
    expect(r.results[0].outcome?.action).toBe('in-sync')
  })

  it('单目标失败不阻断其余目标，错误记入该目标结果', async () => {
    const bad = fakeBackend(); bad.get = async () => { throw new Error('网络错误') }
    const good = fakeBackend()
    const r = await syncMultipleTargets({
      targets: [ { key: 'bad', backend: bad, path: 'p', hash: null }, { key: 'good', backend: good, path: 'p', hash: null } ],
      vaultJson: A, password: 'pw',
    })
    expect(r.results[0].outcome).toBeNull()
    expect(r.results[0].error).toContain('网络错误')
    expect(r.results[1].outcome?.action).toBe('uploaded')
  })
})
```

**Step 2: 失败** → **Step 3: 实现**

`syncOrchestrator.ts`：把内部 `pushLocal`（加密→put→回读校验，:58-73）提为 `export async function pushEnvelope(opts: { backend; path; vaultJson; password }): Promise<{ hash: string }>`，`syncWithCloud` 内改调它，行为不变（既有 `cloudSync.test.ts` 全绿为准）。

```ts
// packages/core/src/cloud/multiTarget.ts
import { sha256Hex } from '../crypto/...'   // 与 syncOrchestrator 同源
import { pushEnvelope, syncWithCloud } from './syncOrchestrator'
import type { CloudBackend } from './backend'

export interface CloudTargetInput { key: string; backend: CloudBackend; path: string; hash: string | null }
export interface TargetResult { key: string; outcome: Awaited<ReturnType<typeof syncWithCloud>> | null; error?: string }
export interface MultiTargetSyncResult {
  results: TargetResult[]
  finalVaultJson: string
  /** 本轮是否从某目标采纳了较新的云端版本 */
  adopted: boolean
  /** 各目标最终基线 hash（宿主持久化用） */
  hashes: Record<string, string>
}

/**
 * 多目标同步（设计§6.2）：顺序遍历；每目标独立三分支；
 * 若某目标云端较新被采纳，则终局将胜出版本推给所有 hash 仍不一致的目标（收敛）。
 */
export async function syncMultipleTargets(opts: {
  targets: CloudTargetInput[]
  vaultJson: string
  password: string
  onConflictBackup?: (key: string, bytes: Uint8Array) => string | null | void | Promise<string | null | void>
}): Promise<MultiTargetSyncResult> {
  let current = opts.vaultJson
  let adopted = false
  const results: TargetResult[] = []
  const hashes: Record<string, string> = {}

  for (const t of opts.targets) {
    try {
      const outcome = await syncWithCloud({
        backend: t.backend, path: t.path, vaultJson: current, password: opts.password,
        localHash: t.hash,
        onConflictBackup: (bytes) => opts.onConflictBackup?.(t.key, bytes),
      })
      hashes[t.key] = outcome.hash
      if ((outcome.action === 'downloaded' || outcome.action === 'conflict-resolved') && outcome.envelopeJson !== undefined) {
        current = outcome.envelopeJson
        adopted = true
      }
      results.push({ key: t.key, outcome })
    } catch (e) {
      results.push({ key: t.key, outcome: null, error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (adopted) {
    const winnerHash = await sha256Hex(current)
    for (const t of opts.targets) {
      if (hashes[t.key] === winnerHash) continue
      try {
        const pushed = await pushEnvelope({ backend: t.backend, path: t.path, vaultJson: current, password: opts.password })
        hashes[t.key] = pushed.hash
        const prev = results.find((r) => r.key === t.key)
        if (prev && prev.outcome) prev.outcome = { ...prev.outcome, action: 'uploaded', envelopeJson: undefined, hash: pushed.hash }
      } catch (e) {
        results.find((r) => r.key === t.key)?.(void 0) // 占位：改为 results.push 追加 error 或在 TargetResult 增 secondError 字段——实现时裁定：TargetResult 增 `convergeError?: string`
      }
    }
  }

  return { results, finalVaultJson: current, adopted, hashes }
}
```

> 实现裁定：`TargetResult` 增 `convergeError?: string`；上面占位行改为 `prev.convergeError = e instanceof Error ? e.message : String(e)`（`prev` 可空需判空）。测试第 2 条补断言：收敛后 `results[0].outcome.action === 'uploaded'` 且 `hashes['webdav'] === await sha256Hex(B)`。

**Step 4: 通过 + 既有 `cloudSync.test.ts` 回归全绿** → **Step 5: Commit** `feat(core): 云同步多目标编排(独立基线+收敛规则,D6)`

---

### Task 5: ui store — 会话备份口令 + 入库守护 + replaceVault 修复

**Files:**
- Modify: `packages/ui/src/store.ts`（replaceVault:54-59 / lock:381-386 / disableEncryption / 返回对象:409-432）
- Test: `packages/ui/test/storeBackupSecret.test.ts`

**Step 1: 写失败测试**

```ts
// packages/ui/test/storeBackupSecret.test.ts
// 仿既有 store 测试的内存 adapter 工厂（若已有 makeStore 工具则复用）
import { describe, expect, it } from 'vitest'
import { createVueStore } from '../src/store'
import { makeMemoryAdapter } from './helpers' // 以既有测试的 adapter 工厂为准；无则本任务补一个

describe('store 备份口令会话与保管', () => {
  it('replaceVault 保留 backupSecret 字段（写盘不清空）', async () => {
    const s = createVueStore(makeMemoryAdapter())
    await s.commit((v) => ({ ...v, backupSecret: 'pw' }))
    expect((s.vault as any).backupSecret).toBe('pw')
  })
  it('未启用加密时 setBackupSecret(remember=true) 抛错且不入库', async () => {
    const s = createVueStore(makeMemoryAdapter())
    await expect(s.setBackupSecret('pw', true)).rejects.toThrow('需先启用加密')
    expect(s.backupSecret).toBe('pw') // 会话仍生效
    expect((s.vault as any).backupSecret).toBeUndefined()
  })
  it('启用加密后 remember=true 写入库；解锁后自动装载会话', async () => {
    const s = createVueStore(makeMemoryAdapter())
    await s.enableEncryption('库口令')
    await s.lock(); await s.unlock('库口令')
    await s.setBackupSecret('pw', true)
    expect((s.vault as any).backupSecret).toBe('pw')
    // 模拟重新解锁：锁定清会话，解锁后从库装载
    await s.lock(); await s.unlock('库口令')
    expect(s.backupSecret).toBe('pw')
  })
  it('remember=false 只入会话不入库', async () => {
    const s = createVueStore(makeMemoryAdapter())
    await s.enableEncryption('库口令'); await s.lock(); await s.unlock('库口令')
    await s.setBackupSecret('pw2', false)
    expect((s.vault as any).backupSecret).toBeUndefined()
    expect(s.backupSecret).toBe('pw2')
  })
  it('forgetBackupSecret 清会话并从库删除', async () => {
    const s = createVueStore(makeMemoryAdapter())
    await s.enableEncryption('库口令'); await s.lock(); await s.unlock('库口令')
    await s.setBackupSecret('pw', true)
    await s.forgetBackupSecret()
    expect(s.backupSecret).toBeNull()
    expect((s.vault as any).backupSecret).toBeUndefined()
  })
  it('lock 清会话口令', async () => {
    const s = createVueStore(makeMemoryAdapter())
    s.setBackupSecretWithoutRemember?.('pw') // 若无此方法则用 setBackupSecret('pw', false)
    await s.lock()
    expect(s.backupSecret).toBeNull()
  })
  it('关闭加密时清除库内保管口令', async () => {
    const s = createVueStore(makeMemoryAdapter())
    await s.enableEncryption('库口令'); await s.lock(); await s.unlock('库口令')
    await s.setBackupSecret('pw', true)
    await s.disableEncryption()
    expect((s.vault as any).backupSecret).toBeUndefined()
  })
})
```

**Step 2: 失败** → **Step 3: 实现（store.ts）**

1. `replaceVault`（:54-59）加一行：`vault.backupSecret = v.backupSecret`（注意 `delete` 语义：`if (v.backupSecret === undefined) delete vault.backupSecret`）。
2. 模块级：`const backupSecretByWin = new Map<string, string | null>()`，init 时同 dekByWin 初始化；`const currentBackupSecretRef = ...` 仿 `lockedByWinRef`。
3. `lock()`（:381）加：`backupSecretByWin.set(windowId, null); currentBackupSecretRef().value = null`。
4. 解锁装载：`applyDekAndUnlock`（:293-309）解密 `replaceVault` 成功后加 `backupSecretByWin.set(windowId, readVaultBackupSecret(vault)); currentBackupSecretRef().value = backupSecretByWin.get(windowId) ?? null`。
5. 新方法：
```ts
async function setBackupSecret(secret: string, remember: boolean): Promise<void> {
  if (secret.length === 0) throw new Error('备份口令不能为空')
  backupSecretByWin.set(windowId, secret)
  currentBackupSecretRef().value = secret
  if (remember) {
    if (!hasEncryption()) throw new Error('需先启用加密才能记住备份口令')
    await commit((v) => withVaultBackupSecret(v, secret))
  }
}
async function forgetBackupSecret(): Promise<void> {
  backupSecretByWin.set(windowId, null); currentBackupSecretRef().value = null
  if (hasEncryption()) await commit((v) => withVaultBackupSecret(v, null))
}
```
6. `disableEncryption`：解密出明文 vault 后、落盘前插 `next = withVaultBackupSecret(next, null)`（找到现有实现里 replaceVault/保存点插入；守护注释「明文库禁存口令」）。
7. 返回对象（:409-432）暴露 `backupSecret: currentBackupSecretRef()`（只读 ref）、`setBackupSecret`、`forgetBackupSecret`。

**Step 4: 通过 + 既有 store 相关 ui 测试回归** → **Step 5: Commit** `feat(ui): store会话备份口令+入库守护+replaceVault字段保留(D1)`

---

### Task 6: ui — BackupSecretCard（备份口令卡）

**Files:**
- Create: `packages/ui/src/components/BackupSecretCard.vue`
- Modify: `packages/ui/src/pages/SyncPage.vue`（挂卡，置于本地备份卡之前）、`packages/ui/src/index.ts`
- Test: `packages/ui/test/BackupSecretCard.test.ts`

**接口裁定**：props `{ store: VueStore }`（SyncPage 已持有 store，NavigationShell/宿主零改动）。模板结构仿 BackupCard 的 `.card` + `h2`（或 MdCard header，与 SyncPage 现有 `<MdCard><template #header>` 用法对齐——以 SyncPage 现状为准）。

**文案（设计§7.2）**：
- 说明：「用于加密本地备份文件与云端同步对象，两者共用；不落盘，锁定或关闭页面后需重新输入。」
- 记住开关 hint：「开启后随本库存放（需已启用加密），解锁库即可用，原生解锁（如 Windows Hello）同样生效。」

**Step 1: 写失败测试**（@vue/test-utils，选择器仿 BackupCard.test.ts：`input[type="password"]`、`button.secret-save`、`.md-switch`）

用例：①输入不一致不调用 setBackupSecret 且显示错误；②一致调用 `store.setBackupSecret(pw, rememberChecked)`；③`store.hasEncryption===false` 时记住开关 disabled + hint 显示；④清除按钮调用 `forgetBackupSecret`；⑤已设会话时显示状态行「会话内已启用」且输入框清空可用「更换」。

**Step 2: 失败** → **Step 3: 实现**

组件脚本：`const pw = ref(''); const confirmPw = ref(''); const remember = ref(false)`；保存：`validate → props.store.setBackupSecret(pw, remember.value) → 清空输入 + ok 消息`；状态行按 `props.store.backupSecret` 三态（未设置 / 会话内已启用 / 已随库存放——后两者区分用 `(props.store.vault as any).backupSecret != null`）。清除：`store.forgetBackupSecret()`。

**Step 4: 通过** → **Step 5: Commit** `feat(ui): BackupSecretCard备份口令卡(会话+记住到本库,D1)`

---

### Task 7: ui — BackupCard 改造（去口令框 / 会话口令 / 恢复回退 / 自动开关 / 目录行）

**Files:**
- Modify: `packages/ui/src/components/backupPlatform.ts`（接口增可选成员）、`packages/ui/src/components/BackupCard.vue`、`packages/ui/src/pages/SyncPage.vue`（传参）
- Test: `packages/ui/test/BackupCard.test.ts`（改造既有 5 用例 + 新增）

**接口追加（全部可选，宿主不提供即隐藏对应 UI）：**

```ts
// backupPlatform.ts 追加
export interface BackupAutoPrefs { onChange: boolean; onInterval: boolean; intervalMinutes: number }
getAutoPrefs?(): BackupAutoPrefs
setAutoPrefs?(p: BackupAutoPrefs): void | Promise<void>
getBackupDir?(): Promise<string | null>              // null=默认目录
setBackupDir?(dir: string | null): Promise<void>     // null=恢复默认
```

**Props 变更**：`{ platform: BackupPlatform | null; vaultJson: string; sessionSecret: string | null }`。

**模板/逻辑变更**：
1. 删除口令输入区（:147-150 的 `.pw-row` 两个 MdTextField）与 `password/confirmPw/validatePw`；「立即备份/导出到文件」按钮 `:disabled="busy || !sessionSecret"`，下方 hint「先在上方设置备份口令」（`v-if="!sessionSecret"`）。
2. 恢复回退：恢复操作先试 `sessionSecret`；`restoreByName/restoreFromPicker` 抛错（口令不符类）→ 卡内显示一次性口令输入（`fallbackPw` ref + MdTextField，仅失败后出现）+「重试」；用 `fallbackPw` 重试。平台恢复方法签名保持 `(…, password: string)` 不变。
3. 自动区（`v-if="platform.getAutoPrefs"`）：「变更后自动备份」MdSwitch、「定时自动备份」MdSwitch、间隔 select（15/60/360/1440 分钟，原生 select 属既定豁免），变更即 `setAutoPrefs`。
4. 目录行（`v-if="platform.getBackupDir"`）：当前路径文本 + 「更改…」（`platform.setBackupDir(await pick)`——目录选择由宿主 `setBackupDir` 内部弹对话框，卡片只传 null/新值？**裁定**：卡片调 `platform.pickBackupDir?(): Promise<string | null>`（宿主弹对话框返回所选或 null=取消）与 `platform.setBackupDir(dir|null)`；上方接口再加 `pickBackupDir?`）+「恢复默认」。
5. 自动区上方加说明 hint（设计§4.2）：「自动执行前会与上次内容比对，无变化则跳过写入。」

**测试用例**（新增/改造）：①无 sessionSecret 时备份按钮禁用；②有 sessionSecret 时点击以它调用 createBackup；③恢复失败显示回退口令输入并用其重试；④autoPrefs 开关切换调用 setAutoPrefs；⑤无 getAutoPrefs/getBackupDir 时对应区不渲染；⑥目录行「恢复默认」传 null。

**Commit** `feat(ui): BackupCard接会话口令+恢复回退+自动开关与目录行(D1/D2/D4)`

---

### Task 8: ui — CloudPlatform 接口多目标化（类型与迁移约定）

**Files:**
- Modify: `packages/ui/src/components/cloudPlatform.ts`

**变更**（保持向后兼容的读取约定在宿主实现，core 不动）：

```ts
export interface CloudTarget { cred: CloudCred; enabled: boolean }
export interface CloudAutoPrefs { onChange: boolean; onInterval: boolean; intervalMinutes: number }

export interface CloudPlatform {
  // 旧 loadCred/saveCred/loadHash/saveHash 删除，替换为：
  loadCreds(): Promise<CloudTarget[]>
  saveCreds(targets: CloudTarget[]): Promise<void>
  loadTargetHash(backend: string): Promise<string | null>   // backend 键 = cred.backend
  saveTargetHash(backend: string, hash: string | null): Promise<void>
  autoPrefs?: { get(): CloudAutoPrefs; set(p: CloudAutoPrefs): void | Promise<void> }
  // readVaultJson / persistDownloaded / saveConflictBackup 保留；saveConflictBackup 签名扩为 (bytes, backendKey?) 
}
```

存储键约定（两端一致，写在 cloudPlatform.ts 注释里）：新键 `cloudCreds`（JSON 数组）、`cloudRevs`（`Record<backend,string>`）；**读取回退**：`cloudCreds` 缺失而旧 `cloudCred` 存在 → `[{cred: 旧值, enabled: true}]`；`cloudRevs` 缺失而旧 `cloudRev` 存在 → 首个目标继承该值；保存只写新键并清除旧键。`CLOUD_BACKUP_PATH` 从 CloudCard 消费点移除，改用 core `resolveObjectPath(cred)`；常量保留导出（兼容引用）。

**Commit** `refactor(ui): CloudPlatform多目标接口与迁移键约定(D6)`

（此任务无独立测试——类型与纯约定，由 Task 10–13 宿主/卡片测试覆盖。）

---

### Task 9: ui — ImportCard 首屏说明 + SecurityCard 按端文案

**Files:**
- Modify: `packages/ui/src/components/ImportCard.vue:520-528`、`packages/ui/src/components/SecurityCard.vue:167-178`、`packages/ui/src/components/securityPlatform.ts`
- Test: `packages/ui/test/ImportCard.test.ts`（新增用例）、`packages/ui/test/SecurityCard.test.ts`（新增用例）

**ImportCard idle 态**（`<h2>导入</h2>` 与 idle template 之间插入）：
```html
<p class="meta">选择文件后自动识别格式；不确定格式可直接尝试。冲突条目可选跳过/替换/合并。</p>
<details class="formats">
  <summary>支持的导入格式</summary>
  <ul>
    <li>加密备份类：Aegis（加密/明文）、WinAuth XML、Authy</li>
    <li>应用导出类：2FAS、Bitwarden、Proton Authenticator、Stratum、FreeOTP+、旧版 FreeOTP、andOTP、TOTP Authenticator、Battle.net、Duo、Microsoft Authenticator</li>
    <li>文本与通用类：otpauth URI 批量文本、通用 JSON/JSONL/SQLite（可自定义字段映射，映射方案可保存复用）</li>
  </ul>
</details>
```
样式：`.formats` 12px/透明度同 `.hint`。

**SecurityCard 按端文案**：`SecurityPlatform` 增 `unlockNaming?: { prfLabel: string; osAutoLabel: string | null }`（宿主注入；缺省 `{ prfLabel: 'Passkey', osAutoLabel: null }`）。未启用加密态提示（:176）改为：
```html
<p class="hint">启用后本地数据以口令加密存储。启用后可绑定{{ naming?.prfLabel ?? 'Passkey' }}{{ naming?.osAutoLabel ? ` 或 ${naming.osAutoLabel}` : '' }}，免输口令解锁。</p>
```
「解锁方式」区标题行、「添加 Passkey 解锁」按钮文案、dpapi 行标签（:202-205 一带）改用 `naming.prfLabel` / `naming.osAutoLabel`（osAutoLabel 为 null 且宿主未提供 dpapi ops 时该区不渲染——现状已按 ops 渲染，此处仅文案动态化）。

**测试**：ImportCard ①idle 渲染含「支持的导入格式」与三个分组关键词；②点击 summary 展开列表。SecurityCard ①未启用态提示含注入的 prfLabel/osAutoLabel；②未注入 unlockNaming 时回退「Passkey」且不出现「或 …」。

**Commit** `feat(ui): 导入卡首屏格式说明+安全卡按端解锁文案(D5/D3前奏)`

---

### Task 10: desktop — 备份目录 + 自动备份接线（含 Rust 命令与首个 Rust 单测）

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（新命令 `remove_backup_file_os` / `list_backup_files_os`）、`apps/desktop/src-tauri/Cargo.toml`（无新依赖）
- Modify: `apps/desktop/src/backupService.ts`、`apps/desktop/src/App.vue`
- Create: `apps/desktop/src/autoBackup.ts`（desktop 侧 runner，薄壳）
- Test: `apps/desktop/src-tauri/src/lib.rs`（`#[cfg(test)]`）、`apps/desktop/package.json`（补 `"test": "vitest run"` + devDep vitest + `vitest.config.ts` node 环境，只测纯 TS 模块）

**Rust（先写测试）**：

```rust
// lib.rs 追加（仿 remove_backup_file:119-130 + ensure_within:105-117）
#[tauri::command]
fn remove_backup_file_os(path: String, allowed_dir: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !valid_backup_name(p.file_name().map(|s| s.to_string_lossy().as_ref()).unwrap_or("")) {
        return Err("invalid backup name".into());
    }
    ensure_within(p, &allowed_dir)?;
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_backup_files_os(dir: String) -> Result<Vec<String>, String> {
    let rd = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = rd.flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| valid_backup_name(n) || n.starts_with("conflict-"))
        .collect();
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn valid_backup_name_rejects_traversal() {
        assert!(valid_backup_name("vault-20260916-120000.totpbackup"));
        assert!(!valid_backup_name("../x.totpbackup"));
        assert!(!valid_backup_name("conflict-1.totpbackup")); // 白名单仅 vault- 前缀，列表另有前缀过滤
    }
    #[test]
    fn ensure_within_rejects_outside() {
        let dir = std::env::temp_dir().join("totp_test_allowed");
        std::fs::create_dir_all(&dir).unwrap();
        let outside = std::env::temp_dir().join("totp_test_outside");
        std::fs::create_dir_all(&outside).unwrap();
        let p = outside.join("vault-20260916-120000.totpbackup");
        std::fs::write(&p, "x").unwrap();
        assert!(ensure_within(&p, dir.to_str().unwrap()).is_err());
    }
}
```

`invoke_handler`（:437-447）注册两个新命令。`list_backup_files_os` 不做 ensure_within（目录本身即用户显式授权的目标目录，与对话框 allowed_dir 同源）。

**backupService.ts**：`createBackupToDir`/`saveConflictBackupToDir` 增 `dirOverride?: string | null` 参数——有 override 时：写盘走 `invoke('write_text_file_os', { path: `${dirOverride}\\${name}`.replaceAll 到 POSIX 组合（用 path.join 语义的 joinPath 小函数 + 单测）, contents, allowedDir: dirOverride })`；滚动删除改 `list_backup_files_os` + `remove_backup_file_os`；读列表恢复同理用 `read_text_file_os`。默认路径分支保持 plugin-fs 现状。

**App.vue**：
- `backupPlatform` 增实现 `pickBackupDir`（`open({ directory: true, multiple: false })`——capabilities 已有 `dialog:allow-open`）、`getBackupDir`/`setBackupDir`（持久化 `fsAdapter` 键 `backupDir`，读时 `null` 回退默认）；`createBackup/saveConflictBackup` 内部把 `await getBackupDir()` 传入 service；`listBackups/restoreByName` 同样按 override 分支。
- `getAutoPrefs/setAutoPrefs`：localStorage 键 `backupAutoPrefs`（JSON `{onChange,onInterval,intervalMinutes}`，默认 `{onChange:false,onInterval:false,intervalMinutes:60}`）。
- **自动备份 runner**（`autoBackup.ts` 纯逻辑 + vitest）：
```ts
export interface AutoBackupDeps {
  isLocked(): boolean
  getSecret(): string | null
  getVaultJson(): string
  getPrefs(): { onChange: boolean; onInterval: boolean; intervalMinutes: number }
  getLastHash(): string | null
  setLastHash(h: string): void
  doBackup(json: string, secret: string): Promise<void>
  doCloudSync(json: string, secret: string): Promise<void>
  cloudPrefs?(): { onChange: boolean; onInterval: boolean; intervalMinutes: number } | null
  now?(): number
}
export function createDesktopAutoBackup(deps: AutoBackupDeps) {
  // run(reason)：locked/no-secret → 返回状态；本地：decideAutoRun(currentHash=sha256(json), lastHash) → doBackup→setLastHash；
  // 云：云编排自去重（in-sync），直接 doCloudSync；lastIntervalRunAt 比较 getPrefs().intervalMinutes（shouldRunInterval 纯函数导出并测试）
  // 返回 { scheduler: createAutoRunScheduler({debounceMs:10_000, intervalMs: ()=>prefs.onInterval?60_000:null, run}), run }
}
```
测试用例（desktop vitest，node 环境）：decideAutoRun 三种 skip 与 run、lastHash 写入时机、interval 到点判定（shouldRunInterval 边界）、云目标不因 lastHash 跳过。
- `createVueStore(adapter, { windowId: 'main', onCommitted: () => auto.notifyChanged() })`（:236 处）；`onMounted` 调 `scheduler.start()`，`onUnmounted`/窗口隐藏不停止（托盘常驻语义）。

**capabilities**：无需扩（dialog:allow-open 已有；写盘走自有 Rust 命令）。

**Commits**（拆两次）：
1. `feat(desktop): 备份目录可选(Rust os命令+目录选择+滚动删除适配,D4)`
2. `feat(desktop): 变更后/定时自动备份与云同步runner(D2)`

---

### Task 11: desktop — 云多目标宿主接线

**Files:**
- Modify: `apps/desktop/src/App.vue`（cloudPlatform 段 :130-167）

实现：`loadCreds`（读 `cloudCreds`，回退旧 `cloudCred`）、`saveCreds`（写新键删旧键）、`loadTargetHash/saveTargetHash`（新键 `cloudRevs`，回退旧 `cloudRev` → 首目标继承）、`autoPrefs`（localStorage `cloudAutoPrefs`，同构 backup）。`saveConflictBackup(bytes, backendKey?)` 文件名 `conflict-{backendKey}-{ts}.totpbackup`（backendKey 缺省保持旧名）。

CloudCard 的同步执行改造在 Task 13（UI 层调 `syncMultipleTargets`）；本任务只保证宿主端口就绪。**验证**：ui 侧 `CloudCard.test.ts` 在 Task 13 前会短暂引用旧接口——**裁定**：Task 8 的接口切换与 Task 13 的卡片改造、Task 10–12 宿主接线在**同一分支连续提交**，期间以 `pnpm -r run typecheck` 保持全绿为每 commit 的门槛（CloudCard.test.ts 若在 Task 8 后、Task 13 前短暂编译失败，可先在本任务顺手把卡片调用点最小适配为 loadCreds()[0]——标记 TODO Task 13 重构）。

**Commit** `feat(desktop): 云凭据多目标存储迁移与autoPrefs端口(D6/D2)`

---

### Task 12: extension — 云多目标 + 自动云同步（含设计勘误）

**Files:**
- Modify: `apps/extension/entrypoints/options/App.vue`（cloudPlatform :253-290、backupPlatform :211-244）、`apps/extension/src/store.ts`（:21-29 onCommitted 扩展）
- Create: `apps/extension/src/autoCloudSync.ts`（页面级 runner 纯逻辑，vitest 在 `apps/extension/test/`）

**设计勘误（同步回写设计文档 §4.1，Task 17 执行）**：原设计「扩展端定时用 chrome.alarms」不可行——SW 后台无解锁 DEK、读不到会话/库内备份口令，alarms 触发的同步无法加密。**裁定：扩展端自动云同步仅在 options 页面存活期间运行**（页面 `setInterval` + store `onCommitted` 防抖；页面关闭即暂停，重开恢复）。chrome.alarms 不新增使用。

**实现**：
- options `cloudPlatform`：`loadCreds/saveCreds/loadTargetHash/saveTargetHash/autoPrefs`，storage 键与迁移约定同 Task 11（`storageAdapter` 键 `cloudCreds`/`cloudRevs`）。
- `store.ts`：`createExtensionStore` 工厂 opts 增 `onCommittedExtra?: () => void`，在既有 `onCommitted`（sync-push 调度）后追加调用（不合并进 sync-push 语义）。
- `autoCloudSync.ts`：与 Task 10 `autoBackup.ts` 同构的 runner（**复用 core 调度器与 decideAutoRun；云侧不经 lastHash 去重，靠编排 in-sync**），导出纯函数便于测试；options 页 `onMounted` 启动、`onUnmounted` 停止；挂载点在 options App.vue setup。
- 扩展端**不提供** `BackupPlatform.getAutoPrefs`（本地备份=下载，不自动），CloudCard 自动区靠 `CloudPlatform.autoPrefs` 出现。

**测试**（`apps/extension/test/autoCloudSync.test.ts`）：runner 三态 skip、interval 判定、错误不抛出只记状态。

**Commits**：
1. `feat(ext): 云凭据多目标存储迁移与autoPrefs端口(D6)`
2. `feat(ext): options页存续期自动云同步runner(D2,设计勘误§4.1)`

---

### Task 13: ui — CloudCard 多目标目标列表（改造）

**Files:**
- Modify: `packages/ui/src/components/CloudCard.vue`（全卡改造 :233-279 一带）、`packages/ui/src/pages/SyncPage.vue`（传 `sessionSecret`）
- Test: `packages/ui/test/CloudCard.test.ts`（既有 10 用例改造 + 新增）

**模板结构**（替换后端下拉+动态字段段）：

```html
<div v-for="(t, i) in targets" :key="t.cred.backend" class="target">
  <div class="target-head">
    <MdSwitch v-model="t.enabled" :aria-label="`${backendLabel(t.cred.backend)}启用`" />
    <strong>{{ backendLabel(t.cred.backend) }}</strong>
    <MdButton variant="text" @click="toggleExpand(i)">{{ expanded === i ? '收起' : '配置' }}</MdButton>
  </div>
  <template v-if="expanded === i">
    <!-- 既有各后端凭据字段块，v-model 绑 t.cred.*（原样搬移） -->
    <MdTextField v-model="t.cred.objectPath" label="目标文件路径" :placeholder="DEFAULT_OBJECT_PATH" />
  </template>
  <span class="target-status">{{ statusFor(t.cred.backend) }}</span>
</div>
<!-- 「添加目标」：列出未添加后端（多后端可并存，同 backend 仅一份） -->
```

**逻辑**：`targets = ref<CloudTarget[]>([])`，`onMounted` → `platform.loadCreds()`；「保存凭据」→ `saveCreds(targets)`；「立即同步」→ 组装 `targets.filter(t=>t.enabled).map(t => ({ key: t.cred.backend, backend: createCloudBackend(t.cred), path: resolveObjectPath(t.cred), hash: await platform.loadTargetHash(t.cred.backend) }))` → `syncMultipleTargets({ targets, vaultJson: platform.readVaultJson(), password: sessionSecret, onConflictBackup: (k, b) => platform.saveConflictBackup?.(b, k) })` → 按目标渲染状态（uploaded/downloaded/conflict-resolved/in-sync/错误）→ 逐目标 `saveTargetHash(key, hashes[key])`；`adopted` 时用 `finalVaultJson` 走既有 `persistDownloaded` 确认覆盖链路（弹确认，同现状 :209-227）。口令输入框删除，`sessionSecret` prop 供给，无则按钮禁用 + hint。自动区（`v-if="platform.autoPrefs"`）同 BackupCard 模式。

**既有行为保持**：public gist 警示（:268）移入 gist 目标行内；「云端覆盖确认」两步确认保留。

**测试**（改造 + 新增）：①目标列表渲染两条启用目标；②仅启用目标进入 syncMultipleTargets（mock 断言 targets 数）；③objectPath 透传 resolveObjectPath 结果；④adopted=true 时调 persistDownloaded 且逐目标 saveTargetHash；⑤单目标错误状态行展示且不影响其余；⑥无 sessionSecret 禁用同步按钮；⑦旧迁移：loadCreds 回退单凭据（mock 平台验证一次调用形态）。

**Commit** `feat(ui): CloudCard多目标列表+收敛编排接线(D6/D1)`

---

### Task 14: desktop — osAutoUnlock 三平台（macOS Keychain / Linux Secret Service）

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`、`apps/desktop/src-tauri/src/lib.rs`、`apps/desktop/src/tauriSecurity.ts`、`apps/desktop/src/App.vue:169-186`、`packages/ui/src/components/securityPlatform.ts`（DpapiUnlockOps 增 `label`）
- Test: Rust `#[cfg(test)]`（纯函数）；TS 侧走 typecheck + 既有 SecurityCard 用例改造

**Cargo.toml**：
```toml
[target.'cfg(target_os = "macos")'.dependencies]
keyring = "3"
[target.'cfg(target_os = "linux")'.dependencies]
keyring = { version = "3", features = ["sync-secret-service"] }
```

**Rust**：新命令 `os_auto_protect(data_b64)/os_auto_unprotect(wrapped_b64)`（service 常量 `"totp-desktop"`，account `"dek"`）：
```rust
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn os_auto_protect(data_b64: String) -> Result<String, String> {
    let dek = base64_decode(&data_b64)?;
    let entry = keyring::Entry::new("totp-desktop", "dek").map_err(|e| e.to_string())?;
    entry.set_password(&data_b64 /* 存 base64(DEK)：OS 已保护，明文字节不出入口 */) .map_err(|e| e.to_string())?;
    Ok(data_b64)
}
// os_auto_unprotect：entry.get_password → base64 解码校验 32B
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[tauri::command]
fn os_auto_protect(_data_b64: String) -> Result<String, String> { Err("os auto unlock not supported".into()) }
// unprotect 同构
```
> 语义与 DPAPI 对齐（`tauriSecurity.ts:5-23`）：包裹对象是 DEK 本体（base64），OS 负责保护；Windows 分支**委托现有 `dpapi_protect/dpapi_unprotect` 函数**（`#[cfg(windows)]` 下 os_auto_* 直接调用，命令名统一）。base64 工具复用 lib.rs 内 DPAPI 段已有实现。**Windows 构建可验证编译与 DPAPI 委托路径；macOS/Linux 运行时验证登记真机 backlog（诚实约束，写进 README）。**

**tauriSecurity.ts**：`osAutoProtectOs/osAutoUnprotectOs`（invoke `'os_auto_protect'/'os_auto_unprotect'`），`App.vue` dpapiOps 的 `protect/unprotect` 改调 os_auto 版（Windows 行为不变）；`source/add/remove` 走 store 既有 dpapiOp 不变（kekSources kind 仍 `'dpapi'`，存储兼容）。

**securityPlatform.ts**：`DpapiUnlockOps` 增 `label: string`；`SecurityPlatform` 增 `unlockNaming?: { prfLabel: string; osAutoLabel: string | null }`（Task 9 已建类型，此处宿主接线）。`App.vue` 按 UA 注入：Windows→`{ prfLabel: 'Windows Hello (Passkey)', osAutoLabel: 'Windows 自动解锁' }`；Mac→`{ prfLabel: 'Touch ID (Passkey)', osAutoLabel: '钥匙串自动解锁' }`；其余→`{ prfLabel: 'Passkey', osAutoLabel: '密钥环自动解锁' }`；dpapiOps.label 同步。

**SecurityCard/LockScreen**：dpapi 行标签与解锁按钮文案读 `dpapiOps.label` / `unlockNaming`（Task 9 已铺）。

**Commit** `feat(desktop): osAutoUnlock三平台统一通道(Keychain/SecretService/DPAPI委托,D1)`

---

### Task 15: theme — M3 字阶 token 化

**Files:**
- Modify: `packages/ui/src/theme/generate.mjs`（base 块追加 typescale）、产物 `tokens.css`
- Modify: 组件字号替换（分三批 commit）

**generate.mjs**（base 数组内、模式无关）：

```js
const TYPESCALE = `:root {
  --md-sys-typescale-title-medium: 16px;   /* 卡头/区块标题（原 15px h2 收敛） */
  --md-sys-typescale-body-large: 16px;     /* 输入框正文（原 16px） */
  --md-sys-typescale-body-medium: 14px;    /* 列表/正文（原 13/14px 收敛） */
  --md-sys-typescale-body-small: 12px;     /* 辅助 hint（原 12px） */
  --md-sys-typescale-label-medium: 12px;   /* 小标签 */
  --md-sys-typescale-label-small: 11px;    /* 极小提示（原 11px 保留档） */
  --md-sys-typescale-code-large: 18px;     /* 验证码/密文等宽（项目自定义档） */
}`
```

追加进 tokens.css 的 base 输出；跑 `pnpm --filter @totp/ui theme` 重新生成。**新增测试** `packages/ui/test/themeTypescale.test.ts`：读 `src/theme/tokens.css` 断言含 7 个变量且值正确（防手改/防回归）。

**替换映射**（依据字号分布清单，rg 逐文件执行；13px 一律升 14px 属审查裁定项，若 Task 16 审查反对再回调）：

| 原值 | token | 备注 |
|---|---|---|
| h2 15px | title-medium(16) | 各卡头 |
| 13px 正文 | body-medium(14) | 卡内行/列表 |
| 12px hint | body-small(12) | 不变值，改引用 |
| 11px | label-small(11) | 不变值 |
| 16px 输入/标题 | body-large / title-medium | MdTextField:48,55 |
| 18px 等宽 | code-large | OtpListItem:87、RevealDialog:33 |
| 14px（md 组件） | body-medium(14) | MdButton/MdCheckbox/MdCard header 等，值不变改引用 |

批次：①`components/md/*`；②`components/*.vue`（11 个功能组件，清单见调研：SecurityCard/BackupCard/ImportCard/EntryForm/CloudCard/OtpListItem/SyncCard/LockScreen/RevealDialog/SearchBar/GroupManagerDialog）；③`pages/*` + `apps/desktop/src/MiniApp.vue` + `apps/extension/entrypoints/popup/App.vue` + `options/App.vue`。

**Commits**：
1. `feat(ui): M3字阶token生成与主题测试(D3)`
2. `refactor(ui): md组件字号接typescale(D3)`
3. `refactor(ui): 功能组件与页面字号接typescale(D3)`

---

### Task 16: M3 审查报告 + 视觉修正

**Files:**
- Create: `docs/review/2026-09-16-m3-audit.md`
- Modify: 依审查结论的组件样式（MdCard 双描边、状态层透明度等）

**步骤**：
1. 起 dev 服务（`pnpm --filter @totp/desktop dev` 或扩展 `pnpm --filter @totp/extension dev`），用 agent-browser 技能对「验证码/导入/同步/安全/设置」五页 × light/dark × 两种主题色截图。
2. 逐组件对照 M3 官规范条目填写审查表：色彩角色值、状态层（hover 8% / pressed 12% / focus 12%）、形状（checkbox 2px 圆角、switch 全圆、button pill）、字阶引用、双描边（MdCard outlined + 卡自身 border 叠加）等。
3. **定位用户所指「复选框底色偏深」**：截图核对未选中复选框（应透明底+`on-surface-variant` 描边）与 MdTextField 填充（`surface-container-highest`），在报告中写明来源与规范依据。
4. 报告含「修正清单」（条目+规范依据+涉及文件），逐项落实并 commit。
5. 报告本身 commit：`docs(review): M3逐组件审查报告与修正清单(D3)`。

---

### Task 17: 文档勘误 + 全量验证

**Files:**
- Modify: `README.md`（备份目录/自动备份/多目标云同步/两把口令/osAutoUnlock 三平台及真机验证边界/扩展端自动同步存活期约束）、`docs/plans/2026-09-16-settings-ux-design.md`（§4.1 勘误：扩展端定时为 options 页存续期 setInterval 而非 chrome.alarms，理由=SW 无会话口令）

**验证清单（全绿才算完）**：
```bash
pnpm -r run test                 # core/ui/extension 全绿（desktop vitest 新增）
pnpm -r run typecheck            # 四包全绿
pnpm --filter @totp/ui exec vitest run --coverage   # 新增模块行覆盖 100%（vaultSecret/autoRun/autoRunScheduler/targetPath/multiTarget/store 新增段/卡片新增分支）
cd apps/desktop && pnpm tauri build   # Windows 产物构建通过（含 Rust 新命令与 os_auto Windows 委托编译）
pnpm --filter @totp/extension build   # wxt 构建通过
```
桌面真机冒烟（自动备份/目录/多目标/记住口令）与 macOS/Linux Keychain 运行时验证 → 追加到既有真机验收清单。

**Commit** `docs: plan15收尾勘误(扩展端定时语义)与README更新`

---

## 回归底线（每任务通用）

- 动过 `store.ts`/卡片，必跑 `pnpm --filter @totp/ui test`；动过 core，必跑 `pnpm --filter @totp/core test`；每个 commit 前 `pnpm -r run typecheck`。
- 信封格式 v1、`isEncryptedVault` 四键判定、旧备份/旧云端对象可开、口令不落盘（settings 明文键除外）、云端只见密文——五个不变量任何任务不得破坏。
- 旧数据迁移一律「读回退、写新键」，禁止启动时破坏性改写。
