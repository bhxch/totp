# 云端源备份列表与管理动作（plan23）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CloudCard 每个云源新增「云端备份」折叠区：手动刷新列出远端时间戳备份，逐份支持恢复（两步确认）/导出（密文原件）/删除（两步确认），桌面+扩展双端。

**Architecture:** core 与 Rust 零改动——列表/读取/删除全部复用既有 `CloudBackend` 成员（s3/gdrive/onedrive 走 `listBackupsEx` 截断感知，webdav/gist 走 `listBackups`），解密复用 `openBackupEnvelope`、落库复用 `persistDownloaded`。新增面收窄为：`CloudPlatform.saveBackupFile?` 一个可选平台成员（host 工厂透传 + 两宿主实现）、`cloudSyncShared.listCloudBackups` 纯助手、CloudCard 区块 UI 与两个新 confirm 槽。

**Tech Stack:** Vue 3 script setup + vue-i18n、vitest 5 + @vue/test-utils、pnpm workspace（@totp/core|ui|desktop|extension）。

**Spec:** `docs/plans/2026-10-10-cloud-backup-list-design.md`（本计划从 spec 论证；执行者两个文件都读。注意 spec §5 的 confirm 槽名 `backupDel` 在本计划落地为 `backupDelete`，语义不变）。

## Global Constraints

- 全程中文注释与用户文案；i18n 键 zh/en 双份同步新增（`packages/ui/src/i18n/locales/{zh,en}/common.json` 的 `cloudCard` 域）。
- core 包与 Rust（src-tauri）零改动；若实现中发现"必须改 core/Rust"，停下上报（视为发现 spec 级问题，不得自行扩权）。
- cloud 操作全部 TS 层：backend 实例经 `createCloudBackend(cred)` 现场构造，凭据解析口径=`credDrafts 非空白优先，回落 platform.creds`（CloudCard.vue 既有 `onConfirmReset` 同款）。
- UI 能力检测：可选平台成员存在性决定按钮渲染（无 feature flag）。
- 恢复**不写** `SourceSyncState` 基线（spec §2 刻意语义）；删除**不触碰**基线（spec §3）。
- 测试命令：`pnpm --filter <pkg> exec vitest run <file>`；typecheck：`pnpm --filter <pkg> run typecheck`（desktop/extension/ui=vue-tsc，core=tsc）。
- commit Angular 规范中文消息，why 一句 + what 一句；每 Task 一提交，只 add 该 Task 文件（工作区可能存在与本计划无关的 `apps/desktop/src-tauri/Cargo.toml` 改动，**不得**纳入）。
- 执行注意（记忆坑）：同仓库并行子代理必须**串行**；vitest 5 clearMocks 默认开（用例内自设 mock 才有值）。

---

### Task 1: `CloudPlatform.saveBackupFile?` 接口 + host 工厂透传

**Files:**
- Modify: `packages/ui/src/components/cloudPlatform.ts`（CloudPlatform 接口）
- Modify: `packages/ui/src/host/cloudPlatform.ts`（overrides 接口 + 工厂透传 + 差异清单注释）
- Test: `packages/ui/test/hostCloudPlatform.test.ts`（新建——host 工厂此前无直测文件；既有 `cloudPlatform.factory.test.ts` 只测 `createCloudBackend` 分发，不承载本用例）

**Interfaces:**
- Consumes: 无（首任务）。
- Produces: `CloudPlatform.saveBackupFile?(name: string, bytes: Uint8Array): Promise<boolean>`；`StoreBackedCloudPlatformOverrides.saveBackupFile?` 同签名。后续 Task 6/7/8 消费。

- [ ] **Step 1: 写失败测试**

新建 `packages/ui/test/hostCloudPlatform.test.ts`（工厂构造仅闭包不触 store/adapter——`seal()` 在 loadSourceState/saveSourceState 内才懒构建，`HostRef` 接受裸值，哑对象即可直测透传）：

```ts
import { describe, expect, it, vi } from 'vitest'
import type { StorageAdapter } from '@totp/core'
import { createStoreBackedCloudPlatform } from '../src/host/cloudPlatform'
import type { VueStore } from '../src/store'

/** saveBackupFile 透传（plan23 §4）：仅消费该成员，store/adapter 不被触达，最小哑对象即可 */
const DUMMY_STORE = {} as VueStore
const DUMMY_ADAPTER = {} as StorageAdapter
const baseOverrides = {
  saveSources: async () => {},
  autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
}

describe('createStoreBackedCloudPlatform.saveBackupFile 透传（plan23 §4）', () => {
  it('overrides 提供：平台成员透传同引用', async () => {
    const saveBackupFile = vi.fn(async () => true)
    const platform = createStoreBackedCloudPlatform(DUMMY_STORE, DUMMY_ADAPTER, { ...baseOverrides, saveBackupFile })
    await expect(platform.saveBackupFile!('vault-20261010-090000.totpbackup', new Uint8Array([1]))).resolves.toBe(true)
    expect(saveBackupFile).toHaveBeenCalledWith('vault-20261010-090000.totpbackup', new Uint8Array([1]))
  })

  it('缺省：平台无 saveBackupFile 成员（能力检测不渲染导出按钮）', () => {
    const platform = createStoreBackedCloudPlatform(DUMMY_STORE, DUMMY_ADAPTER, { ...baseOverrides })
    expect(platform.saveBackupFile).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudPlatform.factory.test.ts`
Expected: FAIL（类型/运行时：overrides 不含 saveBackupFile，成员 undefined）

- [ ] **Step 3: 最小实现**

`packages/ui/src/components/cloudPlatform.ts` 在 `exportConflictCopy?` 成员后追加：

```ts
  /** [可选] 云端备份密文原件落盘（plan23：desktop=另存对话框+文本写盘；extension=Blob 下载恒 true）；
   *  返回 false=用户取消另存。缺省=CloudCard 不渲染导出按钮（能力检测） */
  saveBackupFile?(name: string, bytes: Uint8Array): Promise<boolean>
```

`packages/ui/src/host/cloudPlatform.ts` 三处：

1. `StoreBackedCloudPlatformOverrides` 在 `exportConflictCopy?` 后追加：

```ts
  /** 云端备份密文原件落盘(desktop=另存对话框;extension=Blob 下载恒 true);缺省=CloudCard 不渲染导出按钮 */
  saveBackupFile?(name: string, bytes: Uint8Array): Promise<boolean>
```

2. 工厂返回对象在 `...(overrides.exportConflictCopy ? ...)` 行后追加：

```ts
    ...(overrides.saveBackupFile ? { saveBackupFile: overrides.saveBackupFile } : {}),
```

