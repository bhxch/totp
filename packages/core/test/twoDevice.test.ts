// 双设备收敛集成测试（spec §7 测试策略、验收口径 1/2 的自动化形态，Task 13）。
//
// 纯 core 层 E2E：两台设备 = 各自独立 StorageAdapter（loadSyncState/saveSyncState 持久
// SourceSyncState）+ 各自 deviceId；云端 = 共享 fake backend（单一云对象，记录每次 put 的
// sync.rev 序列供单调性断言）。设备一轮 run = syncMultipleTargets（primary 单目标）+
// states 幂等回写 + 采纳 finalVaultJson（宿主 persistAdopted 语义），交替执行直至双侧 in-sync。
//
// 场景1：两设备先后改不同条目 → 交替同步收敛，双方条目都在（无整库覆盖）、零冲突副本；
// 场景2：同条目两设备改成不同内容 → 三方合并取 updatedAt 新者 + conflicts 非空；模拟裁决
//        （按 pick 重写本地 vault）后二次同步 → 双侧收敛到裁决结果、conflicts 清空、无额外副本；
// 场景3：v2 旧信封预置云端 → 首轮同步降级两方合并采纳 + 云端对象升级为 v3（readSyncHeader 非 null）。
import { describe, expect, it } from 'vitest'
import {
  createBackupEnvelope,
  createSyncEnvelope,
  openBackupEnvelope,
  readSyncHeader,
} from '../src/backup/envelope'
import type { OtpEntry, Vault } from '../src/model'
import type { BackupSource } from '../src/backup/sources'
import type { CloudBackend } from '../src/cloud/backend'
import { contentHash } from '../src/cloud/canonical'
import { loadDeviceId, loadSyncState, saveSyncState, type SourceSyncState } from '../src/cloud/syncState'
import { createMemoryStorage } from '../src/storage/memory'
import { syncMultipleTargets, type MultiTargetSyncResult } from '../src/cloud/multiTarget'

const PW = '口令123'
const PATH = 'totp-backup.totpbackup'
const SOURCE_ID = 'cloud-1'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

const e = (uuid: string, over: Partial<OtpEntry> = {}): OtpEntry => ({
  uuid, type: 'totp', issuer: 'I', label: uuid, secret: 'S', algorithm: 'SHA1', digits: 6, period: 30,
  tagIds: [], order: 0, createdAt: 1, updatedAt: 1, ...over,
})
const v = (entries: OtpEntry[], updatedAt = 1): string => JSON.stringify({ version: 2, entries, tags: [], updatedAt })
/** 条目摘要（按 uuid 排序）：'uuid:label' 列表，供内容断言 */
const entriesOf = (json: string): string[] =>
  (JSON.parse(json) as Vault).entries.map((x) => `${x.uuid}:${x.label}`).sort()

// ---- 装配：共享 fake 云 + 双设备 ----

/** 共享 fake 云后端：单一云对象；putCount/putRevs 记录每次 put 的 sync.rev 序列（断言单调） */
function fakeCloud(): CloudBackend & { store: Map<string, Uint8Array>; putCount: number; putRevs: Array<number | null> } {
  const store = new Map<string, Uint8Array>()
  const backend: CloudBackend & { store: Map<string, Uint8Array>; putCount: number; putRevs: Array<number | null> } = {
    id: 'webdav',
    putCount: 0,
    putRevs: [],
    async put(path, data) {
      backend.putCount++
      const header = readSyncHeader(JSON.parse(DEC.decode(data)))
      backend.putRevs.push(header?.rev ?? null)
      store.set(path, data)
    },
    async get(path) {
      return store.get(path) ?? null
    },
    async delete(path) {
      store.delete(path)
    },
    async exists(path) {
      return store.has(path)
    },
    store,
  }
  return backend
}

/** 预置云端为 v3 信封（既有机群稳态：rev + base 声明与内容自洽） */
async function seedCloudV3(backend: ReturnType<typeof fakeCloud>, rev: number, content: string): Promise<void> {
  const env = await createSyncEnvelope(content, PW, 'balanced', {
    rev,
    deviceId: 'seed',
    baseRev: rev - 1,
    baseContentHash: await contentHash(content),
  })
  backend.store.set(PATH, ENC.encode(JSON.stringify(env)))
}

