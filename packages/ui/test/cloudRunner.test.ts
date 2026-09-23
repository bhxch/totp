/** T9 rev 编排改写：deps 换 loadSyncState/saveSyncState + loadContentHash/saveContentHash（持久内容门），
 *  busy → single-flight chain（排队串行）、manual 预览确认、pull 通道改 syncWithCloudRev 只读形态；
 *  原 apply 通道用例语义平移保留。新增键文案断言用 LOCAL_T 兜底（资源键随 commit E 落 zh/en，值一致） */
import { describe, expect, it, vi } from 'vitest'
import {
  CloudHttpError, contentHash, contentHashVault, createSyncEnvelope,
  type BackupSource, type CloudBackend, type CloudCred, type SourceSyncState,
} from '@totp/core'
import { createCloudSyncRunner, type CloudRunnerDeps, type ManualMergePreview } from '../src/components/cloudRunner'
import { createTestI18n } from './helpers/i18n'

const PW = 'pw'
const PATH = 'totp-backup.totpbackup'
// 完整 Vault 形态（mergeVaults 消费 tags/version 字段——merged 场景跑真实编排）
const A = JSON.stringify({ version: 2, entries: [{ uuid: 'a', label: 'A' }], tags: [], updatedAt: 1 })
const B = JSON.stringify({ version: 2, entries: [{ uuid: 'b', label: 'B' }], tags: [], updatedAt: 2 })
const AB = JSON.stringify({ version: 2, entries: [{ uuid: 'a', label: 'A' }, { uuid: 'b2', label: 'AB' }], tags: [], updatedAt: 3 })
const bytesOf = (s: string) => new TextEncoder().encode(s)

/** runner 新增文案键（zh 资源随 commit E 落地；此处兜底同值，防测试依赖提交顺序） */
const LOCAL_T: Record<string, string> = {
  'cloudRunner.action.mergedDegraded': '已合并（降级）',
  'cloudRunner.manualSkipped': '手动合并已跳过',
}
/** t 注入 zh 资源查找（D2 抽串）：runner 摘要断言维持 zh 字面量与资源逐字一致 */
const testT = createTestI18n().global.t
const injectT = (key: string, params: Record<string, unknown> = {}): string => LOCAL_T[key] ?? testT(key, params)

const WEBDAV_CRED: CloudCred = { backend: 'webdav', serverUrl: 'https://dav', username: 'u', password: 'p' }
const GIST_CRED: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }

/** 缺省 primary（推拉通道 run() 必须有 enabled primary，否则 core 抛 no primary target）；replica 显式指定 */
const source = (id: string, over: Partial<BackupSource> = {}): BackupSource => ({
  id, kind: 'webdav', name: id, retention: { type: 'overwrite' }, enabled: true, role: 'primary', ...over,
})
const revState = (lastKnownRemoteRev: number | null, baseSnapshot: string | null): SourceSyncState => ({ lastKnownRemoteRev, baseSnapshot })

/** 以 v3 信封预置远端（他设备写入形态）；baseContentHash 可注入错误值构造降级合并 */
async function sealedRemote(rev: number, content: string, baseContentHash?: string): Promise<Uint8Array> {
  const env = await createSyncEnvelope(content, PW, 'balanced',
    { rev, deviceId: 'dev-other', baseRev: rev - 1, baseContentHash: baseContentHash ?? (await contentHash(content)) })
  return bytesOf(JSON.stringify(env))
}

/** 内存 fake 后端（复用 core multiTarget.test 模式）：可预置 PATH 初始内容，putCount 供断言重推。
 *  keep 用例可再挂 listBackups（缺省不挂=后端不支持 → enforceRemoteRetention 返回 -1）。 */
