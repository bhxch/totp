/** plan16 T8 源化改写：CloudRunnerDeps.loadCreds → loadSources（{source, cred} 对）；
 *  原用例语义平移（key=source.id），新增 keep 源时间戳路径/滚动删除/profile 透传/双同类型源用例 */
import { describe, expect, it, vi } from 'vitest'
import { createBackupEnvelope, sha256Hex, type BackupSource, type CloudBackend, type CloudCred } from '@totp/core'
import { createCloudSyncRunner, type CloudRunnerDeps } from '../src/components/cloudRunner'
import { createTestI18n } from './helpers/i18n'

const PW = 'pw'
const PATH = 'totp-backup.totpbackup'
const A = JSON.stringify({ version: 1, entries: [{ label: 'A' }], groups: [], updatedAt: 1 })
const B = JSON.stringify({ version: 1, entries: [{ label: 'B' }], groups: [], updatedAt: 2 })
const bytesOf = (s: string) => new TextEncoder().encode(s)

const WEBDAV_CRED: CloudCred = { backend: 'webdav', serverUrl: 'https://dav', username: 'u', password: 'p' }
const GIST_CRED: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }

const source = (id: string, over: Partial<BackupSource> = {}): BackupSource => ({
  id, kind: 'webdav', name: id, retention: { type: 'overwrite' }, enabled: true, ...over,
})

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

/** 预置远端 envelope：vaultJson 加密后的 JSON 字节（信封用真实 createBackupEnvelope，与 core 测试同口径） */
async function envelopeBytesOf(vaultJson: string, password: string): Promise<Uint8Array> {
  return bytesOf(JSON.stringify(await createBackupEnvelope(vaultJson, password)))
}

/** t 注入 zh 资源查找（D2 抽串）：runner 摘要断言维持 zh 字面量与资源逐字一致 */
const testT = createTestI18n().global.t

/** 基线 deps：解锁、有 secret、默认无源（可逐项覆写）；makeBackend 默认每次新建 fake backend。
 *  返回的 mock 引用在 over 覆盖后取 deps 上的最终值（断言永远指向实际注入的实现） */