3. 文件头差异清单注释同步：`注入差异(8 键 = 2 必选 + 6 可选…)` 改为 `9 键 = 2 必选 + 7 可选`，清单补一行 `- saveBackupFile: 云端备份密文原件落盘(plan23):desktop=另存对话框;extension=Blob 下载;缺省不渲染导出按钮;`；`overrides 键数 8 ≪ 字面量成员 18` 改为 `9 ≪ 19`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudPlatform.factory.test.ts`
Expected: PASS（含既有用例回归）

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/cloudPlatform.ts packages/ui/src/host/cloudPlatform.ts packages/ui/test/hostCloudPlatform.test.ts
git commit -m "feat(ui): CloudPlatform 增 saveBackupFile 可选成员并经 host 工厂透传

why: 云端备份导出（plan23 §4）需要宿主落盘能力，desktop=另存对话框、
extension=Blob 下载，缺省宿主不渲染导出按钮（能力检测模式）。
what: 接口可选成员 + overrides 透传 + 差异清单注释同步。"
```

---

### Task 2: `cloudSyncShared.listCloudBackups` 纯助手

**Files:**
- Modify: `packages/ui/src/components/cloudSyncShared.ts`（文件尾追加）
- Test: `packages/ui/test/cloudSyncShared.backups.test.ts`（新建）

**Interfaces:**
- Consumes: `@totp/core` 的 `BACKUP_NAME_RE`（已导入）、`backupNameTimestampMs`（新增导入）、`CloudBackend` 类型（已导入）。
- Produces:
```ts
export interface CloudBackupItem { path: string; base: string; at: number | null }
export async function listCloudBackups(backend: CloudBackend): Promise<{ items: CloudBackupItem[]; complete: boolean }>
```
Task 3-6 的 CloudCard 消费。

- [ ] **Step 1: 写失败测试**

新建 `packages/ui/test/cloudSyncShared.backups.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import type { CloudBackend } from '@totp/core'
import { listCloudBackups } from '../src/components/cloudSyncShared'

function backendOf(over: Partial<CloudBackend>): CloudBackend {
  return {
    id: 'webdav',
    put: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    ...over,
  } as unknown as CloudBackend
}

describe('listCloudBackups（plan23 §1）', () => {
  it('有 listBackupsEx：优先走 Ex，透传 complete 标志', async () => {
    const listBackups = vi.fn(async () => [] as string[])
    const ex = vi.fn(async () => ({ names: ['dir/vault-20261010-090000.totpbackup'], complete: false }))
    const r = await listCloudBackups(backendOf({ listBackups, listBackupsEx: ex }))
    expect(ex).toHaveBeenCalled()
    expect(listBackups).not.toHaveBeenCalled()
    expect(r.complete).toBe(false)
    expect(r.items).toEqual([{ path: 'dir/vault-20261010-090000.totpbackup', base: 'vault-20261010-090000.totpbackup', at: expect.any(Number) }])
  })

  it('无 Ex：回落 listBackups 且 complete=true（retention.ts 既有回退语义）', async () => {
    const r = await listCloudBackups(backendOf({ listBackups: vi.fn(async () => ['vault-20261009-210000.totpbackup']) }))
    expect(r.complete).toBe(true)
    expect(r.items[0]).toMatchObject({ base: 'vault-20261009-210000.totpbackup', at: expect.any(Number) })
  })

  it('倒序输出（字典序=时间序，最新在前）且 basename 映射 at（不可解析名 at=null）', async () => {
    const r = await listCloudBackups(backendOf({
      listBackups: vi.fn(async () => ['d/vault-20261009-210000.totpbackup', 'vault-20261010-090000.totpbackup']),
    }))
    expect(r.items.map((x) => x.base)).toEqual(['vault-20261010-090000.totpbackup', 'vault-20261009-210000.totpbackup'])
    expect(r.items.every((x) => x.at !== null)).toBe(true)
  })

  it('错误原样上抛（UI 逐源行内展示，区别于 latestKeepPath 吞错语义）', async () => {
    const backend = backendOf({ listBackups: vi.fn(async () => { throw new Error('401') }) })
    await expect(listCloudBackups(backend)).rejects.toThrow('401')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudSyncShared.backups.test.ts`
Expected: FAIL（listCloudBackups 未导出）

- [ ] **Step 3: 最小实现**

`packages/ui/src/components/cloudSyncShared.ts`：

1. `@totp/core` import 列表加 `backupNameTimestampMs`；
2. 文件尾（`runExclusive` 之前、`runKeepRetention` 之后均可，建议紧跟 `latestKeepPath` 之后保持读侧聚合）追加：

```ts
/** 云端备份列表项（展示视图，plan23 §1）：path=后端原名（与 get/delete 同域，恢复/导出/删除直用）；
 *  base=basename（展示）；at=文件名时间戳 ms（vault-{ts} 名可解析，否则 null） */
export interface CloudBackupItem {
  path: string
  base: string
  at: number | null
}

/** 云端备份列表（plan23 §1）：优先 listBackupsEx（F6 截断感知），无则 listBackups 且 complete=true
 *  （retention.ts 既有回退语义）。名单过滤/排序与 latestKeepPath 同口径（BACKUP_NAME_RE、
 *  字典序=时间序），输出倒序（最新在前）。错误原样上抛——UI 逐源行内展示，
 *  区别于 latestKeepPath 吞错返回 null 的「按云端无对象首推」语义 */
export async function listCloudBackups(backend: CloudBackend): Promise<{ items: CloudBackupItem[]; complete: boolean }> {
  const listed = backend.listBackupsEx
    ? await backend.listBackupsEx()
    : { names: backend.listBackups ? await backend.listBackups() : [], complete: true }
  const basename = (p: string): string => p.split('/').filter((s) => s !== '').pop() ?? p
  const items = listed.names
    .filter((p) => BACKUP_NAME_RE.test(basename(p)))
    .sort()
    .reverse()
    .map((path) => {
      const base = basename(path)
      return { path, base, at: backupNameTimestampMs(base) }
    })
  return { items, complete: listed.complete }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudSyncShared.backups.test.ts test/cloudRunner.test.ts`
Expected: PASS（新用例 + cloudSyncShared 既有消费方回归）

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/cloudSyncShared.ts packages/ui/test/cloudSyncShared.backups.test.ts
git commit -m "feat(ui): cloudSyncShared 增 listCloudBackups 云端备份列表助手

why: plan23 列表区需要统一的截断感知名单拉取与展示映射（倒序/basename/
时间戳解析），单点化供 CloudCard 消费。
what: CloudBackupItem 视图类型 + listCloudBackups（Ex 优先、错误上抛）。"
```

---

### Task 3: CloudCard「云端备份」区块——刷新/列表/空态/截断/错误 + i18n

**Files:**
- Modify: `packages/ui/src/components/CloudCard.vue`
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`packages/ui/src/i18n/locales/en/common.json`
- Test: `packages/ui/test/cloudCard.backupList.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `listCloudBackups`；既有 `createCloudBackend`、`isBlankCred`、`useAsyncMessage` 的 `busy/fail`。
- Produces: 卡内状态 `backupsBySource/backupsLoading/backupsError`（Record<sourceId,…>）、`credOf(s)`、`refreshBackups(s)`、`backupsFor(id)`、`backupTime(at)`；DOM 挂点 `.cloud-backups`/`button.backup-refresh`/`.cloud-backup-list`/`.bname`/`.btime`（Task 4-6 在此区块内加按钮）。

- [ ] **Step 1: 写失败测试**

