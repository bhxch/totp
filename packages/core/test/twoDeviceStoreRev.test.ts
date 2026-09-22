// T-FINAL Fix1（I-1）回归：F8 水位（store 加密落盘恒推进 vault.rev）× 同步链路内容 hash 口径。
//
// twoDevice.test.ts 模式的变体：vault JSON 恒带顶层 rev（生产 store 形态——getVaultJson 返回的
// 明文含 F8 水位字段），并模拟 store 的两条 rev 推进语义：
// - persistAdopted：采纳落盘（replaceAllOp→saveVaultToAdapter）→ vault.rev = max(cur,floor)+1；
// - 本地编辑（commit 同道）→ 同样推进 rev。
// core 集成层本无 store 水位（twoDevice.test.ts 不可见此缺陷），此处补齐：内容 hash 剔除顶层 rev
// 后，①采纳轮下一轮 in-sync/零写；②采纳轮后编辑一次全程恰 1 次 PUT（旧口径下采纳轮后的
// 「in-sync 轮」恒因 rev 字段误判本地已动，多产一次冗余云写）。
import { describe, expect, it } from 'vitest'
import {
  createSyncEnvelope,
  openBackupEnvelope,
  readSyncHeader,
} from '../src/backup/envelope'
import type { OtpEntry, Vault } from '../src/model'
import type { BackupSource } from '../src/backup/sources'
import type { CloudBackend } from '../src/cloud/backend'
import { contentHashVault } from '../src/cloud/canonical'
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
/** 生产 store 明文形态：恒带 F8 水位字段 rev */
const vw = (entries: OtpEntry[], updatedAt = 1, rev = 5): string =>
  JSON.stringify({ version: 2, entries, tags: [], updatedAt, rev })
/** 条目摘要（按 uuid 排序）：'uuid:label' 列表，供内容断言 */
const entriesOf = (json: string): string[] =>
  (JSON.parse(json) as Vault).entries.map((x) => `${x.uuid}:${x.label}`).sort()

// ---- 装配：共享 fake 云 + 双设备（含 store 水位模拟）----

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

/** 预置云端为 v3 信封；baseContentHash 与 core 校验端同口径（contentHashVault） */
async function seedCloudV3(backend: ReturnType<typeof fakeCloud>, rev: number, content: string): Promise<void> {
  const env = await createSyncEnvelope(content, PW, 'balanced', {
    rev,
    deviceId: 'seed',
    baseRev: rev - 1,
    baseContentHash: await contentHashVault(content),
  })
  backend.store.set(PATH, ENC.encode(JSON.stringify(env)))
}

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

/** store 水位模拟（F8）：加密写恒推进 vault.rev——采纳落盘与本地编辑同一语义 */
function bumpRev(json: string): string {
  const vault = JSON.parse(json) as { rev?: unknown }
  const cur = typeof vault.rev === 'number' && Number.isInteger(vault.rev) && vault.rev >= 0 ? vault.rev : 0
  return JSON.stringify({ ...vault, rev: cur + 1 })
}

interface Device {
  readonly name: string
  readonly deviceId: string
  local(): string
  edit(fn: (vault: Vault) => void): void
  copies(): Array<{ key: string; bytes: Uint8Array }>
  run(backend: CloudBackend): Promise<MultiTargetSyncResult>
}

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
      local = bumpRev(JSON.stringify(vault)) // commit → saveVaultToAdapter 推进 rev
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
      for (const [key, s] of Object.entries(r.states)) await saveSyncState(adapter, key, s)
      // persistAdopted 语义：收敛结果落盘时 store 推进 rev
      local = r.adopted ? bumpRev(r.finalVaultJson) : r.finalVaultJson
      return r
    },
  }
}

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

describe('双设备收敛 × F8 水位（vault 明文恒带 rev，store 推进语义模拟）', () => {
  it('稳态零写 + 采纳轮下一轮 in-sync 零写 + 采纳后各编辑一次恰 1 次 PUT', { timeout: 30_000 }, async () => {
    const base = vw([e('a', { label: 'base' })], 1, 5)
    const cloud = fakeCloud()
    await seedCloudV3(cloud, 1, base)
    const devA = await makeDevice('A', base, seedState(base))
    const devB = await makeDevice('B', base, seedState(base))

    // 稳态：带 rev 的 vault 与基线一致 → 双侧 in-sync 零写（rev 字段不判「本地已动」）
    expect(await devA.run(cloud).then((r) => r.results[0]!.outcome?.action)).toBe('in-sync')
    expect(await devB.run(cloud).then((r) => r.results[0]!.outcome?.action)).toBe('in-sync')
    expect(cloud.putCount).toBe(0)

    // 设备 A 编辑一次 → 交替同步收敛：A 上传 1 次，B downloaded 采纳（落盘带 rev 推进）
    devA.edit((vt) => { vt.entries = [...vt.entries, e('x', { label: 'added-by-a', updatedAt: 2 })] })
    const trace1 = await runUntilInSync([devA, devB], cloud)
    expect(trace1).toEqual(['A:uploaded', 'B:downloaded', 'A:in-sync', 'B:in-sync'])
    expect(cloud.putCount).toBe(1) // 采纳轮的下一轮（B 第二轮）零写——缺陷锚①

    // 采纳轮后设备 B 编辑一次 → 全程恰 1 次 PUT（B 上传；A downloaded 采纳后次轮零写）
    const putsBefore = cloud.putCount
    devB.edit((vt) => { vt.entries = [...vt.entries, e('y', { label: 'added-by-b', updatedAt: 3 })] })
    const trace2 = await runUntilInSync([devA, devB], cloud)
    // 轮次按 [A,B] 顺序：A 先跑时云端未动 → in-sync（零写）；B 上传后 A 下载采纳、次轮零写
    expect(trace2).toEqual(['A:in-sync', 'B:uploaded', 'A:downloaded', 'B:in-sync', 'A:in-sync', 'B:in-sync'])
    expect(cloud.putCount - putsBefore).toBe(1) // 缺陷锚②：旧口径下恒多一次冗余云写

    // 双端与云端内容一致（rev 剔除口径），双方条目都在
    const expected = ['a:base', 'x:added-by-a', 'y:added-by-b']
    expect(entriesOf(devA.local())).toEqual(expected)
    expect(entriesOf(devB.local())).toEqual(expected)
    expect(entriesOf(await cloudPlain(cloud))).toEqual(expected)
    expect(await contentHashVault(devA.local())).toBe(await contentHashVault(devB.local()))
    expect(await contentHashVault(devB.local())).toBe(await contentHashVault(await cloudPlain(cloud)))

    // 云对象 rev 单调（store 水位推进 rev 不入云时钟，不破坏单调性）
    expect(cloud.putRevs).toEqual([2, 3])
    expectRevMonotonic(cloud)
    expect(devA.copies()).toEqual([])
    expect(devB.copies()).toEqual([])
  })
})