function makeDeps(over: Partial<CloudRunnerDeps> = {}) {
  const loadSourcesDef = vi.fn(async (): Promise<Array<{ source: BackupSource; cred: CloudCred }>> => [])
  const loadTargetHashDef = vi.fn(async (): Promise<string | null> => null)
  const saveTargetHashDef = vi.fn(async () => undefined)
  const persistAdoptedDef = vi.fn(async () => undefined)
  const saveConflictBackupDef = vi.fn()
  const onRetentionDeletedDef = vi.fn()
  const recordStatusDef = vi.fn()
  const onErrorDef = vi.fn()
  const backends: Array<CloudBackend & { store: Map<string, Uint8Array>; putCount: number }> = []
  const deps: CloudRunnerDeps = {
    isLocked: () => false,
    getSecret: () => PW,
    getVaultJson: () => A,
    loadSources: loadSourcesDef,
    loadTargetHash: loadTargetHashDef,
    saveTargetHash: saveTargetHashDef,
    makeBackend: () => {
      const b = fakeBackend()
      backends.push(b)
      return b
    },
    persistAdopted: persistAdoptedDef,
    saveConflictBackup: saveConflictBackupDef,
    onRetentionDeleted: onRetentionDeletedDef,
    recordStatus: recordStatusDef,
    t: (key: string, params: Record<string, unknown> = {}) => testT(key, params),
    onError: onErrorDef,
    ...over,
  }
  return {
    deps,
    loadSources: deps.loadSources as typeof loadSourcesDef,
    loadTargetHash: deps.loadTargetHash as typeof loadTargetHashDef,
    saveTargetHash: deps.saveTargetHash as typeof saveTargetHashDef,
    persistAdopted: deps.persistAdopted as typeof persistAdoptedDef,
    saveConflictBackup: deps.saveConflictBackup as typeof saveConflictBackupDef,
    onRetentionDeleted: deps.onRetentionDeleted as typeof onRetentionDeletedDef,
    recordStatus: deps.recordStatus as typeof recordStatusDef,
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

  it('③空源 → 记 null 跳过态（未启用云源），不建 backend、不回写 hash', async () => {
    const { deps, backends, saveTargetHash, recordStatus } = makeDeps()
    await createCloudSyncRunner(deps).run()
    expect(backends).toHaveLength(0)
    expect(saveTargetHash).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenCalledWith(null, '未启用云源')
  })

  it('④仅 enabled 源进入编排：disabled 不建 backend，enabled 正常回写 hash（key=source.id）', async () => {
    const { deps, backends, saveTargetHash } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-webdav'), cred: WEBDAV_CRED },
        { source: source('s-gist', { kind: 'gist' }), cred: GIST_CRED, },
      ].filter((p) => p.source.enabled)),
    })
    // 一个 enabled 一个 disabled 的组合单独跑
    const { deps: deps2, backends: backends2, saveTargetHash: save2 } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-on'), cred: WEBDAV_CRED },
        { source: source('s-off', { enabled: false }), cred: GIST_CRED },
      ]),
    })
    await createCloudSyncRunner(deps).run()
    void backends; void saveTargetHash
    await createCloudSyncRunner(deps2).run()
    expect(backends2).toHaveLength(1)
    expect(save2).toHaveBeenCalledTimes(1)
    expect(save2).toHaveBeenCalledWith('s-on', expect.any(String))
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

  it('⑥hash 透传与成功回写：localHash 匹配 → in-sync（不重推），saveTargetHash 收到原 hash（key=source.id）', async () => {
    const aHash = await sha256Hex(bytesOf(A))
    const b = fakeBackend(bytesOf(A))
    const { deps, loadTargetHash, saveTargetHash } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadTargetHash: vi.fn(async (id: string) => (id === 's1' ? aHash : null)),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run()
    expect(loadTargetHash).toHaveBeenCalledWith('s1')
    expect(b.putCount).toBe(0) // hash 透传生效 → in-sync 不重推
    expect(saveTargetHash).toHaveBeenCalledWith('s1', aHash)
  })

  it('⑥b失败源回写 null：bad 源抛错 → saveTargetHash(id, null)，good 源正常', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络错误')
    }
    const good = fakeBackend()
    const { deps, saveTargetHash } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-bad', { kind: 'gist' }), cred: GIST_CRED },
        { source: source('s-good'), cred: WEBDAV_CRED },
      ]),
      makeBackend: (cred) => (cred.backend === 'gist' ? bad : good),
    })
    await createCloudSyncRunner(deps).run()
    expect(saveTargetHash).toHaveBeenCalledWith('s-bad', null)
    expect(saveTargetHash).toHaveBeenCalledWith('s-good', expect.any(String))
    expect(deps.onError).not.toHaveBeenCalled() // 单源失败不视为整体失败
  })

  it('⑦adopted → persistAdopted(finalVaultJson)，状态记 ok=true（summary key=源 id）', async () => {
    const b = fakeBackend(await envelopeBytesOf(B, PW))
    const { deps, persistAdopted, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
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
    const b = fakeBackend(await envelopeBytesOf(B, PW))
    const { deps, saveTargetHash, onError, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b,
      persistAdopted: vi.fn(async () => {
        throw new Error('落盘失败')
      }),
    })
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    expect(saveTargetHash).not.toHaveBeenCalled() // 先采纳后回写：落盘失败本轮 hashes 一并不落盘
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(recordStatus).toHaveBeenCalledWith(false, '落盘失败')
  })

  it('⑨busy 重入：run 在途时第二次 run 直接跳过', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const b = fakeBackend()
    const origGet = b.get.bind(b)
    b.get = async (p) => {
      await gate
      return origGet(p)
    }
    const { deps, loadSources, saveTargetHash } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      makeBackend: () => b,
    })
    const runner = createCloudSyncRunner(deps)
    const p1 = runner.run() // 同步执行到首个 await（loadSources 已调用，get 挂起在 gate）
    const p2 = runner.run() // busy → 直接 return
    await p2
    expect(loadSources).toHaveBeenCalledTimes(1)
    release()
    await p1
    expect(loadSources).toHaveBeenCalledTimes(1)
    expect(saveTargetHash).toHaveBeenCalledTimes(1)
  })

  it('⑩成功 summary：逐源 `id: 中文动作` 拼接；冲突副本回调带源 id 透传', async () => {
    const b = fakeBackend(await envelopeBytesOf(B, PW))
    const { deps, recordStatus, saveConflictBackup } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadTargetHash: vi.fn(async () => 'stale'),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run()
    expect(recordStatus).toHaveBeenCalledWith(true, 's1: 冲突已解决')
    // jsdom 环境 runner/测试分属不同 realm，expect.any(Uint8Array) 的 instanceof 判定失效 →
    // 改查内部 slot（ArrayBuffer.isView 跨 realm 可靠），字节视图契约不变
    expect(saveConflictBackup).toHaveBeenCalledTimes(1)
    const [conflictKey, conflictBytes] = saveConflictBackup.mock.calls[0]!
    expect(conflictKey).toBe('s1')
    expect(ArrayBuffer.isView(conflictBytes)).toBe(true)
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
    const { deps, saveTargetHash, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('home'), name: '家里 WebDAV', objectPath: 'home/totp-backup.totpbackup' , cred: { ...WEBDAV_CRED, objectPath: 'home/totp-backup.totpbackup' } },
        { source: source('office'), name: '公司 WebDAV', objectPath: 'office/totp-backup.totpbackup', cred: { ...WEBDAV_CRED, objectPath: 'office/totp-backup.totpbackup' } },
      ]),
      makeBackend: (cred) => ((cred as { objectPath?: string }).objectPath?.startsWith('home') ? b1 : b2),
    })
    await createCloudSyncRunner(deps).run()
    expect([...b1.store.keys()]).toEqual(['home/totp-backup.totpbackup'])
    expect([...b2.store.keys()]).toEqual(['office/totp-backup.totpbackup'])
    expect(saveTargetHash).toHaveBeenCalledWith('home', expect.any(String))
    expect(saveTargetHash).toHaveBeenCalledWith('office', expect.any(String))
    expect(recordStatus).toHaveBeenCalledWith(true, 'home: 已上传; office: 已上传')
  })

  it('⑫keep 源：path=对象目录下时间戳名，uploaded 后滚动删除超额旧份并回调 onRetentionDeleted', async () => {
    const b = fakeBackend()
    b.store.set('dir/vault-20260101-000000.totpbackup', bytesOf('old1'))
    b.store.set('dir/vault-20260202-000000.totpbackup', bytesOf('old2'))
    b.store.set('dir/vault-20260303-000000.totpbackup', bytesOf('old3'))
    b.listBackups = async () => [...b.store.keys()]
    const { deps, onRetentionDeleted } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-keep', { retention: { type: 'keep', n: 2 } }), cred: { ...WEBDAV_CRED, objectPath: 'dir/totp-backup.totpbackup' } },
      ]),
      makeBackend: () => b,
    })
    await createCloudSyncRunner(deps).run()
    // 上传的是新时间戳文件（非覆盖固定对象名）
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
        { source: source('s-nosup', { retention: { type: 'keep', n: 2 } }), cred: WEBDAV_CRED },
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
    const { deps, saveTargetHash, onRetentionDeleted, recordStatus, onError } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-keep', { retention: { type: 'keep', n: 2 } }), cred: WEBDAV_CRED },
        { source: source('s2', { kind: 'gist' }), cred: GIST_CRED },
      ]),
      makeBackend: (cred) => (cred.backend === 'gist' ? good : bad),
    })
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    // 上传成功的既成结果不改写：summary 仍 ok=true、两源基线均已回写（滚动删除在基线回写后，异常不上溢）
    expect(recordStatus).toHaveBeenCalledWith(true, 's-keep: 已上传; s2: 已上传')
    expect(saveTargetHash).toHaveBeenCalledWith('s-keep', expect.any(String))
    expect(saveTargetHash).toHaveBeenCalledWith('s2', expect.any(String))
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
        { source: source('s2', { kind: 'gist', retention: { type: 'keep', n: 5 } }), cred: GIST_CRED },
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

  it('⑯审查 I9 冲突副本落盘拒绝 → 该目标失败：不采纳远端、删基线下轮重试、云端旧版本不被回推覆盖', async () => {
    const b = fakeBackend(await envelopeBytesOf(B, PW)) // 远端=B ≠ 本地 A → conflict 分支
    const { deps, persistAdopted, saveTargetHash, recordStatus, onError } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
      loadTargetHash: vi.fn(async () => 'stale'),
      makeBackend: () => b,
      // 宿主返回 rejected promise（Promise 原样经 runner 交回 core await 链，不再 fire-and-forget 吞错）
      saveConflictBackup: vi.fn(() => Promise.reject(new Error('磁盘写入失败'))),
    })
    await expect(createCloudSyncRunner(deps).run()).resolves.toBeUndefined()
    expect(persistAdopted).not.toHaveBeenCalled() // 本地不被远端覆盖（无副本保护时不采纳）
    expect(saveTargetHash).toHaveBeenCalledWith('s1', null) // 该目标失败 → 删基线，下轮全量重比
    expect([...b.store.keys()]).toEqual([PATH]) // 单目标无采纳 → 无收敛回推，云端旧版本原样保留
    expect(recordStatus).toHaveBeenCalledWith(true, 's1: 失败') // 目标级失败标注（既有部分失败 summary 语义）
    expect(onError).not.toHaveBeenCalled() // 单目标失败由 core 编排隔离，不上溢
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
        { source: source('s-good'), cred: WEBDAV_CRED },
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