新建 `packages/ui/test/cloudCard.backupList.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { CloudBackend, CloudCred, BackupSource } from '@totp/core'
import CloudCard from '../src/components/CloudCard.vue'
import { createCloudBackend } from '../src/components/cloudPlatform'
import { settleMergeConfirm } from '../src/components/cloudSyncBridge'
import { createTestI18n } from './helpers/i18n'
import type { CloudPlatform } from '../src/components/cloudPlatform'
import type { VueStore } from '../src/store'

vi.mock('../src/components/cloudPlatform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCloudBackend: vi.fn(),
}))

const WEBDAV_CRED = { backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'u', appPassword: 'p' } as CloudCred
const GIST_CRED = { backend: 'gist', token: 't', gistId: 'g' } as CloudCred

const SOURCE_KEEP: BackupSource = { id: 'src-1', kind: 'webdav', name: 'WebDAV', retention: { type: 'keep', n: 3 }, enabled: true, role: 'primary' }
const SOURCE_GIST: BackupSource = { id: 'src-2', kind: 'gist', name: 'Gist', retention: { type: 'keep', n: 3 }, enabled: true, role: 'replica' }
const SOURCE_OW: BackupSource = { id: 'src-3', kind: 'webdav', name: '覆盖源', retention: { type: 'overwrite' }, enabled: true, role: 'replica' }

const VALID_VAULT = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 0 })

function fakeBackend(over: Partial<CloudBackend> = {}): CloudBackend {
  return {
    id: 'webdav',
    put: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    listBackups: vi.fn(async () => [] as string[]),
    ...over,
  } as unknown as CloudBackend
}

/** 按 cred.backend 分派 backend 替身（未登记的 kind 给空 backend） */
function useBackends(byKind: Partial<Record<string, CloudBackend>>): void {
  vi.mocked(createCloudBackend).mockImplementation((cred) => byKind[(cred as CloudCred & { backend: string }).backend] ?? fakeBackend())
}

function mkPlatform(over: Partial<CloudPlatform> = {}, creds: Record<string, CloudCred> = { 'src-1': WEBDAV_CRED, 'src-2': GIST_CRED, 'src-3': WEBDAV_CRED }): CloudPlatform {
  return {
    loadSources: vi.fn(async () => [SOURCE_KEEP, SOURCE_GIST, SOURCE_OW]),
    saveSources: vi.fn(async () => {}),
    saveCred: vi.fn(async () => {}),
    removeCred: vi.fn(async () => {}),
    creds,
    readVaultJson: () => VALID_VAULT,
    persistDownloaded: vi.fn(async () => {}),
    loadSourceState: vi.fn(async () => ({ lastKnownRemoteRev: null, baseSnapshot: null })),
    saveSourceState: vi.fn(async () => {}),
    deviceId: vi.fn(async () => 'dev-test'),
    autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
    ...over,
  }
}

async function mountCard(p: CloudPlatform): Promise<VueWrapper> {
  const w = mount(CloudCard, {
    global: { plugins: [createTestI18n()] },
    props: { platform: p, sessionSecret: 'pw' },
  })
  await flushPromises()
  return w
}

/** 展开第 i 个源（备份区块在 expanded 区内） */
async function expand(w: VueWrapper, i: number): Promise<void> {
  await w.findAll('button.target-toggle')[i]!.trigger('click')
}

afterEach(() => settleMergeConfirm(false))
beforeEach(() => vi.mocked(createCloudBackend).mockClear())

describe('CloudCard 云端备份区块：列表与刷新（plan23 §1）', () => {
  it('刷新 keep 源：倒序 basename 行 + 可解析时间戳行；走 listCloudBackups（Ex 优先）', async () => {
    const ex = vi.fn(async () => ({ names: ['d/vault-20261009-210000.totpbackup', 'd/vault-20261010-090000.totpbackup'], complete: true }))
    useBackends({ webdav: fakeBackend({ listBackupsEx: ex }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    const names = w.findAll('.cloud-backup-list .bname').map((x) => x.text())
    expect(names).toEqual(['vault-20261010-090000.totpbackup', 'vault-20261009-210000.totpbackup'])
    expect(w.find('.cloud-backup-list .btime').exists()).toBe(true)
  })

  it('complete=false：显示「列表可能不完整」截断提示', async () => {
    useBackends({ webdav: fakeBackend({ listBackupsEx: vi.fn(async () => ({ names: ['vault-20261010-090000.totpbackup'], complete: false })) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('.cloud-backups').text()).toContain('列表可能不完整')
  })

  it('overwrite 源空列表：显示覆盖模式说明（非通用空态）', async () => {
    useBackends({ webdav: fakeBackend() })
    const w = await mountCard(mkPlatform())
    await expand(w, 2) // SOURCE_OW
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('.cloud-backups').text()).toContain('覆盖模式')
  })

  it('缺凭据（锁定态缓存空）：刷新报「缺少凭据」且不构造 backend', async () => {
    useBackends({})
    const w = await mountCard(mkPlatform({}, {}))
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('.cloud-backups').text()).toContain('缺少凭据')
    expect(createCloudBackend).not.toHaveBeenCalled()
  })

  it('listBackups 抛错：区块内行内报「列表获取失败」，整卡其余功能不受影响', async () => {
    useBackends({ webdav: fakeBackend({ listBackups: vi.fn(async () => { throw new Error('401 Unauthorized') }) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('.cloud-backups').text()).toContain('列表获取失败')
    expect(w.find('.cloud-backups').text()).toContain('401')
    expect(w.find('button.creds-save').attributes('disabled')).toBeUndefined()
  })
})
```

（`VueWrapper` 类型从 `@vue/test-utils` 导入补进头部 import。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudCard.backupList.test.ts`
Expected: FAIL（`.cloud-backups` 区块不存在）

- [ ] **Step 3: 实现**

`CloudCard.vue` script 部分：

1. import 增补：`@totp/core` 行加 `openBackupEnvelope`（Task 4 用，此处可一并加）；`cloudSyncShared` import 行加 `listCloudBackups`（现从 `'./cloudSyncShared'` 导入 `actionStatusLabelKey, allTargetsSettled, buildSyncTargets, errorDigest, runExclusive, runKeepRetention`）。
2. 在「extension 冲突副本视图」区之后追加状态与方法：

```ts
// ---------- 云端备份列表（plan23 §1：每源折叠区+按需刷新；core/Rust 零改动，直调既有 backend 成员） ----------
interface CloudBackupView { path: string; base: string; at: number | null }
/** 每源云端备份缓存：手动刷新是唯一更新入口（挂载不自动拉，避免打开页面触发 N 个网络请求）；源移除清空 */
const backupsBySource = ref<Record<string, { items: CloudBackupView[]; complete: boolean }>>({})
const backupsLoading = ref<Record<string, boolean>>({})
const backupsError = ref<Record<string, string>>({})

/** 源凭据解析（onConfirmReset 同口径）：编辑副本非空白优先，回落已存凭据；锁定态缓存空 → undefined */
function credOf(s: BackupSource): CloudCred | undefined {
  const draft = credDrafts.value[s.id]
  return draft && !isBlankCred(draft) ? draft : props.platform?.creds[s.id]
}