function fakeBackend(initial?: Uint8Array): CloudBackend & { store: Map<string, Uint8Array>; putCount: number } {
  const store = new Map<string, Uint8Array>()
  if (initial) store.set(PATH, initial)
  const backend: CloudBackend & { store: Map<string, Uint8Array>; putCount: number } = {
    store,
    id: 'webdav',
    putCount: 0,
    async put(path, data) {
      backend.putCount++
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
  }
  return backend
}

/** 有状态内容门基线（模拟宿主持久化闭环）：load/saveContentHash 读写同一 map（null=删键），
 *  供跨实例（页面重开模拟）与门短路用例验证「基线真实生效」 */
function statefulContentHash() {
  const map = new Map<string, string>()
  return {
    map,
    loadContentHash: vi.fn(async (): Promise<string | null> => map.get('gate') ?? null),
    saveContentHash: vi.fn(async (h: string | null): Promise<void> => {
      if (h === null) map.delete('gate')
      else map.set('gate', h)
    }),
  }
}

/** 基线 deps：解锁、有 secret、默认无源（可逐项覆写）；makeBackend 默认每次新建 fake backend。
 *  返回的 mock 引用在 over 覆盖后取 deps 上的最终值（断言永远指向实际注入的实现） */
function makeDeps(over: Partial<CloudRunnerDeps> = {}) {
  const loadSourcesDef = vi.fn(async (): Promise<Array<{ source: BackupSource; cred: CloudCred }>> => [])
  const gate = statefulContentHash()
  const loadSyncStateDef = vi.fn(async (): Promise<SourceSyncState> => ({ lastKnownRemoteRev: null, baseSnapshot: null }))
  const saveSyncStateDef = vi.fn(async () => undefined)
  const deviceIdDef = vi.fn(async (): Promise<string> => 'dev-test')
  const persistAdoptedDef = vi.fn(async (_json: string) => undefined)
  const saveConflictBackupDef = vi.fn()
  const onRetentionDeletedDef = vi.fn()
  const recordStatusDef = vi.fn()
  const onErrorDef = vi.fn()
  const onProgressDef = vi.fn()
  const onConflictsDef = vi.fn()
  const backends: Array<CloudBackend & { store: Map<string, Uint8Array>; putCount: number }> = []
  const deps: CloudRunnerDeps = {
    isLocked: () => false,
    getSecret: () => PW,
    getVaultJson: () => A,
    loadSources: loadSourcesDef,
    loadSyncState: loadSyncStateDef,
    saveSyncState: saveSyncStateDef,
    deviceId: deviceIdDef,
    loadContentHash: gate.loadContentHash,
    saveContentHash: gate.saveContentHash,
    makeBackend: () => {
      const b = fakeBackend()
      backends.push(b)
      return b
    },
    persistAdopted: persistAdoptedDef,
    saveConflictBackup: saveConflictBackupDef,
    onRetentionDeleted: onRetentionDeletedDef,
    recordStatus: recordStatusDef,
    t: injectT,
    onProgress: onProgressDef,
    onConflicts: onConflictsDef,
    onError: onErrorDef,
    ...over,
  }
  return {
    deps,
    loadSources: deps.loadSources as typeof loadSourcesDef,
    loadSyncState: deps.loadSyncState as typeof loadSyncStateDef,
    saveSyncState: deps.saveSyncState as typeof saveSyncStateDef,
    loadContentHash: deps.loadContentHash as typeof gate.loadContentHash,
    saveContentHash: deps.saveContentHash as typeof gate.saveContentHash,
    persistAdopted: deps.persistAdopted as typeof persistAdoptedDef,
    saveConflictBackup: deps.saveConflictBackup as typeof saveConflictBackupDef,
    onRetentionDeleted: deps.onRetentionDeleted as typeof onRetentionDeletedDef,
    recordStatus: deps.recordStatus as typeof recordStatusDef,
    onProgress: deps.onProgress as typeof onProgressDef,
    onConflicts: deps.onConflicts as typeof onConflictsDef,
    onError: deps.onError as typeof onErrorDef,
    backends,
  }
}

describe('createCloudSyncRunner', () => {
  it('①锁定 → 记 null 跳过态（库已锁定），不读源、不建 backend', async () => {
    const { deps, loadSources, recordStatus } = makeDeps({ isLocked: () => true })
    await createCloudSyncRunner(deps).run()
    expect(loadSources).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenCalledWith(null, '库已锁定')
  })

  it('②无 secret → 记 null 跳过态（未设置备份口令），直接 return', async () => {
    const { deps, loadSources, recordStatus } = makeDeps({ getSecret: () => null })
    await createCloudSyncRunner(deps).run()
    expect(loadSources).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenCalledWith(null, '未设置备份口令')
  })

  it('③空源 → 记 null 跳过态（未启用云源），不建 backend、不回写 rev 基线', async () => {
    const { deps, backends, saveSyncState, recordStatus } = makeDeps()
    await createCloudSyncRunner(deps).run()
    expect(backends).toHaveLength(0)
    expect(saveSyncState).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenCalledWith(null, '未启用云源')
  })

  it('④仅 enabled 源进入编排：disabled 不建 backend，enabled 正常回写 rev 基线（key=source.id）', async () => {
    const { deps, backends, saveSyncState } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-webdav'), cred: WEBDAV_CRED },
        { source: source('s-gist', { kind: 'gist', role: 'replica' }), cred: GIST_CRED, },
      ].filter((p) => p.source.enabled)),
    })
    // 一个 enabled 一个 disabled 的组合单独跑
    const { deps: deps2, backends: backends2, saveSyncState: save2 } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-on'), cred: WEBDAV_CRED },
        { source: source('s-off', { enabled: false, role: 'replica' }), cred: GIST_CRED },
      ]),
    })
    await createCloudSyncRunner(deps).run()
    void backends; void saveSyncState
    await createCloudSyncRunner(deps2).run()
    expect(backends2).toHaveLength(1)
    expect(save2).toHaveBeenCalledTimes(1)
    expect(save2).toHaveBeenCalledWith('s-on', expect.any(Object))
  })

  it('⑤path=resolveObjectPath(cred)：objectPath 自定义（含反斜杠）透传为归一路径', async () => {
    const b = fakeBackend()
    const { deps } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: { ...WEBDAV_CRED, objectPath: 'custom/dir\\bk.json' } }]),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run()
    expect([...b.store.keys()]).toEqual(['custom/dir/bk.json'])
  })

  it('⑥rev 基线透传与成功回写：云端 rev/内容与 state 一致 → in-sync（不重推），state 原样回写（key=source.id）', async () => {
    const st = revState(1, A)
    const b = fakeBackend(await sealedRemote(1, A))
    const { deps, loadSyncState, saveSyncState } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async (id: string) => (id === 's1' ? st : { lastKnownRemoteRev: null, baseSnapshot: null })),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run()
    expect(loadSyncState).toHaveBeenCalledWith('s1')
    expect(b.putCount).toBe(0) // 基线生效 → in-sync 零写
    expect(saveSyncState).toHaveBeenCalledWith('s1', { ...st, baseSnapshot: A })
  })

  it('⑥b失败源基线不落盘：bad 源抛错 → state 原样不动，good 源正常推导回写', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络错误')
    }
    const good = fakeBackend()
    const stBad = revState(2, A)
    const { deps, saveSyncState } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-bad', { kind: 'gist' }), cred: GIST_CRED },
        { source: source('s-good', { role: 'replica' }), cred: WEBDAV_CRED },
      ]),
      loadSyncState: vi.fn(async (id: string) => (id === 's-bad' ? stBad : { lastKnownRemoteRev: null, baseSnapshot: null })),
      makeBackend: (cred) => (cred.backend === 'gist' ? bad : good),
    })
    await createCloudSyncRunner(deps).run()
    // 失败源：自身基线原样回写（幂等），成功源正常推导
    expect(saveSyncState).toHaveBeenCalledWith('s-bad', stBad)
    expect(saveSyncState).toHaveBeenCalledWith('s-good', expect.objectContaining({ lastKnownRemoteRev: 1 }))
    expect(deps.onError).not.toHaveBeenCalled() // 单源失败不视为整体失败
  })

  it('⑦adopted → persistAdopted(finalVaultJson)，状态记 ok=true（summary key=源 id）', async () => {
    const b = fakeBackend(await sealedRemote(2, B))
    const { deps, persistAdopted, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => revState(1, A)), // 本地未动（=基线）云端较新 → downloaded
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run()
    expect(persistAdopted).toHaveBeenCalledTimes(1)
    expect(persistAdopted).toHaveBeenCalledWith(B)
    expect(recordStatus).toHaveBeenCalledWith(true, 's1: 已下载')
  })

  it('⑧loadSources 抛错 → 不向上抛，onError 与 recordStatus(false) 收到', async () => {
    const { deps, onError, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => {
        throw new Error('凭据读取失败')
      }),
    })
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(recordStatus).toHaveBeenCalledWith(false, '凭据读取失败')
  })

  it('⑧badopt 落盘失败 → 基线不回写（下轮自动重试下载），onError 与 recordStatus(false) 收到', async () => {
    const b = fakeBackend(await sealedRemote(2, B))
    const { deps, saveSyncState, onError, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => revState(1, A)),
      makeBackend: () => b,
      persistAdopted: vi.fn(async () => {
        throw new Error('落盘失败')
      }),
    })
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    expect(saveSyncState).not.toHaveBeenCalled() // 先采纳后回写：落盘失败本轮 states 一并不落盘
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(recordStatus).toHaveBeenCalledWith(false, '落盘失败')
  })

  it('⑨single-flight：并发 run() 排队串行完成（第二排在第一后），均执行而非丢弃', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let entered!: () => void
    const enteredP = new Promise<void>((r) => { entered = r })
    let json = A
    const { deps, loadSources, recordStatus } = makeDeps({
      getVaultJson: () => json,
      loadSources: vi.fn(async () => {
        entered() // 信号：首轮已进 loadSources（vaultJson 快照已捕获）
        await gate
        return [{ source: source('s1'), cred: WEBDAV_CRED }]
      }),
    })
    const runner = createCloudSyncRunner(deps)
    const p1 = runner.run()
    const p2 = runner.run() // 在途 → 排队（不丢弃）
    await enteredP
    expect(recordStatus).not.toHaveBeenCalled() // 第二轮未并发执行（串行化生效）
    json = B // 首轮在途期间内容变更
    release()
    await Promise.all([p1, p2])
    expect(loadSources).toHaveBeenCalledTimes(2) // 两轮都执行
    expect(recordStatus).toHaveBeenCalledTimes(2)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已上传') // 第二轮真实完成（内容已变，不被门短路）
  })

  it('⑩成功 summary：逐源 `id: 中文动作` 拼接；冲突副本回调带源 id 透传', async () => {
    // 双方都动（本地 AB 相对基线 A 已改、云端被 dev-other 改写 AC，且其 base 声明=A）→ merged：副本先行、合并结果上传
    const ac = JSON.stringify({ version: 2, entries: [{ uuid: 'a', label: 'A' }, { uuid: 'c', label: 'C' }], tags: [], updatedAt: 5 })
    const b = fakeBackend(await sealedRemote(5, ac, await contentHash(A))) // baseOk=true 非降级
    const { deps, recordStatus, saveConflictBackup } = makeDeps({
      getVaultJson: () => AB,
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => revState(1, A)),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run()
    expect(recordStatus).toHaveBeenCalledWith(true, 's1: 已合并')
    // jsdom 环境 runner/测试分属不同 realm，expect.any(Uint8Array) 的 instanceof 判定失效 →
    // 改查内部 slot（ArrayBuffer.isView 跨 realm 可靠），字节视图契约不变
    expect(saveConflictBackup).toHaveBeenCalledTimes(1)
    const [conflictKey, conflictBytes] = saveConflictBackup.mock.calls[0]!
    expect(conflictKey).toBe('s1')
    expect(ArrayBuffer.isView(conflictBytes)).toBe(true)
  })

  it('⑩bmerged 降级（祖先声明不符）→ summary 用 mergedDegraded 专用文案', async () => {
    const ac = JSON.stringify({ version: 2, entries: [{ uuid: 'a', label: 'A' }, { uuid: 'c', label: 'C' }], tags: [], updatedAt: 5 })
    const b = fakeBackend(await sealedRemote(5, ac)) // baseContentHash=hash(ac) ≠ hash(A) → 降级两方合并
    const { deps, recordStatus } = makeDeps({
      getVaultJson: () => AB,
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => revState(1, A)),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run()
    expect(recordStatus).toHaveBeenCalledWith(true, 's1: 已合并（降级）')
  })

  it('⑩cmerged 冲突记录经 onMergeConflicts 入库，onConflicts 读 conflictCount 对账', async () => {
    // 双方改成不同内容（id 'a'）→ updatedAt 新者为主体、另一方入冲突记录
    const ac = JSON.stringify({ version: 2, entries: [{ uuid: 'a', label: 'A-other', updatedAt: 9 }], tags: [], updatedAt: 5 })
    const onMergeConflicts = vi.fn()
    const remote = await sealedRemote(5, ac, await contentHash(A))
    const { deps, onConflicts } = makeDeps({
      getVaultJson: () => JSON.stringify({ version: 2, entries: [{ uuid: 'a', label: 'A-local', updatedAt: 1 }], tags: [], updatedAt: 3 }),
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => revState(1, A)),
      makeBackend: () => fakeBackend(remote),
      onMergeConflicts,
      conflictCount: () => 2, // 宿主闭包：store.conflictCount（入库后）
    })
    await createCloudSyncRunner(deps).run()
    expect(onMergeConflicts).toHaveBeenCalledTimes(1)
    expect(onMergeConflicts.mock.calls[0]![0].map((c: { entryId: string }) => c.entryId)).toEqual(['a'])
    expect(onConflicts).toHaveBeenCalledWith(2) // 每轮结束读宿主 conflictCount
  })

  it('⑩b错误消息截断 100 字符后写状态', async () => {
    const long = 'x'.repeat(150)
    const { deps, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => {
        throw new Error(long)
      }),
    })
    await createCloudSyncRunner(deps).run()
    expect(recordStatus).toHaveBeenCalledWith(false, 'x'.repeat(100))
  })

  it('⑪双同类型源：两个 webdav 源各自独立 key/基线回写，互不串扰', async () => {
    const b1 = fakeBackend()
    const b2 = fakeBackend()
    const { deps, saveSyncState, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('home'), name: '家里 WebDAV', objectPath: 'home/totp-backup.totpbackup' , cred: { ...WEBDAV_CRED, objectPath: 'home/totp-backup.totpbackup' } },
        { source: source('office', { role: 'replica' }), name: '公司 WebDAV', objectPath: 'office/totp-backup.totpbackup', cred: { ...WEBDAV_CRED, objectPath: 'office/totp-backup.totpbackup' } },
      ]),
      makeBackend: (cred) => ((cred as { objectPath?: string }).objectPath?.startsWith('home') ? b1 : b2),
    })
    await createCloudSyncRunner(deps).run()
    expect([...b1.store.keys()]).toEqual(['home/totp-backup.totpbackup'])
    expect([...b2.store.keys()]).toEqual(['office/totp-backup.totpbackup'])
    expect(saveSyncState).toHaveBeenCalledWith('home', expect.objectContaining({ lastKnownRemoteRev: 1 }))
    expect(saveSyncState).toHaveBeenCalledWith('office', expect.objectContaining({ lastKnownRemoteRev: 1 }))
    expect(recordStatus).toHaveBeenCalledWith(true, 'home: 已上传; office: 已上传')
  })

  it('⑫keep 源：读侧=名单内最新份参与判定，写侧=新时间戳名，uploaded 后滚动删除超额旧份并回调', async () => {
    const b = fakeBackend()
    // 旧份必须是真信封（读侧 readPath=最新份参与 rev 判定）：内容与本地基线自洽（rev3==known、
    // 内容==baseSnapshot）、本地已改 → uploaded 写新份
    b.store.set('dir/vault-20260101-000000.totpbackup', await sealedRemote(1, A))
    b.store.set('dir/vault-20260202-000000.totpbackup', await sealedRemote(2, A))
    b.store.set('dir/vault-20260303-000000.totpbackup', await sealedRemote(3, A))
    b.listBackups = async () => [...b.store.keys()]
    const { deps, onRetentionDeleted } = makeDeps({
      getVaultJson: () => B, // 本地已改（≠基线 A）
      loadSources: vi.fn(async () => [
        { source: source('s-keep', { retention: { type: 'keep', n: 2 } }), cred: { ...WEBDAV_CRED, objectPath: 'dir/totp-backup.totpbackup' } },
      ]),
      loadSyncState: vi.fn(async () => revState(3, A)),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run()
    // 上传的是新时间戳文件（非覆盖固定对象名；读侧命中 20260303 份不影响写侧另起新名）
    const uploaded = [...b.store.keys()].filter((k) => k !== 'dir/vault-20260101-000000.totpbackup' && k !== 'dir/vault-20260202-000000.totpbackup' && k !== 'dir/vault-20260303-000000.totpbackup')
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]).toMatch(/^dir\/vault-\d{8}-\d{6}\.totpbackup$/)
    // keep=2：4 份（3 旧+新上传）删最旧 2 份，留最新旧份与新上传
    expect(b.store.has('dir/vault-20260101-000000.totpbackup')).toBe(false)
    expect(b.store.has('dir/vault-20260202-000000.totpbackup')).toBe(false)
    expect(b.store.has('dir/vault-20260303-000000.totpbackup')).toBe(true)
    expect(onRetentionDeleted).toHaveBeenCalledTimes(1)
    expect(onRetentionDeleted).toHaveBeenCalledWith('s-keep', 2)
  })

  it('⑫bkeep 源 outcome=null（失败）不触发滚动删除；-1（后端无 listBackups）也回调交宿主降级', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络错误')
    }
    const nosup = fakeBackend() // 不挂 listBackups → enforceRemoteRetention 返回 -1
    const { deps, onRetentionDeleted } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-fail', { kind: 'gist', retention: { type: 'keep', n: 2 } }), cred: { ...GIST_CRED } },
        { source: source('s-nosup', { retention: { type: 'keep', n: 2 }, role: 'replica' }), cred: WEBDAV_CRED },
      ]),
      makeBackend: (cred) => (cred.backend === 'gist' ? bad : nosup),
    })
    await createCloudSyncRunner(deps).run()
    // 失败源不清理
    expect(onRetentionDeleted).toHaveBeenCalledTimes(1)
    expect(onRetentionDeleted).toHaveBeenCalledWith('s-nosup', -1)
  })

  it('⑬kdfProfile 透传：deps 提供时上传信封按该档位生成（缺省 balanced）', async () => {
    const b = fakeBackend()
    const { deps } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b,
      kdfProfile: () => 'fast',
    })
    await createCloudSyncRunner(deps).run()
    const uploaded = [...b.store.entries()].find(([k]) => k === PATH)
    expect(uploaded).toBeDefined()
    const env = JSON.parse(new TextDecoder().decode(uploaded![1])) as { kdf: { profile: string } }
    expect(env.kdf.profile).toBe('fast')
    // 缺省 kdfProfile → balanced
    const b2 = fakeBackend()
    const { deps: deps2 } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b2,
    })
    await createCloudSyncRunner(deps2).run()
    const env2 = JSON.parse(new TextDecoder().decode(b2.store.get(PATH)!)) as { kdf: { profile: string } }
    expect(env2.kdf.profile).toBe('balanced')
  })

  it('⑮keep 源 listBackups 抛错：逐源隔离——该源仍记 uploaded 且基线已回写，其余源与 summary 不受影响', async () => {
    const bad = fakeBackend()
    bad.listBackups = async () => {
      throw new Error('PROPFIND 网络失败')
    }
    const good = fakeBackend()
    const { deps, saveSyncState, onRetentionDeleted, recordStatus, onError } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-keep', { retention: { type: 'keep', n: 2 } }), cred: WEBDAV_CRED },
        { source: source('s2', { kind: 'gist', role: 'replica' }), cred: GIST_CRED },
      ]),
      makeBackend: (cred) => (cred.backend === 'gist' ? good : bad),
    })
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    // 上传成功的既成结果不改写：summary 仍 ok=true、两源基线均已回写（滚动删除在基线回写后，异常不上溢）
    expect(recordStatus).toHaveBeenCalledWith(true, 's-keep: 已上传; s2: 已上传')
    expect(saveSyncState).toHaveBeenCalledWith('s-keep', expect.any(Object))
    expect(saveSyncState).toHaveBeenCalledWith('s2', expect.any(Object))
    expect(onRetentionDeleted).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('⑮bonRetentionDeleted 宿主回调抛错：同样逐源隔离，不影响其余源清理与 summary', async () => {
    const b = fakeBackend()
    b.listBackups = async () => ['vault-1.totpbackup'] // keep=5 未超额 → deleted=0 → 回调抛错路径
    const good = fakeBackend()
    const { deps, recordStatus, onError } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s1', { retention: { type: 'keep', n: 5 } }), cred: WEBDAV_CRED },
        { source: source('s2', { kind: 'gist', retention: { type: 'keep', n: 5 }, role: 'replica' }), cred: GIST_CRED },
      ]),
      makeBackend: (cred) => (cred.backend === 'gist' ? good : b),
      onRetentionDeleted: vi.fn((_id: string, deleted: number) => {
        if (deleted >= 0) throw new Error('宿主记录失败') // s1（deleted=0）抛；s2（-1 不支持）不抛
      }),
    })
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    // s1 回调抛错被隔离；s2（无 listBackups → -1）回调仍执行，summary 不受影响
    expect(recordStatus).toHaveBeenCalledWith(true, 's1: 已上传; s2: 已上传')
    expect(onError).not.toHaveBeenCalled()
  })

  it('⑭未提供 onRetentionDeleted 时 keep 源滚动删除静默执行不报错', async () => {
    const b = fakeBackend()
    b.listBackups = async () => ['vault-1.totpbackup']
    const { deps, onRetentionDeleted } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1', { retention: { type: 'keep', n: 5 } }), cred: WEBDAV_CRED }]),
      makeBackend: () => b,
    })
    delete (deps as Partial<CloudRunnerDeps>).onRetentionDeleted
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    expect(onRetentionDeleted).not.toHaveBeenCalled()
  })

  it('⑮csourceName 提供时 summary 与 onRetentionDeleted 用显示名（新建源 uuid 不上屏）；缺省回退源 id（见⑦⑮）', async () => {
    const b = fakeBackend()
    b.listBackups = async () => ['vault-1.totpbackup'] // keep=2 超额删 0 份 → deleted=0 仍回调
    const { deps, recordStatus, onRetentionDeleted } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('src-uuid-1', { name: '家里 WebDAV', retention: { type: 'keep', n: 2 } }), cred: WEBDAV_CRED },
      ]),
      makeBackend: () => b,
      sourceName: (id) => ({ 'src-uuid-1': '家里 WebDAV' })[id] ?? id,
    })
    await createCloudSyncRunner(deps).run()
    expect(recordStatus).toHaveBeenCalledWith(true, '家里 WebDAV: 已上传')
    expect(onRetentionDeleted).toHaveBeenCalledWith('家里 WebDAV', 0)
  })

  it('⑮dsourceName 返回 undefined 时仍回退源 id（?? 回退分支）', async () => {
    const { deps, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      sourceName: () => undefined as unknown as string, // 强制走 ?? 回退分支
    })
    await createCloudSyncRunner(deps).run()
    expect(recordStatus).toHaveBeenCalledWith(true, 's1: 已上传')
  })

  it('⑯审查 I9 冲突副本落盘拒绝 → 该目标失败：不采纳远端、基线不推进、云端旧版本不被覆盖', async () => {
    // 双方都动 → merged 分支：副本回调 reject 在上传前抛出，本次同步失败（安全序）
    const ac = JSON.stringify({ version: 2, entries: [{ uuid: 'a', label: 'A' }, { uuid: 'c', label: 'C' }], tags: [], updatedAt: 5 })
    const b = fakeBackend(await sealedRemote(5, ac))
    const st = revState(1, A)
    const { deps, persistAdopted, saveSyncState, recordStatus, onError } = makeDeps({
      getVaultJson: () => AB,
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => st),
      makeBackend: () => b,
      // 宿主返回 rejected promise（Promise 原样经 runner 交回 core await 链，不再 fire-and-forget 吞错）
      saveConflictBackup: vi.fn(() => Promise.reject(new Error('磁盘写入失败'))),
    })
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    expect(persistAdopted).not.toHaveBeenCalled() // 本地不被合并结果覆盖（无副本保护时同步失败）
    expect(saveSyncState).toHaveBeenCalledWith('s1', st) // 该目标失败 → state 原样，下轮重做
    expect(b.putCount).toBe(0) // 副本先行：不上传合并结果，云端旧版本原样保留
    expect(recordStatus).toHaveBeenCalledWith(true, 's1: 失败') // 目标级失败标注（既有部分失败 summary 语义）
    expect(onError).not.toHaveBeenCalled() // 单目标失败由 core 编排隔离，不上溢
  })

  it('⑯b基线回写逐源隔离（审查 Important 1）：单源 saveSyncState 拒绝（如在途锁定 seal 抛错）→ 跳过该源不中断其余源，门基线置 null 防吸收', async () => {
    const good = fakeBackend()
    const { deps, saveSyncState, recordStatus, onError, saveContentHash } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-skip', { kind: 'gist' }), cred: GIST_CRED },
        { source: source('s-good', { role: 'replica' }), cred: WEBDAV_CRED },
      ]),
      saveSyncState: vi.fn(async (id: string) => {
        if (id === 's-skip') throw new Error('vault locked') // 宿主 seal 在途锁定形态
        return undefined
      }),
      makeBackend: (cred) => (cred.backend === 'gist' ? fakeBackend() : good),
    })
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    expect(saveSyncState).toHaveBeenCalledWith('s-good', expect.any(Object)) // 其余源照常回写
    expect(onError).not.toHaveBeenCalled() // 不上溢为整轮失败
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's-skip: 已上传; s-good: 已上传')
    expect(saveContentHash).toHaveBeenLastCalledWith(null) // 门基线置 null：跳过不被门吸收，下轮重做
  })

  it('T4 任一目标错误消息含 401/403 → onAuthFailure 收到该消息（凭据失效分类供调度暂停）', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('WebDAV 请求失败（HTTP 401）')
    }
    const good = fakeBackend()
    const onAuthFailure = vi.fn()
    const { deps, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-bad', { kind: 'gist' }), cred: GIST_CRED },
        { source: source('s-good', { role: 'replica' }), cred: WEBDAV_CRED },
      ]),
      makeBackend: (cred) => (cred.backend === 'gist' ? bad : good),
      onAuthFailure,
    })
    await createCloudSyncRunner(deps).run()
    expect(onAuthFailure).toHaveBeenCalledOnce()
    expect(onAuthFailure).toHaveBeenCalledWith('WebDAV 请求失败（HTTP 401）')
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's-bad: 失败; s-good: 已上传') // 既有 summary 语义不变
  })

  it('T4 非认证错误不触发 onAuthFailure；未提供 onAuthFailure 时 401 也静默（可选依赖）', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络超时')
    }
    const { deps, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s-bad', { kind: 'gist' }), cred: GIST_CRED }]),
      makeBackend: () => bad,
      onAuthFailure: vi.fn(),
    })
    await createCloudSyncRunner(deps).run()
    expect(deps.onAuthFailure).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's-bad: 失败')
    // 未提供 onAuthFailure：401 不抛错，run 照常 resolve（desktop 宿主零影响）
    const bad401 = fakeBackend()
    bad401.get = async () => {
      throw new Error('WebDAV 请求失败（HTTP 401）')
    }
    const { deps: deps2 } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s-bad', { kind: 'gist' }), cred: GIST_CRED }]),
      makeBackend: () => bad401,
    })
    await expect(createCloudSyncRunner(deps2).run()).resolves.toBeUndefined()
  })
})