describe('自动通道明文内容 hash 门（审查 I1 最小闭环）', () => {
  it('门①内容无变化：首轮同步成功后，自动重跑跳过（recordStatus null）且不发起 loadSources、不建 backend（零网络请求）', async () => {
    const { deps, loadSources, recordStatus, backends } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run()
    expect(loadSources).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已上传')
    await runner.run() // 内容仍为 A → 门短路
    expect(loadSources).toHaveBeenCalledTimes(1) // 门在 loadSources 之前
    expect(backends).toHaveLength(1) // 未再建 backend
    expect(recordStatus).toHaveBeenLastCalledWith(null, '内容无变化') // 「跳过：」前缀由宿主 formatAutoStatusText 拼装，summary 不重复
  })

  it('门②内容变化 → 正常同步并刷新基线；同内容再跑又跳过', async () => {
    let json = A
    const { deps, loadSources, recordStatus, backends } = makeDeps({
      getVaultJson: () => json,
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run()
    json = B
    await runner.run()
    expect(loadSources).toHaveBeenCalledTimes(2)
    expect(backends).toHaveLength(2)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已上传')
    await runner.run() // 基线已随成功刷到 B
    expect(loadSources).toHaveBeenCalledTimes(2)
    expect(recordStatus).toHaveBeenLastCalledWith(null, '内容无变化')
  })

  it('门③手动模式不设门：内容无变化 run("manual") 照常同步（成功后基线随之刷新）', async () => {
    const { deps, loadSources, recordStatus } = makeDeps({
      loadSources: vi.fn(async () => [{ source: source('s1'), cred: WEBDAV_CRED }]),
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run()
    await runner.run('manual')
    expect(loadSources).toHaveBeenCalledTimes(2)
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's1: 已上传')
  })

  it('门④失败不更新基线：首轮失败后同内容下轮仍重试（不跳过）', async () => {
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

  it('门⑤部分失败不被门吸收：双目标一败一成（outcome=null）→ summary 仍记 true 但基线置 null，下轮同内容全量重试', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络错误')
    }
    const good = fakeBackend()
    const created: CloudBackend[] = [] // over 覆盖 makeBackend 后 makeDeps 的 backends 不再填充，自建计数
    const { deps, loadSources, recordStatus, saveTargetHash } = makeDeps({
      loadSources: vi.fn(async () => [
        { source: source('s-bad', { kind: 'gist' }), cred: GIST_CRED },
        { source: source('s-good'), cred: WEBDAV_CRED },
      ]),
      makeBackend: (cred) => {
        const b = cred.backend === 'gist' ? bad : good
        created.push(b)
        return b
      },
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run()
    // core 编排不抛错：整体仍记成功 summary（失败源记「失败」），失败源删基线
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's-bad: 失败; s-good: 已上传')
    expect(saveTargetHash).toHaveBeenCalledWith('s-bad', null)
    // 基线被置 null → 下轮同内容不被门短路，重建 backend 全流程重试
    await runner.run()
    expect(loadSources).toHaveBeenCalledTimes(2)
    expect(created).toHaveLength(4) // 每轮两源各建一个
    // 第二轮 good 源远端已有首轮信封，动作随远端形态可能变化（uploaded/downloaded 等），不精确断言；
    // 只断言仍按编排结果记 ok=true 而非被门跳过（ok=null）
    expect(vi.mocked(recordStatus).mock.calls.at(-1)![0]).toBe(true)
  })

  it('门⑥收敛回推失败（convergeError）同样置 null 基线：下轮不被门短路重试', async () => {
    const remoteB = fakeBackend(await envelopeBytesOf(B, PW)) // gist 源云端存较新 B
    const stuck = fakeBackend()
    stuck.put = async () => {
      throw new Error('写入失败')
    }
    const { deps, loadSources, recordStatus } = makeDeps({
      getVaultJson: () => A,
      loadSources: vi.fn(async () => [
        { source: source('s-conv', { kind: 'gist' }), cred: GIST_CRED },
        { source: source('s-stuck'), cred: WEBDAV_CRED },
      ]),
      loadTargetHash: vi.fn(async (id: string) => (id === 's-conv' ? 'stale' : null)),
      makeBackend: (cred) => (cred.backend === 'gist' ? remoteB : stuck),
    })
    const runner = createCloudSyncRunner(deps)
    await runner.run()
    // s-conv conflict-resolved 采纳 B；s-stuck 上传失败且收敛回推也失败（convergeError，outcome 保持 null）
    expect(recordStatus).toHaveBeenLastCalledWith(true, 's-conv: 冲突已解决; s-stuck: 失败')
    await runner.run() // 基线置 null → 下轮照常重试
    expect(loadSources).toHaveBeenCalledTimes(2)
  })
})