/** 拉取该源远端时间戳备份名单：缺凭据行内报错不构造 backend；网络错误行内展示不炸整卡 */
async function refreshBackups(s: BackupSource): Promise<void> {
  if (backupsLoading.value[s.id]) return
  const cred = credOf(s)
  if (!cred || isBlankCred(cred)) {
    backupsError.value[s.id] = t('cloudCard.missingCreds')
    return
  }
  backupsLoading.value[s.id] = true
  backupsError.value[s.id] = ''
  try {
    backupsBySource.value[s.id] = await listCloudBackups(createCloudBackend(cred))
  } catch (e) {
    backupsError.value[s.id] = t('cloudCard.backupsLoadFailed', { message: trunc(String((e as Error)?.message ?? e)) })
  } finally {
    backupsLoading.value[s.id] = false
  }
}

function backupsFor(id: string): { items: CloudBackupView[]; complete: boolean } | null {
  return backupsBySource.value[id] ?? null
}
/** 文件名时间戳 → 本地时间展示（不可解析名恒不出此列，防御兜底空串） */
function backupTime(at: number | null): string {
  return at === null ? '' : new Date(at).toLocaleString()
}
```

3. `removeTarget` 函数内 `delete credDrafts.value[id]` 行后追加：

```ts
  delete backupsBySource.value[id]
  delete backupsLoading.value[id]
  delete backupsError.value[id]
```

Template：`<template v-if="expanded === i">` 内 `<CloudCredFields ... />` 之后追加：

```html
        <!-- 云端备份区块（plan23 §1）：手动刷新按需加载；空态按保留模式分流说明 -->
        <div class="cloud-backups">
          <div class="cloud-backups-head">
            <span class="cloud-backups-title">{{ t('cloudCard.backupsTitle') }}</span>
            <MdButton variant="text" class="backup-refresh" :disabled="busy || confirmPending || backupsLoading[s.id] === true" @click="refreshBackups(s)">{{ t('cloudCard.backupsRefresh') }}</MdButton>
          </div>
          <p v-if="backupsError[s.id]" class="hint">{{ backupsError[s.id] }}</p>
          <template v-if="backupsFor(s.id)">
            <p v-if="backupsFor(s.id)!.items.length === 0" class="hint">
              {{ s.retention.type === 'overwrite' ? t('cloudCard.backupsEmptyOverwrite') : t('cloudCard.backupsEmpty') }}
            </p>
            <template v-else>
              <p v-if="!backupsFor(s.id)!.complete" class="hint">{{ t('cloudCard.backupsTruncated') }}</p>
              <ul class="cloud-backup-list">
                <li v-for="b in backupsFor(s.id)!.items" :key="b.path">
                  <span class="bname">{{ b.base }}</span>
                  <span v-if="b.at !== null" class="btime">{{ backupTime(b.at) }}</span>
                </li>
              </ul>
            </template>
          </template>
        </div>
```

style 末尾追加：

```css
/* 云端备份区块（plan23 §1）：标题行+刷新；列表行名+时间小字（对齐 BackupCard.backup-list 观感） */
.cloud-backups { display: flex; flex-direction: column; gap: 4px; }
.cloud-backups-head { display: flex; align-items: center; gap: 8px; }
.cloud-backups-title { font-size: var(--md-sys-typescale-title-small); font-weight: 500; }
.cloud-backup-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.cloud-backup-list li { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-small); }
.cloud-backup-list .bname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cloud-backup-list .btime { opacity: .65; flex: none; }
```

i18n：两个 locale 文件的 `cloudCard` 域内、`"resetCloud"` 键之前插入（zh 值如下；en 同键位插入英文值）：

zh（`packages/ui/src/i18n/locales/zh/common.json`）：

```json
    "backupsTitle": "云端备份",
    "backupsRefresh": "刷新",
    "backupsTruncated": "云端备份较多，列表可能不完整（分页达上限），最新份始终可见",
    "backupsEmpty": "云端暂无时间戳备份；同步一次后可在此查看与管理",
    "backupsEmptyOverwrite": "覆盖模式云端仅保留单一对象，由同步链路管理；改用「保留最近」可留存历史份",
    "backupsLoadFailed": "云端备份列表获取失败：{message}",
```

en（`packages/ui/src/i18n/locales/en/common.json`）：

```json
    "backupsTitle": "Cloud backups",
    "backupsRefresh": "Refresh",
    "backupsTruncated": "Many cloud backups: the list may be incomplete (pagination limit); the newest is always visible",
    "backupsEmpty": "No timestamped backups in the cloud yet; run a sync to see and manage them here",
    "backupsEmptyOverwrite": "Overwrite mode keeps a single remote object managed by the sync flow; switch to \"Keep recent\" to retain history",
    "backupsLoadFailed": "Failed to list cloud backups: {message}",
```

（`missingCreds` 为既有键，复用不新增。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudCard.backupList.test.ts test/cloudCard.sources.test.ts test/BackupCard.test.ts`
Expected: PASS（新用例 + 既有卡内回归）

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/CloudCard.vue packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/test/cloudCard.backupList.test.ts
git commit -m "feat(ui): CloudCard 每云源增「云端备份」按需列表区

why: plan23 §1——云端 listBackups 五后端齐备但无用户可见列表，
补齐与本地源对齐的列表能力（手动刷新按需加载，N 源零自动请求）。
what: 区块 UI+每源缓存/加载/错误态+空态按保留模式分流+截断提示+zh/en 文案。"
```

---

### Task 4: 恢复动作——预解密校验 → 两步确认 → persistDownloaded（不写基线）

**Files:**
- Modify: `packages/ui/src/components/CloudCard.vue`
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`
- Test: `packages/ui/test/cloudCard.backupList.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 3 的 `credOf`/区块 DOM；既有 `openBackupEnvelope`（core）、`parseVaultJson`、`useConfirmPattern` 槽组、`persistDownloaded`。
- Produces: confirm 槽 `'backupRestore'`（payload=`${sourceId}\n${name}`）、`onRestoreClick(s, path)`、`onConfirmBackupRestore()`、`onCancelBackupRestore()`；DOM：行内 `button.backup-restore`、确认行 `.backup-restore-row`（按钮 `button.backup-restore-confirm`/`button.backup-restore-cancel`）。Task 5/6 槽组同款。

- [ ] **Step 1: 写失败测试**

`cloudCard.backupList.test.ts` 顶部 import 增 `createBackupEnvelope`（自 `@totp/core`）与 `VueWrapper`（若 Task 3 未加）；文件尾追加：

```ts
async function envelopeBytes(vault: string, password = 'pw'): Promise<Uint8Array> {
  return new TextEncoder().encode(JSON.stringify(await createBackupEnvelope(vault, password, 'balanced')))
}