describe('auto 内容门持久化（spec §1.3；门命中=降级 pull-only 检查而非全静默）', () => {
  /** 有状态 rev 基线（真实往返）：完整轮 core 推导的 state 落 map，pull 轮可读 */
  const statefulStates = () => {
    const states = new Map<string, SourceSyncState>()
    return {
      loadSyncState: vi.fn(async (id: string): Promise<SourceSyncState> =>
        states.get(id) ?? { lastKnownRemoteRev: null, baseSnapshot: null }),
      saveSyncState: vi.fn(async (id: string, st: SourceSyncState): Promise<void> => { states.set(id, st) }),
    }
  }

  it('门①内容无变化：首轮同步成功落持久基线；自动重跑门命中 → 降级 pull-only 检查（真实 GET、零 PUT、记 in-sync）', async () => {
    const st = statefulStates()
    const b = fakeBackend()
    const { deps, loadSources, recordStatus, saveContentHash } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b,
      loadSyncState: st.loadSyncState,
      saveSyncState: st.saveSyncState,
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run()
    expect(saveContentHash).toHaveBeenLastCalledWith(await contentHashVault(A)) // 基线=final 内容规范化 hash（剔除顶层 rev 口径）
    expect(loadSources).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已上传')
    let getCount = 0
    const origGet = b.get.bind(b)
    b.get = async (p) => {
      getCount++
      return origGet(p)
    }
    await runner.run() // 内容仍为 A → 门命中，但不再全静默：降级 pull-only 轮（desktop auto 下载可达性）
    expect(loadSources).toHaveBeenCalledTimes(2) // pull 轮照常进编排
    expect(getCount).toBeGreaterThanOrEqual(1) // 发起 GET 比对（远端可及）
    expect(b.putCount).toBe(1) // pull-only 零写云（仅首轮的上传）
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已是最新') // in-sync 零处理，不再误记「内容未变」跳过态
  })

  it('门②持久化跨实例：新 runner 实例（模拟页面重开）门命中 → 降级 pull-only（零写云、远端可及）', async () => {
    // saveContentHash / rev 基线 / 云对象均落外部 map；第二个实例仅共享这些 map（deps 全新）
    const shared = statefulContentHash()
    const st = statefulStates()
    const b = fakeBackend()
    const mk = () => makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b,
      loadContentHash: shared.loadContentHash,
      saveContentHash: shared.saveContentHash,
      loadSyncState: st.loadSyncState,
      saveSyncState: st.saveSyncState,
    })
    const d1 = mk()
    await createCloudSyncRunner(d1.deps).run()
    expect(b.putCount).toBe(1) // 首轮真实上传
    const d2 = mk() // 模拟页面重开：全新 runner + 全新 deps
    await createCloudSyncRunner(d2.deps).run()
    expect(d2.loadSources).toHaveBeenCalledTimes(1) // 降级 pull-only 轮真实执行（非全静默短路）
    expect(b.putCount).toBe(1) // 零写云
    expect(d2.recordStatus).toHaveBeenCalledWith(true, 's1: 已是最新')
  })

  it('门③门未命中 → 完整推拉轮行为不变（逐轮真实上传）；门命中后零写', async () => {
    let json = A
    const st = statefulStates()
    const b = fakeBackend()
    const { deps, loadSources, recordStatus } = makeDeps({
      getVaultJson: () => json,
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b,
      loadSyncState: st.loadSyncState,
      saveSyncState: st.saveSyncState,
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run()
    json = B
    await runner.run()
    expect(loadSources).toHaveBeenCalledTimes(2)
    expect(b.putCount).toBe(2) // 门未命中：两轮均完整推拉（uploaded），行为不变
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已上传')
    await runner.run() // 基线已随成功刷到 B → 门命中 → 降级 pull-only 零写
    expect(loadSources).toHaveBeenCalledTimes(3)
    expect(b.putCount).toBe(2)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已是最新')
  })

  it('门⑧门命中+远端有更新 → 下载采纳可达（downloaded 不被门吸收）；pull 轮不推门，下轮门未命中收敛并刷基线', async () => {
    let json = A
    const st = statefulStates()
    const b = fakeBackend()
    const { deps, loadSources, persistAdopted, recordStatus, saveContentHash } = makeDeps({
      getVaultJson: () => json,
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b,
      loadSyncState: st.loadSyncState,
      saveSyncState: st.saveSyncState,
      // store persistAdopted 语义模拟：采纳内容落为本机 vault（getVaultJson 随之变化）
      persistAdopted: vi.fn(async (adopted: string) => { json = adopted }),
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run() // 首推 A，落门基线=hashVault(A)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已上传')
    // 对端（他设备）推进云端：rev2 内容 B；本端明文仍 A → 门命中
    b.store.set(PATH, await sealedRemote(2, B))
    await runner.run() // 门命中 → 降级 pull-only → downloaded
    expect(persistAdopted).toHaveBeenCalledWith(B) // 下载可达：对端变更不因门静默丢失
    expect(b.putCount).toBe(1) // pull-only 零写云
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已下载')
    // 门基线不被 pull 轮推（pull 轮失败不推门语义一致）：采纳后内容=B ≠ 基线(A) → 下轮门未命中走完整轮收敛
    await runner.run()
    expect(b.putCount).toBe(1) // 完整轮 in-sync 零写（rev/内容双一致）
    expect(saveContentHash).toHaveBeenLastCalledWith(await contentHashVault(B)) // 完整轮刷新门基线
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已是最新')
  })

  it('门④手动模式不设门：内容无变化 run("manual") 照常同步（成功后基线随之刷新）', async () => {
    const { deps, loadSources, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run() // 先落基线
    await runner.run('manual')
    // manual = preview（只读）+ apply（真实上传）：loadSources 两轮各进一次
    expect(loadSources).toHaveBeenCalledTimes(3)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已上传')
  })

  it('门⑤失败不更新基线：首轮失败后同内容下轮仍重试（不跳过）', async () => {
    let fail = true
    const { deps, loadSources, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => {
        if (fail) throw new Error('凭据读取失败')
        return [{ source: source('s1'), cred: WEBDAV_CRED }]
      }),
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run()
    expect(recordStatus).toHaveBeenLastCalledWith(false, '凭据读取失败')
    fail = false
    await runner.run() // 内容未变但基线未建立 → 照常同步
    expect(loadSources).toHaveBeenCalledTimes(2)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已上传')
  })

  it('门⑥部分失败不被门吸收：双目标一败一成 → saveContentHash(null)，下轮同内容全量重试', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络错误')
    }
    const good = fakeBackend()
    const created: CloudBackend[] = [] // over 覆盖 makeBackend 后 makeDeps 的 backends 不再填充，自建计数
    const { deps, loadSources, recordStatus, saveSyncState } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-bad', { kind: 'gist' }), cred: GIST_CRED },
        { source: source('s-good', { role: 'replica' }), cred: WEBDAV_CRED },
      ]),
      makeBackend: (cred) => {
        const b = cred.backend === 'gist' ? bad : good
        created.push(b)
        return b
      },
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run()
    // core 编排不抛错：整体仍记成功 summary（失败源记「失败」），失败源基线原样不推进
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's-bad: 失败; s-good: 已上传')
    expect(saveSyncState).toHaveBeenCalledWith('s-bad', { lastKnownRemoteRev: null, baseSnapshot: null })
    expect(deps.saveContentHash).toHaveBeenLastCalledWith(null) // 门基线置 null（部分失败）
    // → 下轮同内容不被门短路，重建 backend 全流程重试
    await runner.run()
    expect(loadSources).toHaveBeenCalledTimes(2)
    expect(created).toHaveLength(4) // 每轮两源各建一个
    // 第二轮 good 源远端已有首轮信封，动作随远端形态可能变化（uploaded/downloaded 等），不精确断言；
    // 只断言仍按编排结果记 ok=true 而非被门跳过（ok=null）
    expect(vi.mocked(recordStatus).mock.calls.at(-1)![0]).toBe(true)
  })
})

