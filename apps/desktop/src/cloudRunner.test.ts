import { describe, expect, it, vi } from 'vitest'
import { createBackupEnvelope, sha256Hex, type CloudBackend, type CloudCred } from '@totp/core'
import type { CloudTarget } from '@totp/ui'
import { createDesktopCloudSync, type CloudRunnerDeps } from './cloudRunner'

const PW = 'pw'
const PATH = 'totp-backup.totpbackup'
const A = JSON.stringify({ version: 1, entries: [{ label: 'A' }], groups: [], updatedAt: 1 })
const B = JSON.stringify({ version: 1, entries: [{ label: 'B' }], groups: [], updatedAt: 2 })
const bytesOf = (s: string) => new TextEncoder().encode(s)

const WEBDAV_CRED: CloudCred = { backend: 'webdav', serverUrl: 'https://dav', username: 'u', password: 'p' }
const GIST_CRED: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }

/** 内存 fake 后端（复用 core multiTarget.test 模式）：可预置 PATH 初始内容，putCount 供断言重推 */
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

/** 基线 deps：解锁、有 secret、默认无目标（可逐项覆写）；makeBackend 默认每次新建 fake backend。
 *  返回的 mock 引用在 over 覆盖后取 deps 上的最终值（断言永远指向实际注入的实现） */
function makeDeps(over: Partial<CloudRunnerDeps> = {}) {
  const loadCredsDef = vi.fn(async (): Promise<CloudTarget[]> => [])
  const loadTargetHashDef = vi.fn(async (): Promise<string | null> => null)
  const saveTargetHashDef = vi.fn(async () => undefined)
  const persistAdoptedDef = vi.fn(async () => undefined)
  const saveConflictBackupDef = vi.fn()
  const recordStatusDef = vi.fn()
  const onErrorDef = vi.fn()
  const backends: Array<CloudBackend & { store: Map<string, Uint8Array>; putCount: number }> = []
  const deps: CloudRunnerDeps = {
    isLocked: () => false,
    getSecret: () => PW,
    getVaultJson: () => A,
    loadCreds: loadCredsDef,
    loadTargetHash: loadTargetHashDef,
    saveTargetHash: saveTargetHashDef,
    makeBackend: () => {
      const b = fakeBackend()
      backends.push(b)
      return b
    },
    persistAdopted: persistAdoptedDef,
    saveConflictBackup: saveConflictBackupDef,
    recordStatus: recordStatusDef,
    onError: onErrorDef,
    ...over,
  }
  return {
    deps,
    loadCreds: deps.loadCreds as typeof loadCredsDef,
    loadTargetHash: deps.loadTargetHash as typeof loadTargetHashDef,
    saveTargetHash: deps.saveTargetHash as typeof saveTargetHashDef,
    persistAdopted: deps.persistAdopted as typeof persistAdoptedDef,
    saveConflictBackup: deps.saveConflictBackup as typeof saveConflictBackupDef,
    recordStatus: deps.recordStatus as typeof recordStatusDef,
    onError: deps.onError as typeof onErrorDef,
    backends,
  }
}