/** 云端对象解密为 vault 明文 */
async function cloudPlain(backend: ReturnType<typeof fakeCloud>): Promise<string> {
  const bytes = backend.store.get(PATH)
  expect(bytes).toBeDefined()
  return openBackupEnvelope(JSON.parse(DEC.decode(bytes!)), PW)
}

/** rev 序列单调断言：所有 put 均为 v3（sync.rev 非 null）且严格递增 */
function expectRevMonotonic(backend: ReturnType<typeof fakeCloud>): void {
  expect(backend.putRevs.length).toBeGreaterThan(0)
  expect(backend.putRevs.every((r) => r !== null)).toBe(true)
  for (let i = 1; i < backend.putRevs.length; i++) {
    expect(backend.putRevs[i]!).toBeGreaterThan(backend.putRevs[i - 1]!)
  }
}

interface Device {
  readonly name: string
  readonly deviceId: string
  /** 当前本机 vault 明文 JSON（run 后为采纳的收敛结果） */
  local(): string
  /** 本机编辑（宿主本地变更语义） */
  edit(fn: (vault: Vault) => void): void
  /** 本机冲突副本收集器（宿主冲突副本存储，extension=storage.local / desktop=backups 目录的替身） */
  copies(): Array<{ key: string; bytes: Uint8Array }>
  /** 同步一轮：syncMultipleTargets（primary 单目标）+ states 幂等回写 + 采纳 final */
  run(backend: CloudBackend): Promise<MultiTargetSyncResult>
}

/** 设备工厂：独立 memory adapter + deviceId + SourceSyncState 持久化（seedState 供既有机群稳态预置） */
async function makeDevice(name: string, initialVaultJson: string, seedState?: SourceSyncState): Promise<Device> {
  const adapter = createMemoryStorage()
  const deviceId = await loadDeviceId(adapter)
  if (seedState) await saveSyncState(adapter, SOURCE_ID, seedState)
  let local = initialVaultJson
  const copies: Array<{ key: string; bytes: Uint8Array }> = []
  const source: BackupSource = {
    id: SOURCE_ID, kind: 'webdav', name: '云同步', retention: { type: 'overwrite' }, enabled: true, role: 'primary',
  }
  return {
    name,
    deviceId,
    local: () => local,
    edit(fn) {
      const vault = JSON.parse(local) as Vault
      fn(vault)
      vault.updatedAt = vault.updatedAt + 1
      local = JSON.stringify(vault)
    },
    copies: () => copies,
    async run(backend) {
      const state = await loadSyncState(adapter, SOURCE_ID)
      const r = await syncMultipleTargets({
        targets: [{ key: SOURCE_ID, backend, path: PATH, source, state }],
        vaultJson: local,
        password: PW,
        deviceId,
        onConflictBackup: (key, bytes) => {
          copies.push({ key, bytes })
        },
      })
      // 宿主逐源幂等回写：states 恒含全部参与源键
      for (const [key, s] of Object.entries(r.states)) await saveSyncState(adapter, key, s)
      // persistAdopted 语义：收敛结果落为本机 vault
      local = r.finalVaultJson
      return r
    },
  }
}

/** 交替同步直至双侧 in-sync（单目标场景 primary action 即设备动作）；返回 '设备:动作' 轨迹 */
async function runUntilInSync(devices: Device[], cloud: ReturnType<typeof fakeCloud>, maxSweeps = 10): Promise<string[]> {
  const trace: string[] = []
  const last = new Map<Device, string>()
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    for (const d of devices) {
      const r = await d.run(cloud)
      const action = r.results[0]!.outcome?.action ?? 'error'
      last.set(d, action)
      trace.push(`${d.name}:${action}`)
    }
    if (devices.every((d) => last.get(d) === 'in-sync')) return trace
  }
  throw new Error(`未在 ${maxSweeps} 轮内收敛：${trace.join(' → ')}`)
}

const seedState = (content: string): SourceSyncState => ({ lastKnownRemoteRev: 1, baseSnapshot: content })