describe('manual 预览确认（spec §4）', () => {
  /** 双方都动场景：云端 AC（base 声明=A）、本地 AB → merged */
  const mergedFixture = async (over: Partial<CloudRunnerDeps> = {}) => {
    const ac = JSON.stringify({ version: 2, entries: [{ uuid: 'a', label: 'A' }, { uuid: 'c', label: 'C' }], tags: [], updatedAt: 5 })
    const b = fakeBackend(await sealedRemote(5, ac, await contentHash(A)))
    const d = makeDeps({
      getVaultJson: () => AB,
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => revState(1, A)),
      makeBackend: () => b,
      ...over,
    })
    return { d, b }
  }

  it('manual：merge 预览 → onManualConfirm=false → 不写云不采纳，记跳过态', async () => {
    const onManualConfirm = vi.fn(async (_preview: ManualMergePreview) => false)
    const { d, b } = await mergedFixture({ onManualConfirm })
    await createCloudSyncRunner(d.deps).run('manual')
    expect(onManualConfirm).toHaveBeenCalledTimes(1)
    expect(onManualConfirm.mock.calls[0]![0]).toMatchObject({ mergeDegraded: false, sourceName: 's1' }) // 预览摘要
    expect(b.putCount).toBe(0) // preview 只读 + 中止不重跑 apply
    expect(d.persistAdopted).not.toHaveBeenCalled()
    expect(d.saveConflictBackup).not.toHaveBeenCalled()
    expect(d.saveSyncState).not.toHaveBeenCalled()
    expect(d.recordStatus).toHaveBeenLastCalledWith(null, '手动合并已跳过')
  })

  it('manual：确认 true → apply 重跑完成（合并结果上传+采纳），无 merged 目标时不征询直接 apply', async () => {
    const onManualConfirm = vi.fn(async (_preview: ManualMergePreview) => true)
    const { d, b } = await mergedFixture({ onManualConfirm })
    await createCloudSyncRunner(d.deps).run('manual')
    expect(b.putCount).toBe(1) // 仅 apply 轮上传（preview 零写）
    expect(d.persistAdopted).toHaveBeenCalledTimes(1)
    const adopted = JSON.parse(vi.mocked(d.persistAdopted).mock.calls[0]![0]) as { entries: Array<{ uuid: string }> }
    expect(adopted.entries.map((e) => e.uuid).sort()).toEqual(['a', 'b2', 'c']) // 三方合并：三方条目俱在
    expect(d.recordStatus).toHaveBeenLastCalledWith(true, 's1: 已合并')
    // 无 merged：云端无对象（preview=uploaded）→ 不征询、apply 照常首推
    const b2 = fakeBackend()
    const d2 = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b2,
      onManualConfirm,
    })
    await createCloudSyncRunner(d2.deps).run('manual')
    expect(onManualConfirm).toHaveBeenCalledTimes(1) // 计数不变：第二次未征询
    expect(b2.putCount).toBe(1)
  })

  it('manual：未提供 onManualConfirm（缺省=直接执行）→ preview 后照常 apply', async () => {
    const { d, b } = await mergedFixture()
    delete (d.deps as Partial<CloudRunnerDeps>).onManualConfirm
    await createCloudSyncRunner(d.deps).run('manual')
    expect(b.putCount).toBe(1)
    expect(d.persistAdopted).toHaveBeenCalledTimes(1)
  })
})