describe('CloudCard 云端备份恢复（plan23 §2）', () => {
  it('恢复：确认前完成读取/解密/校验；确认后 persistDownloaded 收明文，且不写任何基线', async () => {
    useBackends({ webdav: fakeBackend({ get: vi.fn(async () => await envelopeBytes(VALID_VAULT)) }) })
    const persist = vi.fn(async () => {})
    const saveState = vi.fn(async () => {})
    const w = await mountCard(mkPlatform({ persistDownloaded: persist, saveSourceState: saveState }))
    await expand(w, 0)
    await w.find('button.backup-restore').trigger('click')
    await flushPromises()
    expect(w.find('.backup-restore-row').exists()).toBe(true)
    expect(persist).not.toHaveBeenCalled() // 确认前不落库
    await w.find('button.backup-restore-confirm').trigger('click')
    await flushPromises()
    expect(persist).toHaveBeenCalledWith(VALID_VAULT)
    expect(saveState).not.toHaveBeenCalled() // 刻意不写 SourceSyncState 基线（spec §2）
    expect(w.find('.backup-restore-row').exists()).toBe(false)
  })

  it('get 空（已被并发删除/置空）：报「不存在或为空」，不进入确认行', async () => {
    useBackends({ webdav: fakeBackend({ get: vi.fn(async () => null) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('button.backup-restore').trigger('click')
    await flushPromises()
    expect(w.find('.backup-restore-row').exists()).toBe(false)
    expect(w.find('.err').exists()).toBe(true)
  })

  it('口令不匹配（他口令信封）：报错不进入确认行', async () => {
    useBackends({ webdav: fakeBackend({ get: vi.fn(async () => await envelopeBytes(VALID_VAULT, 'other-pw')) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('button.backup-restore').trigger('click')
    await flushPromises()
    expect(w.find('.backup-restore-row').exists()).toBe(false)
    expect(w.find('.err').exists()).toBe(true)
  })

  it('解密成功但内容非法（parseVaultJson 不过）：报错不进入确认行', async () => {
    useBackends({ webdav: fakeBackend({ get: vi.fn(async () => await envelopeBytes('{"foo":1}')) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('button.backup-restore').trigger('click')
    await flushPromises()
    expect(w.find('.backup-restore-row').exists()).toBe(false)
    expect(w.find('.err').exists()).toBe(true)
  })

  it('取消确认：本地存储不动、确认行收起', async () => {
    useBackends({ webdav: fakeBackend({ get: vi.fn(async () => await envelopeBytes(VALID_VAULT)) }) })
    const persist = vi.fn(async () => {})
    const w = await mountCard(mkPlatform({ persistDownloaded: persist }))
    await expand(w, 0)
    await w.find('button.backup-restore').trigger('click')
    await flushPromises()
    await w.find('button.backup-restore-cancel').trigger('click')
    await flushPromises()
    expect(persist).not.toHaveBeenCalled()
    expect(w.find('.backup-restore-row').exists()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudCard.backupList.test.ts`
Expected: FAIL（`button.backup-restore` 不存在）

- [ ] **Step 3: 实现**

`CloudCard.vue` script：

1. `useConfirmPattern(['adopt', 'reset', 'remove'])` 改为 `useConfirmPattern(['adopt', 'reset', 'remove', 'backupRestore', 'backupDelete'])`（`backupDelete` 槽 Task 5 消费；spec §5 的 `backupDel` 落地名即 `backupDelete`），并在既有槽别名后追加：

```ts
const pendingRestore = confirmSlots.backupRestore
const pendingDelete = confirmSlots.backupDelete // Task 5 消费
```

2. 云端备份区追加恢复逻辑：

```ts
/** 恢复挂起份的解密产物：get/解密/校验全部在进入确认行**之前**完成（spec §2：坏份/错口令
 *  不进入确认流，同 onSync 的 parseVaultJson 先行口径）；确认只做 persistDownloaded */
const pendingRestoreJson = ref('')

async function onRestoreClick(s: BackupSource, name: string): Promise<void> {
  const p = props.platform
  const cred = credOf(s)
  if (!p || !cred || isBlankCred(cred) || !props.sessionSecret) return
  busy.value = true
  try {
    const secret: string = props.sessionSecret
    const bytes = await createCloudBackend(cred).get(name)
    if (bytes === null) throw new Error(t('cloudCard.backupReadEmpty'))
    const json = await openBackupEnvelope(JSON.parse(new TextDecoder().decode(bytes)), secret)
    parseVaultJson(json) // 恢复校验先行：不合格不进入确认流
    pendingRestoreJson.value = json
    askConfirm('backupRestore', `${s.id}\n${name}`)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

/** 确认行文案取名单（payload=`${sourceId}\n${name}`；备份名受 BACKUP_NAME_RE 约定无 \n） */
function restoreTargetName(): string {
  const raw = pendingRestore.value ?? ''
  return raw.slice(raw.indexOf('\n') + 1)
}

/** 确认恢复：整体替换本地（adopt 同链路）；**刻意不写基线**——恢复历史份=本地有意偏离云端
 *  最新，基线保持不动，下次同步按既有四分支收敛（本地已改→上传/合并提示），与 adopt 的
 *  pendingStates 机制方向相反（spec §2） */
async function onConfirmBackupRestore(): Promise<void> {
  const p = props.platform
  const json = pendingRestoreJson.value
  if (!p || !json) {
    pendingRestore.value = null
    return
  }
  busy.value = true
  try {
    await p.persistDownloaded(json)
    msg.value = t('cloudCard.backupRestored')
    msgKind.value = 'ok'
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
  pendingRestore.value = null
  pendingRestoreJson.value = ''
}

function onCancelBackupRestore(): void {
  pendingRestore.value = null
  pendingRestoreJson.value = ''
}
```

Template：列表行 `<li>` 内 `.btime` 之后追加（Task 3 行内暂无按钮）：

```html
                  <MdButton variant="text" class="backup-restore" :disabled="busy || confirmPending || !sessionSecret" @click="onRestoreClick(s, b.path)">{{ t('cloudCard.backupRestore') }}</MdButton>
```

文件底部确认行区（`pendingReset` 确认行之后）追加：

```html
    <div v-if="pendingRestore" class="confirm-row backup-restore-row">
      <span>{{ t('cloudCard.backupRestoreConfirm', { name: restoreTargetName() }) }}</span>
      <MdButton danger class="backup-restore-confirm" :disabled="busy" @click="onConfirmBackupRestore">{{ t('cloudCard.backupRestoreBtn') }}</MdButton>
      <MdButton variant="text" class="backup-restore-cancel" :disabled="busy" @click="onCancelBackupRestore">{{ t('cloudCard.cancel') }}</MdButton>
    </div>
```

i18n，zh（同 Task 3 插入点继续前置插入即可，键域同属 cloudCard）：

```json
    "backupRestore": "恢复",
    "backupReadEmpty": "云端备份不存在或内容为空",
    "backupRestoreConfirm": "用云端备份「{name}」整体替换当前本地数据？该操作不改变同步基线，下次同步将按合并/上传收敛。",
    "backupRestoreBtn": "确认恢复",
    "backupRestored": "已从云端备份恢复本地数据",
```

en：

```json
    "backupRestore": "Restore",
    "backupReadEmpty": "Cloud backup does not exist or is empty",
    "backupRestoreConfirm": "Replace all local data with cloud backup \"{name}\"? This does not change the sync baseline; the next sync converges via merge/upload.",
    "backupRestoreBtn": "Restore",
    "backupRestored": "Local data restored from cloud backup",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudCard.backupList.test.ts test/CloudCard.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/CloudCard.vue packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/test/cloudCard.backupList.test.ts
git commit -m "feat(ui): 云端备份按名恢复（预解密校验+两步确认，不写基线）

why: plan23 §2——对齐本地 restoreByName 体验；坏份/错口令不进确认流；
恢复历史份=本地有意偏离云端最新，刻意不写 rev 基线靠既有四分支收敛。
what: backupRestore confirm 槽 + 预解密校验流 + persistDownloaded 落库 + 文案。"
```

---

### Task 5: 删除动作——两步确认 + gist 伪删标注 + 删后刷新

**Files:**
- Modify: `packages/ui/src/components/CloudCard.vue`
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`
- Test: `packages/ui/test/cloudCard.backupList.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 4 的 `'backupDelete'` 槽、`credOf`；既有 `backend.delete`、`refreshBackups`。
- Produces: `onConfirmBackupDelete()`/`onCancelBackupDelete()`/`deleteTarget()`；DOM：行内 `button.backup-delete`、确认行 `.backup-delete-row`（`button.backup-delete-confirm`/`button.backup-delete-cancel`、标注 `.gist-delete-note`）。

- [ ] **Step 1: 写失败测试**

```ts
describe('CloudCard 云端备份删除（plan23 §3）', () => {
  it('删除：两步确认 → delete(原名) → 自动刷新该源列表；webdav 无 gist 标注', async () => {
    const list = vi.fn(async () => ['vault-20261010-090000.totpbackup'])
    const del = vi.fn(async () => {})
    useBackends({ webdav: fakeBackend({ listBackups: list, delete: del }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-delete').trigger('click')
    await flushPromises()
    expect(w.find('.backup-delete-row').exists()).toBe(true)
    expect(w.find('.backup-delete-row').text()).toContain('vault-20261010-090000.totpbackup')
    expect(w.find('.gist-delete-note').exists()).toBe(false)
    await w.find('button.backup-delete-confirm').trigger('click')
    await flushPromises()
    expect(del).toHaveBeenCalledWith('vault-20261010-090000.totpbackup')
    expect(list).toHaveBeenCalledTimes(2) // 删除成功后自动刷新（初刷 + 删后刷）
    expect(w.find('.backup-delete-row').exists()).toBe(false)
  })

  it('gist 源：确认行显示伪删标注（内容置空、骨架残留）', async () => {
    useBackends({ gist: fakeBackend({ id: 'gist', listBackups: vi.fn(async () => ['vault-20261010-090000.totpbackup']) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 1) // SOURCE_GIST
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-delete').trigger('click')
    await flushPromises()
    expect(w.find('.gist-delete-note').exists()).toBe(true)
  })

  it('取消：不调 delete、列表不刷新', async () => {
    const list = vi.fn(async () => ['vault-20261010-090000.totpbackup'])
    const del = vi.fn(async () => {})
    useBackends({ webdav: fakeBackend({ listBackups: list, delete: del }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-delete').trigger('click')
    await flushPromises()
    await w.find('button.backup-delete-cancel').trigger('click')
    await flushPromises()
    expect(del).not.toHaveBeenCalled()
    expect(list).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudCard.backupList.test.ts`
Expected: FAIL（`button.backup-delete` 不存在）

- [ ] **Step 3: 实现**

`CloudCard.vue` script，云端备份区追加（Task 4 的恢复函数之后）：

```ts
/** 确认行解析（payload=`${sourceId}\n${name}`）：name 展示用 + 定位源供 gist 标注/删后刷新 */
function deleteTarget(): { name: string; source: BackupSource | undefined } {
  const raw = pendingDelete.value ?? ''
  const id = raw.slice(0, raw.indexOf('\n'))
  return { name: raw.slice(raw.indexOf('\n') + 1), source: sources.value.find((x) => x.id === id) }
}

/** 确认删除：delete(原名)（与列表同域）→ 成功后自动刷新该源名单。rev 基线不动：删最新份后
 *  下轮同步按既有分支收敛（内容比对/碰撞核验兜底；云端清空走「无对象→续钟重推」），spec §3 */
async function onConfirmBackupDelete(): Promise<void> {
  const { source, name } = deleteTarget()
  const cred = source ? credOf(source) : undefined
  if (!source || !cred || isBlankCred(cred)) {
    pendingDelete.value = null
    return
  }
  busy.value = true
  try {
    await createCloudBackend(cred).delete(name)
    msg.value = t('cloudCard.backupDeleted')
    msgKind.value = 'ok'
    await refreshBackups(source)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
  pendingDelete.value = null
}

function onCancelBackupDelete(): void {
  pendingDelete.value = null
}
```

Template：列表行内追加删除按钮（恢复按钮之后）：

```html
                  <MdButton variant="text" danger class="backup-delete" :disabled="busy || confirmPending" @click="askConfirm('backupDelete', `${s.id}\n${b.path}`)">{{ t('cloudCard.backupDelete') }}</MdButton>
```

确认行区追加：

```html
    <div v-if="pendingDelete" class="confirm-row backup-delete-row">
      <span>{{ t('cloudCard.backupDeleteConfirm', { name: deleteTarget().name }) }}</span>
      <!-- gist 伪删如实标注（spec §3）：PATCH content='' 非真删，骨架残留但列表/滚动清理即刻不可见 -->
      <span v-if="deleteTarget().source?.kind === 'gist'" class="hint gist-delete-note">{{ t('cloudCard.gistDeleteNote') }}</span>
      <MdButton danger class="backup-delete-confirm" :disabled="busy" @click="onConfirmBackupDelete">{{ t('cloudCard.confirmDelete') }}</MdButton>
      <MdButton variant="text" class="backup-delete-cancel" :disabled="busy" @click="onCancelBackupDelete">{{ t('cloudCard.cancel') }}</MdButton>
    </div>
```

i18n，zh：

```json
    "backupDelete": "删除",
    "backupDeleteConfirm": "删除云端备份「{name}」？此操作不可撤销。",
    "confirmDelete": "确认删除",
    "backupDeleted": "云端备份已删除",
    "gistDeleteNote": "Gist 无法真删：内容置空后条目骨架仍残留，但不再出现在本列表与滚动清理中",
```

en：

```json
    "backupDelete": "Delete",
    "backupDeleteConfirm": "Delete cloud backup \"{name}\"? This cannot be undone.",
    "confirmDelete": "Delete",
    "backupDeleted": "Cloud backup deleted",
    "gistDeleteNote": "Gist cannot truly delete: content is cleared but the file skeleton remains; it disappears from this list and from retention cleanup",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudCard.backupList.test.ts test/CloudCard.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/CloudCard.vue packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/test/cloudCard.backupList.test.ts
git commit -m "feat(ui): 云端备份手动删除（两步确认+gist 伪删标注+删后刷新）

why: plan23 §3——保留策略自动滚动之外的手动清理出口；gist PATCH 置空
伪删语义须如实标注；rev 基线不动靠既有编排分支收敛。
what: backupDelete confirm 槽 + delete(原名) + 删后自动刷新 + 文案。"
```

---

### Task 6: 导出动作——能力检测 + 密文原件落盘

**Files:**
- Modify: `packages/ui/src/components/CloudCard.vue`
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`
- Test: `packages/ui/test/cloudCard.backupList.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `platform.saveBackupFile?`；`credOf`；`backend.get`。
- Produces: `onBackupExport(s, path)`；DOM：行内 `button.backup-export`（仅 `platform.saveBackupFile` 提供时渲染）。

- [ ] **Step 1: 写失败测试**

```ts
describe('CloudCard 云端备份导出（plan23 §4）', () => {
  it('有 saveBackupFile 能力：导出按钮渲染，get 原字节 → saveBackupFile(basename, bytes)', async () => {
    const bytes = new TextEncoder().encode('{"envelope":1}')
    useBackends({ webdav: fakeBackend({ listBackupsEx: vi.fn(async () => ({ names: ['d/vault-20261010-090000.totpbackup'], complete: true })), get: vi.fn(async () => bytes) }) })
    const save = vi.fn(async () => true)
    const w = await mountCard(mkPlatform({ saveBackupFile: save }))
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-export').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith('vault-20261010-090000.totpbackup', bytes)
  })

  it('无 saveBackupFile 能力：不渲染导出按钮（能力检测）', async () => {
    useBackends({ webdav: fakeBackend({ listBackups: vi.fn(async () => ['vault-20261010-090000.totpbackup']) }) })
    const w = await mountCard(mkPlatform())
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    expect(w.find('button.backup-export').exists()).toBe(false)
  })

  it('get 空：报「不存在或为空」，不调 saveBackupFile', async () => {
    useBackends({ webdav: fakeBackend({ listBackups: vi.fn(async () => ['vault-20261010-090000.totpbackup']) }) })
    const save = vi.fn(async () => true)
    const w = await mountCard(mkPlatform({ saveBackupFile: save }))
    await expand(w, 0)
    await w.find('.cloud-backups button.backup-refresh').trigger('click')
    await flushPromises()
    await w.find('button.backup-export').trigger('click')
    await flushPromises()
    expect(save).not.toHaveBeenCalled()
    expect(w.find('.err').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudCard.backupList.test.ts`
Expected: FAIL（`button.backup-export` 不存在）

- [ ] **Step 3: 实现**

`CloudCard.vue` script，云端备份区追加：

```ts
/** 导出密文原件（spec §4 唯一下载出口=显式点击）：get 原字节交宿主落盘，**不解密**（离线留存/
 *  迁移语义）；保存名取 basename（dir/name → name）。取消（false）静默，与 saveImageFile 同口径 */
async function onBackupExport(s: BackupSource, name: string): Promise<void> {
  const p = props.platform
  if (!p?.saveBackupFile) return
  const cred = credOf(s)
  if (!cred || isBlankCred(cred)) return
  busy.value = true
  try {
    const bytes = await createCloudBackend(cred).get(name)
    if (bytes === null) throw new Error(t('cloudCard.backupReadEmpty'))
    await p.saveBackupFile(name.split('/').filter((x) => x !== '').pop() ?? name, bytes)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
```

Template：列表行内、恢复与删除按钮之间追加：

```html
                  <MdButton v-if="platform.saveBackupFile" variant="text" class="backup-export" :disabled="busy || confirmPending" @click="onBackupExport(s, b.path)">{{ t('cloudCard.backupExport') }}</MdButton>
```

i18n，zh：`"backupExport": "导出",`；en：`"backupExport": "Export",`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudCard.backupList.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/CloudCard.vue packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/test/cloudCard.backupList.test.ts
git commit -m "feat(ui): 云端备份密文原件导出（能力检测按钮）

why: plan23 §4——离线留存/迁移需要原样下载云端份；落盘通道因宿主而异，
经 Task 1 的 saveBackupFile 可选成员能力检测。
what: 行内导出按钮 + get 原字节交宿主（不解密）+ 文案。"
```

---

### Task 7: desktop `saveBackupFile` 实现（另存对话框 + 文本写盘）

**Files:**
- Modify: `apps/desktop/src/backupService.ts`（新增导出函数）
- Modify: `apps/desktop/src/cloudPlatforms.ts`（overrides 注入）
- Test: `apps/desktop/src/backupServiceOs.test.ts`（追加 describe）

**Interfaces:**
- Consumes: `pickBackupSaveOs`/`writeTextFileOs`（backupService.ts:37/253 既有）。
- Produces: `saveBackupFileOs(name: string, bytes: Uint8Array): Promise<boolean>`；cloudPlatforms overrides 的 `saveBackupFile`。

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/backupServiceOs.test.ts` 追加（复用该文件既有 tauriMock 导入与 beforeEach 复位；若该文件的 import 列表未含 `saveBackupFileOs` 则补进既有 `from '../src/backupService'` import）：

```ts
describe('saveBackupFileOs（plan23 §4）', () => {
  it('另存确认：.totpbackup 过滤器 + 文本写盘通道收到 UTF-8 信封文本，返回 true', async () => {
    tauriMock.onReturn('pick_save_file_os', { path: 'C:\\out\\vault-20261010-090000.totpbackup', dirToken: 'tk' })
    const bytes = new TextEncoder().encode('{"envelope":1}')
    await expect(saveBackupFileOs('vault-20261010-090000.totpbackup', bytes)).resolves.toBe(true)
    const [pick] = tauriMock.calls('pick_save_file_os')
    expect((pick?.args as { filters: Array<{ extensions: string[] }> }).filters[0]?.extensions).toContain('totpbackup')
    const [write] = tauriMock.calls('write_text_file_os')
    expect(write?.args).toMatchObject({ path: 'C:\\out\\vault-20261010-090000.totpbackup', contents: '{"envelope":1}' })
  })

  it('取消另存：返回 false，不写盘', async () => {
    tauriMock.onReturn('pick_save_file_os', null)
    const bytes = new TextEncoder().encode('{"envelope":1}')
    await expect(saveBackupFileOs('vault-20261010-090000.totpbackup', bytes)).resolves.toBe(false)
    expect(tauriMock.calls('write_text_file_os')).toHaveLength(0)
  })
})
```

（`tauriMock.onReturn/calls` API 见 `apps/desktop/test/mocks/tauri.ts:139/145`；同文件既有用例 backupPlatform.test.ts:148-170 为同款先例。若本文件用例风格不同，以本文件相邻用例为准对齐 arrange。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/desktop exec vitest run src/backupServiceOs.test.ts`
Expected: FAIL（saveBackupFileOs 未导出）

- [ ] **Step 3: 实现**

`apps/desktop/src/backupService.ts`，在 `writeBytesFileOs`（L259 附近）之后追加：

```ts
/** 云端备份密文原件另存（plan23 §4）：picked 由 pickBackupSaveOs 产生，遏制基准=其登记父目录。
 *  信封 JSON 是 UTF-8 文本，走 write_text_file_os 通道（EXPORT_EXTENSIONS 含 .totpbackup）——
 *  write_bytes_file_os 白名单 .png 专属（dialog_grants.rs:506），不适用。取消另存=false */
export async function saveBackupFileOs(name: string, bytes: Uint8Array): Promise<boolean> {
  const picked = await pickBackupSaveOs(name, [{ name: 'TOTP 备份', extensions: ['totpbackup'] }])
  if (!picked) return false
  await writeTextFileOs(picked, new TextDecoder().decode(bytes))
  return true
}
```

`apps/desktop/src/cloudPlatforms.ts`：`from './backupService'` import 行加 `saveBackupFileOs`；overrides 对象（`proxySupport: true,` 之前）追加：

```ts
      // plan23 §4：云端备份密文原件另存（信封 JSON 走文本写盘通道，见 saveBackupFileOs 注释）
      saveBackupFile: (name, bytes) => saveBackupFileOs(name, bytes),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/desktop exec vitest run src/backupServiceOs.test.ts src/cloudPlatforms.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/backupService.ts apps/desktop/src/cloudPlatforms.ts apps/desktop/src/backupServiceOs.test.ts
git commit -m "feat(desktop): 云端备份密文原件另存（对话框+文本写盘通道）

why: plan23 §4——CloudPlatform.saveBackupFile 的桌面实现；信封 JSON 是
UTF-8 文本走 write_text_file_os（EXPORT_EXTENSIONS 已含 .totpbackup），
Rust 零改动（write_bytes_file_os 白名单 .png 不适用，spec 已勘误）。
what: saveBackupFileOs 助手 + 云平台 overrides 注入。"
```

---

### Task 8: extension `saveBackupFile` 实现（Blob 下载）

**Files:**
- Modify: `apps/extension/src/optionsPlatforms.ts`（overrides 注入）
- Test: `apps/extension/test/optionsApp.test.ts`（追加用例）

**Interfaces:**
- Consumes: `downloadBlob`（optionsPlatforms.ts:27 已导入）；`stubBlobUrl()`（optionsApp.test.ts:237-239）与 `makePlatform()`（optionsApp.test.ts:262-267，`createOptionsCloudPlatform` describe 内既有装配助手）。
- Produces: options 云平台 `saveBackupFile`（恒 true，无取消回执——`saveTextFile` 同口径）。

- [ ] **Step 1: 写失败测试**

`apps/extension/test/optionsApp.test.ts` 的 `describe('createOptionsCloudPlatform（host 装配 + extension 差异注入）')`（L261）内追加用例（复用该 describe 的 `makePlatform()` 与文件级 `stubBlobUrl()`）：

```ts
  it('saveBackupFile：Blob 下载通道恒 true（plan23 §4）', async () => {
    stubBlobUrl()
    const { platform } = makePlatform()
    const calls0 = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    await expect(platform.saveBackupFile!('vault-20261010-090000.totpbackup', new TextEncoder().encode('{"envelope":1}'))).resolves.toBe(true)
    expect((URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls0 + 1)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/extension exec vitest run test/optionsApp.test.ts`
Expected: FAIL（platform.saveBackupFile 为 undefined）

- [ ] **Step 3: 实现**

`apps/extension/src/optionsPlatforms.ts`，`createOptionsCloudPlatform` overrides 内 `exportConflictCopy` 行之后追加：

```ts
    // 云端备份密文原件下载(plan23 §4):Blob 走 saveTextFile 同款 a[download] 通道;无「取消」回执,恒 true
    saveBackupFile: async (name, bytes) => {
      downloadBlob(name, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }))
      return true
    },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/extension exec vitest run test/optionsApp.test.ts test/cloudRunnerFactory.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/extension/src/optionsPlatforms.ts apps/extension/test/optionsApp.test.ts
git commit -m "feat(extension): 云端备份密文原件 Blob 下载（saveBackupFile 注入）

why: plan23 §4——扩展端落盘通道即 a[download] Blob（saveTextFile 同款），
无取消回执恒 true。
what: options 云平台 overrides 注入 saveBackupFile + 单测。"
```

---

### Task 9: 全量回归 + typecheck 收口

**Files:**
- 无新改动（纯验证；如回归暴露问题，修复后随本 Task 提交并注明）

**Interfaces:**
- Consumes: Task 1-8 全部产物。

- [ ] **Step 1: 三端全量测试**

```bash
pnpm --filter @totp/ui test && pnpm --filter @totp/desktop test && pnpm --filter @totp/extension test && pnpm --filter @totp/core test
```
Expected: 全绿（core 不受影响，跑一遍兜底）

- [ ] **Step 2: typecheck**

```bash
pnpm --filter @totp/ui run typecheck && pnpm --filter @totp/desktop run typecheck && pnpm --filter @totp/extension run typecheck
```
Expected: 零错误

- [ ] **Step 3: 中文文案抽查**

人工（或 grep）核对 zh/en 两 locale 键集合一致：

```bash
node -e "const zh=require('./packages/ui/src/i18n/locales/zh/common.json').cloudCard,en=require('./packages/ui/src/i18n/locales/en/common.json').cloudCard;const k=Object.keys(zh).filter(x=>/backup/i.test(x));const miss=k.filter(x=>!(x in en));console.log(miss.length?['缺 en 键:',...miss]:['zh/en 备份键齐: '+k.length])"
```
Expected: `zh/en 备份键齐: 17`

- [ ] **Step 4: 如有修复则提交（无修复跳过）**

```bash
git add -A -- packages/ui apps/desktop/src apps/extension/src
git commit -m "fix(ui): plan23 回归修复（随实测问题注明具体项）"
```

---

## Self-Review 记录（计划完成时已核）

1. **Spec 覆盖**：§1 列表=Task 2/3；§2 恢复=Task 4；§3 删除=Task 5；§4 导出=Task 1/6/7/8；§5 UI 槽/禁用矩阵/i18n=Task 3-6；§6 模块清单与 Tasks 对应；测试策略=各 Task Step 1 + Task 9；backlog 两项不在本计划（spec 已排除出范围）。
2. **占位符**：无 TBD/TODO；Task 1/Task 8 测试装配已按实际测试文件核实后写为实码（host 工厂无既有直测文件→新建 `hostCloudPlatform.test.ts` 哑对象直测；extension 侧复用 `makePlatform()`/`stubBlobUrl()` 既有助手，optionsApp.test.ts:262-267/237-239 已核实）。
3. **类型一致**：`saveBackupFile?(name: string, bytes: Uint8Array): Promise<boolean>` 在 Task 1 接口/overrides 与 Task 6/7/8 消费处一致；`CloudBackupItem{path,base,at}` Task 2 定义、Task 3 消费一致；confirm 槽 payload `${sourceId}\n${name}` Task 4/5 一致；`listCloudBackups` 返回 `{items, complete}` Task 2/3 一致。