describe('createDesktopCloudSync', () => {
  it('①锁定 → 直接 return（不读凭据、不建 backend、不记状态）', async () => {
    const { deps, loadCreds } = makeDeps({ isLocked: () => true })
    await createDesktopCloudSync(deps).run()
    expect(loadCreds).not.toHaveBeenCalled()
    expect(deps.recordStatus).not.toHaveBeenCalled()
  })

  it('②无 secret → 直接 return', async () => {
    const { deps, loadCreds } = makeDeps({ getSecret: () => null })
    await createDesktopCloudSync(deps).run()
    expect(loadCreds).not.toHaveBeenCalled()
  })

  it('③空目标 → return（不建 backend、不回写 hash）', async () => {
    const { deps, backends, saveTargetHash } = makeDeps()
    await createDesktopCloudSync(deps).run()
    expect(backends).toHaveLength(0)
    expect(saveTargetHash).not.toHaveBeenCalled()
  })

  it('④仅 enabled 目标进入编排：disabled 不建 backend，enabled 正常回写 hash', async () => {
    const { deps, backends, saveTargetHash } = makeDeps({
      loadCreds: vi.fn(async () => [
        { cred: WEBDAV_CRED, enabled: true },
        { cred: GIST_CRED, enabled: false },
      ]),
    })
    await createDesktopCloudSync(deps).run()
    expect(backends).toHaveLength(1)
    expect(saveTargetHash).toHaveBeenCalledTimes(1)
    expect(saveTargetHash).toHaveBeenCalledWith('webdav', expect.any(String))
  })

  it('⑤path=resolveObjectPath(cred)：objectPath 自定义（含反斜杠）透传为归一路径', async () => {
    const b = fakeBackend()
    const { deps } = makeDeps({
      loadCreds: vi.fn(async () => [{ cred: { ...WEBDAV_CRED, objectPath: 'custom/dir\\bk.json' }, enabled: true }]),
      makeBackend: () => b,
    })
    await createDesktopCloudSync(deps).run()
    expect([...b.store.keys()]).toEqual(['custom/dir/bk.json'])
  })

  it('⑥hash 透传与成功回写：localHash 匹配 → in-sync（不重推），saveTargetHash 收到原 hash', async () => {
    const aHash = await sha256Hex(bytesOf(A))
    const b = fakeBackend(bytesOf(A))
    const { deps, loadTargetHash, saveTargetHash } = makeDeps({
      loadCreds: vi.fn(async () => [{ cred: WEBDAV_CRED, enabled: true }]),
      loadTargetHash: vi.fn(async (backend: string) => (backend === 'webdav' ? aHash : null)),
      makeBackend: () => b,
    })
    await createDesktopCloudSync(deps).run()
    expect(loadTargetHash).toHaveBeenCalledWith('webdav')
    expect(b.putCount).toBe(0) // hash 透传生效 → in-sync 不重推
    expect(saveTargetHash).toHaveBeenCalledWith('webdav', aHash)
  })

  it('⑥b失败目标回写 null：bad 目标抛错 → saveTargetHash(key, null)，good 目标正常', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络错误')
    }
    const good = fakeBackend()
    const { deps, saveTargetHash } = makeDeps({
      loadCreds: vi.fn(async () => [
        { cred: GIST_CRED, enabled: true },
        { cred: WEBDAV_CRED, enabled: true },
      ]),
      makeBackend: (cred) => (cred.backend === 'gist' ? bad : good),
    })
    await createDesktopCloudSync(deps).run()
    expect(saveTargetHash).toHaveBeenCalledWith('gist', null)
    expect(saveTargetHash).toHaveBeenCalledWith('webdav', expect.any(String))
    expect(deps.onError).not.toHaveBeenCalled() // 单目标失败不视为整体失败
  })

  it('⑦adopted → persistAdopted(finalVaultJson)，状态记 ok=true', async () => {
    const b = fakeBackend(await envelopeBytesOf(B, PW))
    const { deps, persistAdopted, recordStatus } = makeDeps({
      loadCreds: vi.fn(async () => [{ cred: WEBDAV_CRED, enabled: true }]),
      makeBackend: () => b,
    })
    await createDesktopCloudSync(deps).run()
    expect(persistAdopted).toHaveBeenCalledTimes(1)
    expect(persistAdopted).toHaveBeenCalledWith(B)
    expect(recordStatus).toHaveBeenCalledWith(true, 'webdav: downloaded')
  })

  it('⑧loadCreds 抛错 → 不向上抛，onError 与 recordStatus(false) 收到', async () => {
    const { deps, onError, recordStatus } = makeDeps({
      loadCreds: vi.fn(async () => {
        throw new Error('凭据读取失败')
      }),
    })
    await expect(createDesktopCloudSync(deps).run()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(recordStatus).toHaveBeenCalledWith(false, '凭据读取失败')
  })

  it('⑧badopt 落盘失败 → 基线不回写（下轮自动重试下载），onError 与 recordStatus(false) 收到', async () => {
    const b = fakeBackend(await envelopeBytesOf(B, PW))
    const { deps, saveTargetHash, onError, recordStatus } = makeDeps({
      loadCreds: vi.fn(async () => [{ cred: WEBDAV_CRED, enabled: true }]),
      makeBackend: () => b,
      persistAdopted: vi.fn(async () => {
        throw new Error('落盘失败')
      }),
    })
    await expect(createDesktopCloudSync(deps).run()).resolves.toBeUndefined()
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
    const { deps, loadCreds, saveTargetHash } = makeDeps({
      loadCreds: vi.fn(async () => [{ cred: WEBDAV_CRED, enabled: true }]),
      makeBackend: () => b,
    })
    const runner = createDesktopCloudSync(deps)
    const p1 = runner.run() // 同步执行到首个 await（loadCreds 已调用，get 挂起在 gate）
    const p2 = runner.run() // busy → 直接 return
    await p2
    expect(loadCreds).toHaveBeenCalledTimes(1)
    release()
    await p1
    expect(loadCreds).toHaveBeenCalledTimes(1)
    expect(saveTargetHash).toHaveBeenCalledTimes(1)
  })

  it('⑩成功 summary：逐目标 `key: action` 拼接；冲突副本回调带 key 透传', async () => {
    const b = fakeBackend(await envelopeBytesOf(B, PW))
    const { deps, recordStatus, saveConflictBackup } = makeDeps({
      loadCreds: vi.fn(async () => [{ cred: WEBDAV_CRED, enabled: true }]),
      loadTargetHash: vi.fn(async () => 'stale'),
      makeBackend: () => b,
    })
    await createDesktopCloudSync(deps).run()
    expect(recordStatus).toHaveBeenCalledWith(true, 'webdav: conflict-resolved')
    expect(saveConflictBackup).toHaveBeenCalledWith('webdav', expect.any(Uint8Array))
  })

  it('⑩b错误消息截断 100 字符后写状态', async () => {
    const long = 'x'.repeat(150)
    const { deps, recordStatus } = makeDeps({
      loadCreds: vi.fn(async () => {
        throw new Error(long)
      }),
    })
    await createDesktopCloudSync(deps).run()
    expect(recordStatus).toHaveBeenCalledWith(false, 'x'.repeat(100))
  })
})