describe('双设备收敛（共享云对象，primary 单目标 + state 幂等回写）', () => {
  it('场景1：先后改不同条目 → 交替同步收敛，双方条目都在（无整库覆盖）、零冲突副本、rev 单调', { timeout: 30_000 }, async () => {
    const base = v([e('a', { label: 'base' })])
    const cloud = fakeCloud()
    await seedCloudV3(cloud, 1, base)
    const devA = await makeDevice('A', base, seedState(base))
    const devB = await makeDevice('B', base, seedState(base))

    // 设备 A 新增条目 x → 交替同步至收敛（B 经 downloaded 采纳 x，不整库覆盖 B 的既有内容）
    devA.edit((vt) => { vt.entries = [...vt.entries, e('x', { label: 'added-by-a', updatedAt: 2 })] })
    const trace1 = await runUntilInSync([devA, devB], cloud)
    expect(trace1).toEqual(['A:uploaded', 'B:downloaded', 'A:in-sync', 'B:in-sync'])

    // 设备 B 新增条目 y（基于已含 x 的最新内容）→ 交替同步至收敛
    devB.edit((vt) => { vt.entries = [...vt.entries, e('y', { label: 'added-by-b', updatedAt: 3 })] })
    const trace2 = await runUntilInSync([devA, devB], cloud)
    expect(trace2).toEqual(['A:in-sync', 'B:uploaded', 'A:downloaded', 'B:in-sync', 'A:in-sync', 'B:in-sync'])

    // 两端 vault 内容一致（与云端一致），双方条目都在：base + x + y
    const expected = ['a:base', 'x:added-by-a', 'y:added-by-b']
    expect(entriesOf(devA.local())).toEqual(expected)
    expect(entriesOf(devB.local())).toEqual(expected)
    expect(entriesOf(await cloudPlain(cloud))).toEqual(expected)
    expect(await contentHash(devA.local())).toBe(await contentHash(devB.local()))
    expect(await contentHash(devB.local())).toBe(await contentHash(await cloudPlain(cloud)))

    // 云对象 rev 单调递增（seed rev1 经 store 直写不入 putRevs；同步写为 2、3）
    expect(cloud.putRevs).toEqual([2, 3])
    expectRevMonotonic(cloud)
    // 无冲突副本文件产生（全程 uploaded/downloaded/in-sync，无 merged 分支）
    expect(devA.copies()).toEqual([])
    expect(devB.copies()).toEqual([])
  })

  it('场景2：同条目改成不同内容 → 合并取 updatedAt 新者 + conflicts 非空；裁决后二次同步收敛且 conflicts 清空、无额外副本', { timeout: 30_000 }, async () => {
    const base = v([e('a', { label: 'base' })])
    const cloud = fakeCloud()
    await seedCloudV3(cloud, 1, base)
    const devA = await makeDevice('A', base, seedState(base))
    const devB = await makeDevice('B', base, seedState(base))

    // 双设备离线并发改同一条目（A updatedAt 5 / B updatedAt 9）
    devA.edit((vt) => {
      const a = vt.entries.find((x) => x.uuid === 'a')!
      a.label = 'from-a'
      a.updatedAt = 5
    })
    devB.edit((vt) => {
      const a = vt.entries.find((x) => x.uuid === 'a')!
      a.label = 'from-b'
      a.updatedAt = 9
    })

    // A 先推（uploaded rev2），B 后推 → 三方合并（base 自洽）：updatedAt 新者（B）为主体，conflicts 非空
    const rA1 = await devA.run(cloud)
    expect(rA1.results[0]!.outcome).toMatchObject({ action: 'uploaded', newRev: 2 })
    const rB1 = await devB.run(cloud)
    expect(rB1.results[0]!.outcome).toMatchObject({ action: 'merged', newRev: 3 })
    expect(rB1.conflicts).toHaveLength(1)
    const c = rB1.conflicts[0]!
    expect(c.entryId).toBe('a')
    expect(c.ours).toMatchObject({ label: 'from-b' }) // updatedAt 新者为合并主体
    expect(c.theirs).toMatchObject({ label: 'from-a' })
    expect(c.base).toMatchObject({ label: 'base' })
    expect(entriesOf(devB.local())).toEqual(['a:from-b'])

    // 模拟裁决（宿主裁决 UI 取云地方 = theirs，重写本地 vault）
    devB.edit((vt) => { vt.entries = [c.theirs!] })

    // 二次同步：收敛到裁决结果（而非合并默认主体），全程无 merged → conflicts 清空、无额外副本
    const trace = await runUntilInSync([devA, devB], cloud)
    expect(trace).toEqual(['A:downloaded', 'B:uploaded', 'A:downloaded', 'B:in-sync', 'A:in-sync', 'B:in-sync'])
    expect(trace).not.toContain('B:merged')

    const expected = ['a:from-a']
    expect(entriesOf(devA.local())).toEqual(expected)
    expect(entriesOf(devB.local())).toEqual(expected)
    expect(entriesOf(await cloudPlain(cloud))).toEqual(expected)
    expect(await contentHash(devA.local())).toBe(await contentHash(devB.local()))

    // rev 单调：2（A 并发改动上传）→ 3（B 合并上传）→ 4（裁决重写上传）
    expect(cloud.putRevs).toEqual([2, 3, 4])
    expectRevMonotonic(cloud)
    // 副本恰一份：B 合并轮的安全副本（合并前本地旧内容，安全序契约）；裁决后二次同步零新增
    expect(devA.copies()).toEqual([])
    expect(devB.copies()).toHaveLength(1)
    const copyEntries = JSON.parse(await openBackupEnvelope(JSON.parse(DEC.decode(devB.copies()[0]!.bytes)), PW)) as Vault
    expect(entriesOf(JSON.stringify(copyEntries))).toEqual(['a:from-b'])
  })

  it('场景3：v2 旧信封预置云端 → 首轮同步降级合并采纳内容并升级为 v3（readSyncHeader 非 null），次轮 in-sync 零写', { timeout: 30_000 }, async () => {
    const v2Content = v([e('a', { label: 'from-v2' })])
    const cloud = fakeCloud()
    // 预置 v2 信封（无 sync 头）：旧版本客户端写入形态
    const v2Env = await createBackupEnvelope(v2Content, PW)
    cloud.store.set(PATH, ENC.encode(JSON.stringify(v2Env)))

    // 新设备仅含本地条目 b（无同步状态）接入 v2 机群
    const devC = await makeDevice('C', v([e('b')]))
    const r1 = await devC.run(cloud)
    expect(r1.results[0]!.outcome).toMatchObject({ action: 'merged', newRev: 1, mergeDegraded: true })
    expect(r1.adopted).toBe(true)

    // 云端对象升级为 v3：sync 头自洽（rev=1 从本端已知时钟续起、baseContentHash=v2 旧内容）
    const upgraded = JSON.parse(DEC.decode(cloud.store.get(PATH)!)) as { v: number; sync: { rev: number; deviceId: string; baseRev: number; baseContentHash: string } }
    expect(readSyncHeader(upgraded)).not.toBeNull()
    expect(upgraded.v).toBe(3)
    expect(upgraded.sync).toMatchObject({
      rev: 1,
      deviceId: devC.deviceId,
      baseRev: 0,
      baseContentHash: await contentHash(v2Content),
    })

    // 内容正确采纳：v2 云端的 a 与本地 b 两方并集，均不丢
    const expected = ['a:from-v2', 'b:b']
    expect(entriesOf(devC.local())).toEqual(expected)
    expect(entriesOf(await cloudPlain(cloud))).toEqual(expected)

    // 升级后立即稳态：次轮 in-sync 零写（无新 put、rev 不再推进）
    const r2 = await devC.run(cloud)
    expect(r2.results[0]!.outcome).toMatchObject({ action: 'in-sync' })
    expect(r2.adopted).toBe(false)
    expect(cloud.putCount).toBe(1)
    expect(cloud.putRevs).toEqual([1])
    expectRevMonotonic(cloud)

    // 冲突副本恰一份：合并前本地旧内容（安全序契约），可同口令解开
    expect(devC.copies()).toHaveLength(1)
    const copyEntries = JSON.parse(await openBackupEnvelope(JSON.parse(DEC.decode(devC.copies()[0]!.bytes)), PW)) as Vault
    expect(entriesOf(JSON.stringify(copyEntries))).toEqual(['b:b'])
  })
})