describe('逐源进度（spec §6 ⑥）', () => {
  it('进度回调：onProgress 逐源推进 (1/2) (2/2)；单源轮 (1/1)', async () => {
    const { deps, onProgress } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s1'), cred: WEBDAV_CRED },
        { source: source('s2', { role: 'replica' }), cred: GIST_CRED },
      ]),
    })
    await createCloudSyncRunner(deps).run()
    expect(onProgress).toHaveBeenCalledWith(1, 2) // 第二目标开始处理（串行编排 ⇒ 首目标已完成）
    expect(onProgress).toHaveBeenCalledWith(2, 2) // 轮末
    const { deps: deps1, onProgress: p1 } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
    })
    await createCloudSyncRunner(deps1).run()
    expect(p1).toHaveBeenCalledWith(1, 1)
  })
})

describe('跟随拉取 pull-only 通道（syncWithCloudRev 只读形态）', () => {
  it('核心验收：云端较新且本地也变 → 合并结果被采纳（persistAdopted），但云端零写（pull-only）', async () => {
    const ac = JSON.stringify({ version: 2, entries: [{ uuid: 'a', label: 'A' }, { uuid: 'c', label: 'C' }], tags: [], updatedAt: 5 })
    const b = fakeBackend(await sealedRemote(5, ac, await contentHash(A)))
    const { deps, persistAdopted, saveSyncState, saveConflictBackup, recordStatus } = makeDeps({
      getVaultJson: () => AB, // 本地相对基线 A 也动过
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => revState(1, A)),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run('pull')
    expect(b.putCount).toBe(0) // 零写云
    expect(saveConflictBackup).not.toHaveBeenCalled() // 只读形态不存副本（合并已含双方变更）
    expect(persistAdopted).toHaveBeenCalledTimes(1)
    const adopted = JSON.parse(vi.mocked(persistAdopted).mock.calls[0]![0]) as { entries: Array<{ uuid: string }> }
    expect(adopted.entries.map((e) => e.uuid).sort()).toEqual(['a', 'b2', 'c'])
    // state：known=5；base=null——合并结果只在本地未上传，下轮推送通道按「云端未动、本地已改」纯上传收敛
    expect(saveSyncState).toHaveBeenCalledWith('s1', { lastKnownRemoteRev: 5, baseSnapshot: null })
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已合并')
  })

  it('pull downloaded：采纳远端 + base=采纳内容（与 core apply 同语义）；下轮 pull in-sync 零处理（稳定态不重复采纳）', async () => {
    const b = fakeBackend(await sealedRemote(3, B))
    const states = new Map<string, SourceSyncState>([['s1', revState(1, A)]]) // 真实往返：save 后 load 可见
    const { deps, persistAdopted, saveSyncState, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async (id: string) => states.get(id) ?? { lastKnownRemoteRev: null, baseSnapshot: null }),
      saveSyncState: vi.fn(async (id: string, st: SourceSyncState) => { states.set(id, st) }),
      makeBackend: () => b,
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run('pull')
    expect(persistAdopted).toHaveBeenCalledWith(B)
    expect(saveSyncState).toHaveBeenCalledWith('s1', { lastKnownRemoteRev: 3, baseSnapshot: B })
    expect(b.putCount).toBe(0)
    await runner.run('pull') // rev/内容双一致 → in-sync，不重复 persistAdopted
    expect(persistAdopted).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已是最新')
  })

  it('pull 本地领先（云端未动）→ 零处理不推送（收敛归推送通道）；云端无对象 → 不做首推', async () => {
    const b = fakeBackend(await sealedRemote(2, A)) // 远端=A 与基线一致 → 云端未动
    const { deps, persistAdopted, saveSyncState, recordStatus } = makeDeps({
      getVaultJson: () => AB, // 本地领先
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => revState(2, A)),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run('pull')
    expect(b.putCount).toBe(0)
    expect(persistAdopted).not.toHaveBeenCalled()
    expect(saveSyncState).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已是最新')
    // 云端无对象：pull-only 不首推
    const b2 = fakeBackend()
    const { deps: deps2, recordStatus: r2 } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b2,
    })
    await createCloudSyncRunner(deps2).run('pull')
    expect(b2.putCount).toBe(0)
    expect(r2).toHaveBeenLastCalledWith(true, 's1: 已是最新')
  })

  it('解密失败（口令不匹配）→ 本源记失败不动 state；恢复后下轮重拉采纳', async () => {
    // state{known:1, base:A}：远端 B(rev3) 可解时走 downloaded；口令不对时解密失败仅记失败
    const states = new Map<string, SourceSyncState>([['s1', revState(1, A)]])
    const remote = bytesOf(JSON.stringify(await createSyncEnvelope(B, '另一个口令', 'balanced',
      { rev: 3, deviceId: 'dev-other', baseRev: 2, baseContentHash: await contentHash(B) })))
    const b = fakeBackend(remote)
    const { deps, saveSyncState, persistAdopted, recordStatus } = makeDeps({
      getVaultJson: () => A,
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async (id: string) => states.get(id) ?? { lastKnownRemoteRev: null, baseSnapshot: null }),
      saveSyncState: vi.fn(async (id: string, st: SourceSyncState) => { states.set(id, st) }),
      makeBackend: () => b,
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run('pull')
    expect(saveSyncState).not.toHaveBeenCalled() // state 不动 → 下轮重试
    expect(persistAdopted).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 失败')
    // 口令问题修复（云端换成正确口令信封，内容/时钟不变）
    b.store.set(PATH, await sealedRemote(3, B))
    await runner.run('pull')
    expect(persistAdopted).toHaveBeenCalledWith(B)
    expect(saveSyncState).toHaveBeenCalledWith('s1', { lastKnownRemoteRev: 3, baseSnapshot: B })
  })

  it('凭据失效：get 抛 CloudHttpError(401) → onAuthFailure 收 (消息原文, 401) 结构化透传（宿主转 reject 停轮询）', async () => {
    const b = fakeBackend(bytesOf('remote-bytes')) // 预置字节：exists 为真才走到 get
    b.get = async () => {
      throw new CloudHttpError('WebDAV', 401)
    }
    const onAuthFailure = vi.fn()
    const { deps, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b,
      onAuthFailure,
    })
    await createCloudSyncRunner(deps).run('pull')
    expect(onAuthFailure).toHaveBeenCalledOnce()
    expect(onAuthFailure).toHaveBeenCalledWith('WebDAV 请求失败（HTTP 401）', 401)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 失败')
  })

  it('keep 源：listBackups 取时间戳最新份拉取；pull-only 零新增时间戳文件', async () => {
    const b = fakeBackend()
    b.store.set('dir/vault-20260101-000000.totpbackup', bytesOf(JSON.stringify(await createSyncEnvelope(A, PW, 'balanced', { rev: 1, deviceId: 'o', baseRev: 0, baseContentHash: await contentHash(A) }))))
    b.store.set('dir/vault-20260202-000000.totpbackup', bytesOf(JSON.stringify(await createSyncEnvelope(B, PW, 'balanced', { rev: 2, deviceId: 'o', baseRev: 1, baseContentHash: await contentHash(A) }))))
    b.listBackups = async () => [...b.store.keys()]
    const { deps, persistAdopted } = makeDeps({
      getVaultJson: () => A,
      loadSources: vi.fn(async () => [
        { source: source('s-keep', { retention: { type: 'keep', n: 2 } }), cred: { ...WEBDAV_CRED, objectPath: 'dir/totp-backup.totpbackup' } },
      ]),
      loadSyncState: vi.fn(async () => revState(1, A)), // 本地未动（=基线）→ 最新份走 downloaded
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run('pull')
    expect(persistAdopted).toHaveBeenCalledWith(B) // 字典序最新份（=时间序）胜出
    expect(b.store.size).toBe(2) // 零上传：不新增时间戳文件
  })

  it('pull 不设内容门：同内容多次 run("pull") 每次都真实下载比对（每 tick 零处理由预览判定承担）', async () => {
    const b = fakeBackend(await sealedRemote(1, A))
    let getCount = 0
    const origGet = b.get.bind(b)
    b.get = async (p) => {
      getCount++
      return origGet(p)
    }
    const { deps } = makeDeps({
      getVaultJson: () => A,
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadSyncState: vi.fn(async () => revState(1, A)),
      makeBackend: () => b,
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run('pull')
    await runner.run('pull')
    await runner.run('pull')
    expect(getCount).toBe(3) // 每 tick 都下载（exists→get），零处理由内容判定承担，非跳过网络
    expect(b.putCount).toBe(0)
  })

  it('pull 空/锁定/无 secret 跳过态与推拉通道同口径', async () => {
    const { deps, recordStatus } = makeDeps({ isLocked: () => true })
    await createCloudSyncRunner(deps).run('pull')
    expect(recordStatus).toHaveBeenCalledWith(null, '库已锁定')
    const { deps: deps2, recordStatus: record2 } = makeDeps({ getSecret: () => null })
    await createCloudSyncRunner(deps2).run('pull')
    expect(record2).toHaveBeenCalledWith(null, '未设置备份口令')
    const { deps: deps3, recordStatus: record3 } = makeDeps()
    await createCloudSyncRunner(deps3).run('pull')
    expect(record3).toHaveBeenCalledWith(null, '未启用云源')
  })
})
