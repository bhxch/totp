import { describe, expect, it } from 'vitest'
import type { CloudBackend } from '../src/cloud/backend'
import { CloudHttpError, cloudFetch, ensureHttpOk, isAuthError } from '../src/cloud/backend'
import { createBackupEnvelope, createSyncEnvelope, openBackupEnvelope } from '../src/backup/envelope'
import { contentHash } from '../src/cloud/canonical'
import { sha256Hex, syncWithCloudRev } from '../src/cloud/syncOrchestrator'
import type { OtpEntry } from '../src/model'

const PATH = 'totp-backup.totpbackup'
const PASSWORD = '口令123'
const LOCAL_VAULT = JSON.stringify({ version: 2, entries: [{ uuid: 'local' }], tags: [], updatedAt: 1 })
const REMOTE_VAULT = JSON.stringify({ version: 2, entries: [{ uuid: 'remote' }], tags: [], updatedAt: 2 })
const ENC = new TextEncoder()

/** 内存 mock 后端：记录 put 次数以便断言分支不写云端 */
function mockBackend(initialBytes?: Uint8Array): CloudBackend & { store: Map<string, Uint8Array>; putCount: number } {
  const store = new Map<string, Uint8Array>()
  if (initialBytes) store.set(PATH, initialBytes)
  const backend: CloudBackend & { store: Map<string, Uint8Array>; putCount: number } = {
    id: 'webdav',
    putCount: 0,
    put: async (_p, data) => {
      backend.putCount++
      store.set(PATH, data)
    },
    get: async (p) => store.get(p) ?? null,
    delete: async (p) => {
      store.delete(p)
    },
    exists: async (p) => store.has(p),
    store,
  }
  return backend
}

/** 预置远端 envelope，返回其字节与 hash */
async function putRemoteEnvelope(vaultJson: string, password: string) {
  const env = await createBackupEnvelope(vaultJson, password)
  const bytes = ENC.encode(JSON.stringify(env))
  return { bytes, hash: await sha256Hex(bytes) }
}

describe('sha256Hex', () => {
  it('已知向量（SHA-256("abc")）与空串', async () => {
    expect(await sha256Hex(ENC.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})

// ---- syncWithCloudRev：rev 逻辑时钟四分支判定（spec §1.3/§1.4）----

const DEV_A = 'dev-a'
const DEV_B = 'dev-b'

function revEntry(uuid: string, patch: Partial<OtpEntry> = {}): OtpEntry {
  return { uuid, type: 'totp', issuer: 'I', label: uuid, secret: 'S', algorithm: 'SHA1', digits: 6, period: 30,
    tagIds: [], order: 0, createdAt: 1, updatedAt: 1, ...patch }
}
function revVaultJson(entries: OtpEntry[], updatedAt: number): string {
  return JSON.stringify({ version: 2, entries, tags: [], updatedAt })
}
/** 以 v3 信封封存对端（dev-b）写入的内容；baseContentHash 可注入错误值以构造降级合并 */
async function sealedRemote(rev: number, content: string, baseContentHash?: string): Promise<Uint8Array> {
  const env = await createSyncEnvelope(content, PASSWORD, 'balanced',
    { rev, deviceId: DEV_B, baseRev: rev - 1, baseContentHash: baseContentHash ?? (await contentHash(content)) })
  return ENC.encode(JSON.stringify(env))
}
const revState = (lastKnownRemoteRev: number | null, baseSnapshot: string | null) => ({ lastKnownRemoteRev, baseSnapshot })

describe('syncWithCloudRev', () => {
  it('云端无对象 → uploaded newRev=1：写 v3 信封，sync 头记录 deviceId/baseRev/baseContentHash', async () => {
    const backend = mockBackend()
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(null, null), deviceId: DEV_A,
    })
    expect(r.action).toBe('uploaded')
    expect(r.remoteRev).toBeNull() // null=云端无对象（与「rev=0」不混用）
    expect(r.newRev).toBe(1)
    expect(backend.putCount).toBe(1)
    const stored = JSON.parse(new TextDecoder().decode(backend.store.get(PATH)!))
    expect(stored.v).toBe(3)
    const baseHash = await contentHash(LOCAL_VAULT)
    expect(stored.sync).toMatchObject({ rev: 1, deviceId: DEV_A, baseRev: 0, baseContentHash: baseHash })
  })

  it('双方未动（remoteRev==已知 且 本地==基线）→ in-sync 零写', async () => {
    const backend = mockBackend(await sealedRemote(3, LOCAL_VAULT))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(3, LOCAL_VAULT), deviceId: DEV_A,
    })
    expect(r.action).toBe('in-sync')
    expect(r.remoteRev).toBe(3)
    expect(r.newRev).toBeUndefined()
    expect(backend.putCount).toBe(0)
  })

  it('F8 水位：vault 带顶层 rev（store 加密落盘恒推进）不判本地已动——采纳后 rev+1 下轮 in-sync 零写', async () => {
    // 模拟 store persistAdopted：采纳（downloaded）的 JSON 落盘时被 saveVaultToAdapter 附加
    // rev: n+1（F8 加密写推进水位）。内容 hash 若含 rev，下轮恒误判「本地已动」→ 冗余上传。
    const adopted = JSON.stringify({ ...JSON.parse(REMOTE_VAULT), rev: 8 })
    const backend = mockBackend(await sealedRemote(4, REMOTE_VAULT))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: adopted, password: PASSWORD,
      state: revState(4, REMOTE_VAULT), deviceId: DEV_A,
    })
    expect(r.action).toBe('in-sync')
    expect(r.remoteRev).toBe(4)
    expect(backend.putCount).toBe(0)
  })

  it('本地未动云端较新 → downloaded：applied=远端明文，零写', async () => {
    const backend = mockBackend(await sealedRemote(4, REMOTE_VAULT))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(3, LOCAL_VAULT), deviceId: DEV_A,
    })
    expect(r.action).toBe('downloaded')
    expect(r.appliedVaultJson).toBe(REMOTE_VAULT)
    expect(backend.putCount).toBe(0)
  })

  it('云端未动本地较新 → uploaded newRev=remoteRev+1：sync 头 baseContentHash 声明远端旧内容（=baseSnapshot）hash（审查 Critical-2 勘误）', async () => {
    const local = revVaultJson([revEntry('n1', { order: 1 })], 9)
    const backend = mockBackend(await sealedRemote(3, LOCAL_VAULT))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: local, password: PASSWORD,
      state: revState(3, LOCAL_VAULT), deviceId: DEV_A,
    })
    expect(r.action).toBe('uploaded')
    expect(r.newRev).toBe(4)
    const stored = JSON.parse(new TextDecoder().decode(backend.store.get(PATH)!))
    // §1.1：baseContentHash 指 baseRev 版本（远端旧内容）的规范化 hash——本用例不变量下
    // baseSnapshot==上次收敛内容==云端旧内容（LOCAL_VAULT），非本地新内容 hash
    const baseHash = await contentHash(LOCAL_VAULT)
    expect(stored.sync).toMatchObject({ rev: 4, deviceId: DEV_A, baseRev: 3, baseContentHash: baseHash })
    expect(await contentHash(local)).not.toBe(baseHash) // 确非本地新内容（旧实现固化的错误值）
  })

  it('纯上传且无 baseSnapshot（状态部分缺失）→ sync 头 baseContentHash 回退远端内容 hash', async () => {
    const backend = mockBackend(await sealedRemote(3, LOCAL_VAULT))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(3, null), deviceId: DEV_A,
    })
    expect(r.action).toBe('uploaded')
    expect(r.newRev).toBe(4)
    const stored = JSON.parse(new TextDecoder().decode(backend.store.get(PATH)!))
    expect(stored.sync.baseContentHash).toBe(await contentHash(LOCAL_VAULT))
  })

  it('同 rev 但云端内容≠baseSnapshot（无 CAS 碰撞）→ 视为已变：本地未动 → downloaded（审查 Critical-1）', async () => {
    // 场景：两设备同读 rev3 各传 rev4（无 CAS 先后都成功），rev 相等不代表内容一致
    const backend = mockBackend(await sealedRemote(3, REMOTE_VAULT))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(3, LOCAL_VAULT), deviceId: DEV_A,
    })
    expect(r.action).toBe('downloaded')
    expect(r.appliedVaultJson).toBe(REMOTE_VAULT)
    expect(r.remoteRev).toBe(3)
    expect(backend.putCount).toBe(0)
  })

  it('同 rev 但云端内容≠baseSnapshot 且本地也动 → merged 非降级（审查 Critical-1）', async () => {
    const base = revVaultJson([revEntry('a', { order: 1 })], 1)
    const ours = revVaultJson([revEntry('a', { order: 1 }), revEntry('b', { order: 2 })], 2)
    const theirs = revVaultJson([revEntry('a', { order: 1 }), revEntry('c', { order: 3 })], 3)
    const backend = mockBackend(await sealedRemote(3, theirs, await contentHash(base)))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: ours, password: PASSWORD,
      state: revState(3, base), deviceId: DEV_A,
    })
    expect(r.action).toBe('merged')
    expect(r.mergeDegraded).toBe(false)
    expect(r.remoteRev).toBe(3)
    expect(r.newRev).toBe(4)
    expect(JSON.parse(r.appliedVaultJson!).entries.map((x: { uuid: string }) => x.uuid).sort()).toEqual(['a', 'b', 'c'])
  })

  it('v2 远端（无 rev）且本地也动 → merged 降级：remoteRev=null，newRev 从本端已知时钟续起', async () => {
    const base = revVaultJson([revEntry('a', { order: 1 })], 1)
    const ours = revVaultJson([revEntry('a', { order: 1 }), revEntry('b', { order: 2 })], 2)
    const backend = mockBackend((await putRemoteEnvelope(REMOTE_VAULT, PASSWORD)).bytes)
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: ours, password: PASSWORD,
      state: revState(2, base), deviceId: DEV_A,
    })
    expect(r.action).toBe('merged')
    expect(r.remoteRev).toBeNull() // v2 无头：远端无 rev
    expect(r.mergeDegraded).toBe(true) // header null → 无祖先声明，两方合并
    expect(r.newRev).toBe(3) // max(null→0, knownRev=2) + 1：不静默归零
    const stored = JSON.parse(new TextDecoder().decode(backend.store.get(PATH)!))
    expect(stored.v).toBe(3) // 采纳合并结果即完成 v3 升级（§1.4）
  })

  it('双方都动 → merged：条目并集 + 上传 newRev=remote+1；baseContentHash 不匹配降级 degraded（副本先行、后上传）', async () => {
    const base = revVaultJson([revEntry('a', { order: 1 })], 1)
    const ours = revVaultJson([revEntry('a', { order: 1 }), revEntry('b', { order: 2 })], 2)
    const theirs = revVaultJson([revEntry('a', { order: 1 }), revEntry('c', { order: 3 })], 3)
    const backend = mockBackend(await sealedRemote(5, theirs, 'wrong'))
    const events: string[] = []
    const seen: Uint8Array[] = []
    const origPut = backend.put.bind(backend)
    backend.put = async (p, d) => {
      await origPut(p, d)
      events.push('put')
    }
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: ours, password: PASSWORD,
      state: revState(4, base), deviceId: DEV_A,
      onConflictBackup: (b) => {
        events.push('copy')
        seen.push(b)
      },
    })
    expect(r.action).toBe('merged')
    expect(r.mergeDegraded).toBe(true)
    expect(r.remoteRev).toBe(5)
    expect(r.newRev).toBe(6)
    expect(JSON.parse(r.appliedVaultJson!).entries.map((x: { uuid: string }) => x.uuid).sort()).toEqual(['a', 'b', 'c'])
    // 安全序：先存本地旧内容（合并前）副本，再上传合并结果
    expect(events).toEqual(['copy', 'put'])
    expect(backend.putCount).toBe(1)
    const copyJson = await openBackupEnvelope(JSON.parse(new TextDecoder().decode(seen[0]!)), PASSWORD)
    expect(copyJson).toBe(ours)
    const stored = JSON.parse(new TextDecoder().decode(backend.store.get(PATH)!))
    const theirsHash = await contentHash(theirs)
    expect(stored.sync).toMatchObject({ rev: 6, deviceId: DEV_A, baseRev: 5, baseContentHash: theirsHash })
  })

  it('双方都动且 base 校验通过 → merged 非降级：mergeDegraded=false，双改分歧按 updatedAt 裁决', async () => {
    const base = revVaultJson([revEntry('a', { order: 1, label: 'old' })], 1)
    const ours = revVaultJson([revEntry('a', { order: 1, label: 'local-new', updatedAt: 2 }), revEntry('b', { order: 2 })], 2)
    const theirs = revVaultJson([revEntry('a', { order: 1, label: 'remote-new', updatedAt: 3 }), revEntry('c', { order: 3 })], 3)
    const backend = mockBackend(await sealedRemote(5, theirs, await contentHash(base)))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: ours, password: PASSWORD,
      state: revState(4, base), deviceId: DEV_A,
    })
    expect(r.action).toBe('merged')
    expect(r.mergeDegraded).toBe(false)
    expect(r.newRev).toBe(6)
    const merged = JSON.parse(r.appliedVaultJson!)
    expect(merged.entries.map((x: { uuid: string }) => x.uuid).sort()).toEqual(['a', 'b', 'c'])
    expect(merged.entries.find((x: { uuid: string }) => x.uuid === 'a').label).toBe('remote-new')
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts![0]!.ours!.label).toBe('local-new')
    expect(r.conflicts![0]!.theirs!.label).toBe('remote-new')
  })

  it('preview 模式：merged 分支不写云、不存副本、newRev 缺省', async () => {
    const base = revVaultJson([revEntry('a', { order: 1 })], 1)
    const ours = revVaultJson([revEntry('a', { order: 1 }), revEntry('b', { order: 2 })], 2)
    const theirs = revVaultJson([revEntry('a', { order: 1 }), revEntry('c', { order: 3 })], 3)
    const backend = mockBackend(await sealedRemote(5, theirs, 'wrong'))
    let copyCalled = false
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: ours, password: PASSWORD,
      state: revState(4, base), deviceId: DEV_A, mode: 'preview',
      onConflictBackup: () => {
        copyCalled = true
      },
    })
    expect(r.action).toBe('merged')
    expect(r.newRev).toBeUndefined()
    expect(r.mergeDegraded).toBe(true)
    expect(JSON.parse(r.appliedVaultJson!).entries.map((x: { uuid: string }) => x.uuid).sort()).toEqual(['a', 'b', 'c'])
    expect(copyCalled).toBe(false)
    expect(backend.putCount).toBe(0)
  })

  it('preview 模式：云端无对象 → uploaded 预览，不写云、newRev 缺省', async () => {
    const backend = mockBackend()
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(null, null), deviceId: DEV_A, mode: 'preview',
    })
    expect(r.action).toBe('uploaded')
    expect(r.remoteRev).toBeNull() // null=云端无对象
    expect(r.newRev).toBeUndefined()
    expect(backend.putCount).toBe(0)
  })

  it('内容相等仅刷基线（对端重推同内容，密文随机 IV）→ in-sync：零写、零副本', async () => {
    const backend = mockBackend(await sealedRemote(4, LOCAL_VAULT)) // rev 4 ≠ 已知 3，解密内容与本地一致
    let copyCalled = false
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(3, LOCAL_VAULT), deviceId: DEV_A,
      onConflictBackup: () => {
        copyCalled = true
      },
    })
    expect(r.action).toBe('in-sync')
    expect(r.remoteRev).toBe(4)
    expect(copyCalled).toBe(false)
    expect(backend.putCount).toBe(0)
  })

  it('v2 远端（无 sync 头）视为远端已变走保守比对：内容不同 → downloaded；内容一致 → in-sync 零写', async () => {
    const backend = mockBackend((await putRemoteEnvelope(REMOTE_VAULT, PASSWORD)).bytes)
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(3, LOCAL_VAULT), deviceId: DEV_A,
    })
    expect(r.action).toBe('downloaded')
    expect(r.appliedVaultJson).toBe(REMOTE_VAULT)

    const same = mockBackend((await putRemoteEnvelope(LOCAL_VAULT, PASSWORD)).bytes)
    const r2 = await syncWithCloudRev({
      backend: same, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(3, LOCAL_VAULT), deviceId: DEV_A,
    })
    expect(r2.action).toBe('in-sync')
    expect(r2.remoteRev).toBeNull() // v2 无头：远端无 rev，null 与「rev=0」不混用
    expect(same.putCount).toBe(0)
  })

  it('口令不匹配 / 远端结构坏 → 抛中文错误，不写云、不触发副本回调', async () => {
    const backend = mockBackend(await sealedRemote(3, REMOTE_VAULT))
    let called = false
    await expect(
      syncWithCloudRev({
        backend, path: PATH, vaultJson: LOCAL_VAULT, password: '另一个口令',
        state: revState(2, LOCAL_VAULT), deviceId: DEV_A,
        onConflictBackup: () => {
          called = true
        },
      }),
    ).rejects.toThrow('云端备份口令不匹配，无法合并——请确认口令或手动下载处理')
    expect(called).toBe(false)
    expect(backend.putCount).toBe(0)

    const corrupt = mockBackend(ENC.encode('not a json {{'))
    await expect(
      syncWithCloudRev({
        backend: corrupt, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
        state: revState(2, LOCAL_VAULT), deviceId: DEV_A,
      }),
    ).rejects.toThrow('云端备份口令不匹配，无法合并——请确认口令或手动下载处理')
  })

  it('副本回调失败（Promise reject）→ merged 分支整体失败：不上传合并结果', async () => {
    const base = revVaultJson([revEntry('a', { order: 1 })], 1)
    const ours = revVaultJson([revEntry('a', { order: 1 }), revEntry('b', { order: 2 })], 2)
    const theirs = revVaultJson([revEntry('a', { order: 1 }), revEntry('c', { order: 3 })], 3)
    const backend = mockBackend(await sealedRemote(5, theirs, 'wrong'))
    await expect(
      syncWithCloudRev({
        backend, path: PATH, vaultJson: ours, password: PASSWORD,
        state: revState(4, base), deviceId: DEV_A,
        onConflictBackup: () => Promise.reject(new Error('副本写入失败')),
      }),
    ).rejects.toThrow('副本写入失败')
    expect(backend.putCount).toBe(0)
  })

  it('副本回调同步 throw（非 Promise reject 形态）→ merged 分支整体失败：不上传合并结果', async () => {
    const base = revVaultJson([revEntry('a', { order: 1 })], 1)
    const ours = revVaultJson([revEntry('a', { order: 1 }), revEntry('b', { order: 2 })], 2)
    const theirs = revVaultJson([revEntry('a', { order: 1 }), revEntry('c', { order: 3 })], 3)
    const backend = mockBackend(await sealedRemote(5, theirs, 'wrong'))
    await expect(
      syncWithCloudRev({
        backend, path: PATH, vaultJson: ours, password: PASSWORD,
        state: revState(4, base), deviceId: DEV_A,
        onConflictBackup: () => {
          throw new Error('副本同步抛错') // 同步 throw：宿主回调非 async 形态的失败同样中止上传
        },
      }),
    ).rejects.toThrow('副本同步抛错')
    expect(backend.putCount).toBe(0)
  })

  it('exists=true 但 get→null 竞态（对象在探测后被删）→ 按「云端无对象」uploaded：rev 从本端时钟续起', async () => {
    const backend = mockBackend()
    let getCalls = 0
    backend.exists = async () => true // 探测命中
    backend.get = async () => (getCalls++ === 0 ? null : backend.store.get(PATH) ?? null) // 首读被并发删除；回读恢复正常
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(4, LOCAL_VAULT), deviceId: DEV_A,
    })
    expect(r.action).toBe('uploaded')
    expect(r.remoteRev).toBeNull() // 视作云端无对象（与 rev=0 不混用）
    expect(r.newRev).toBe(5) // knownRev+1：对象被删后重推不回退时钟
    expect(backend.putCount).toBe(1)
  })

  it('远端回滚（rev < 本端已知且内容不同）+ 本地未动 → downloaded（不因 rev 倒退误判 in-sync）', async () => {
    // 场景：云端对象被旧备份回滚覆盖（rev 2 < 已知 5），内容≠baseSnapshot
    const backend = mockBackend(await sealedRemote(2, REMOTE_VAULT))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(5, LOCAL_VAULT), deviceId: DEV_A,
    })
    expect(r.action).toBe('downloaded')
    expect(r.appliedVaultJson).toBe(REMOTE_VAULT)
    expect(r.remoteRev).toBe(2)
    expect(backend.putCount).toBe(0)
  })

  it('远端回滚 + 本地也动 → merged：newRev 从本端已知时钟续起（max(remote,known)+1 单调）', async () => {
    const base = revVaultJson([revEntry('a', { order: 1 })], 1)
    const ours = revVaultJson([revEntry('a', { order: 1 }), revEntry('b', { order: 2 })], 2)
    const theirs = revVaultJson([revEntry('a', { order: 1 }), revEntry('c', { order: 3 })], 3)
    // rev 2 < 已知 5：合并上传的新 rev 必须 6（不回退到 3）
    const backend = mockBackend(await sealedRemote(2, theirs, 'wrong'))
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: ours, password: PASSWORD,
      state: revState(5, base), deviceId: DEV_A,
    })
    expect(r.action).toBe('merged')
    expect(r.remoteRev).toBe(2)
    expect(r.newRev).toBe(6)
    const stored = JSON.parse(new TextDecoder().decode(backend.store.get(PATH)!))
    expect(stored.sync.rev).toBe(6)
  })

  it('readPath 分离（orchestrator 层）：判定/下载走 readPath，uploaded 写入恒走 path（keep 源读最新份写新份）', async () => {
    // readPath 上有对端重推的同基线内容（rev 4，内容==baseSnapshot → 云端未动），path（写入域）为空；
    // 本用例后端按真实 path 落键
    const seeded = await sealedRemote(4, LOCAL_VAULT)
    const store = new Map<string, Uint8Array>([['dir/vault-20250101-000000.totpbackup', seeded]])
    const backend: CloudBackend = {
      id: 'webdav',
      put: async (p, data) => void store.set(p, data),
      get: async (p) => store.get(p) ?? null,
      delete: async (p) => void store.delete(p),
      exists: async (p) => store.has(p),
    }
    const local = revVaultJson([revEntry('n1', { order: 1 })], 9) // 本地已改（相对基线）
    const r = await syncWithCloudRev({
      backend, path: 'dir/vault-20250102-000000.totpbackup',
      readPath: 'dir/vault-20250101-000000.totpbackup',
      vaultJson: local, password: PASSWORD,
      state: revState(4, LOCAL_VAULT), deviceId: DEV_A,
    })
    // 读侧 rev4==known、内容==baseSnapshot → 云端未动本地已改 → uploaded；写入落 path（新时间戳份）
    expect(r.action).toBe('uploaded')
    expect(r.newRev).toBe(5)
    expect(store.has('dir/vault-20250102-000000.totpbackup')).toBe(true)
    // 读侧对象零改动（readPath 只读；密文随机 IV，按字节比对原始种子）
    expect(store.get('dir/vault-20250101-000000.totpbackup')).toBe(seeded)
  })

  it('readPath 分离（orchestrator 层）：readPath 较新且本地未动 → downloaded，零写（写入域不含本轮）', async () => {
    const store = new Map<string, Uint8Array>([['dir/vault-20250101-000000.totpbackup', await sealedRemote(4, REMOTE_VAULT)]])
    const backend: CloudBackend = {
      id: 'webdav',
      put: async (p, data) => void store.set(p, data),
      get: async (p) => store.get(p) ?? null,
      delete: async (p) => void store.delete(p),
      exists: async (p) => store.has(p),
    }
    const r = await syncWithCloudRev({
      backend, path: 'dir/vault-20250102-000000.totpbackup',
      readPath: 'dir/vault-20250101-000000.totpbackup',
      vaultJson: LOCAL_VAULT, password: PASSWORD,
      state: revState(3, LOCAL_VAULT), deviceId: DEV_A,
    })
    expect(r.action).toBe('downloaded')
    expect(r.appliedVaultJson).toBe(REMOTE_VAULT)
    expect(store.has('dir/vault-20250102-000000.totpbackup')).toBe(false)
  })

  it('preview + 云端未动本地已改 → uploaded 预览零写（写分支的 preview 短路）', async () => {
    const backend = mockBackend(await sealedRemote(3, LOCAL_VAULT))
    const local = revVaultJson([revEntry('n1', { order: 1 })], 9)
    const r = await syncWithCloudRev({
      backend, path: PATH, vaultJson: local, password: PASSWORD,
      state: revState(3, LOCAL_VAULT), deviceId: DEV_A, mode: 'preview',
    })
    expect(r.action).toBe('uploaded')
    expect(r.remoteRev).toBe(3)
    expect(r.newRev).toBeUndefined()
    expect(backend.putCount).toBe(0)
  })
})

describe('CloudHttpError / isAuthError（审查 I2 结构化凭据失效判定）', () => {
  const res = (status: number, ok = status >= 200 && status < 300) => ({ ok, status }) as Response

  it('ensureHttpOk 抛 CloudHttpError：message 原形态（「label 请求失败（HTTP nnn）」）+ 数字 status', () => {
    try {
      ensureHttpOk('WebDAV', res(401))
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as CloudHttpError).message).toBe('WebDAV 请求失败（HTTP 401）')
      expect((err as CloudHttpError).status).toBe(401)
    }
  })

  it('isAuthError：结构化 status 优先——401/403 命中、500 不误判，消息不含状态码也判定', () => {
    expect(isAuthError(new CloudHttpError('WebDAV', 401))).toBe(true)
    expect(isAuthError(new CloudHttpError('S3', 403))).toBe(true)
    expect(isAuthError(new CloudHttpError('WebDAV', 500))).toBe(false)
    expect(isAuthError(Object.assign(new Error('令牌已刷新请重试'), { status: 401 }))).toBe(true)
    expect(isAuthError(Object.assign(new Error('令牌已刷新请重试'), { status: 502 }))).toBe(false)
  })

  it('isAuthError 兜底：仅「（HTTP 401）/（HTTP 403）」定界形式命中；裸数字文本（配额提示/路径含 403）不误判', () => {
    expect(isAuthError(new Error('WebDAV 请求失败（HTTP 401）'))).toBe(true)
    expect(isAuthError(new Error('Google Drive 请求失败（HTTP 403）'))).toBe(true)
    expect(isAuthError(new Error('同步了 403 个条目'))).toBe(false)
    expect(isAuthError(new Error('路径 /bucket-4013/obj 不存在'))).toBe(false)
    expect(isAuthError(new Error('网络超时'))).toBe(false)
    expect(isAuthError('字符串形态：Gist 请求失败（HTTP 401）')).toBe(true)
  })
})

describe('cloudFetch（网络层包装）', () => {
  it('fetch 抛出物非 Error（字符串 reject）→ 消息按 String(err) 归一，不加 CORS 提示', async () => {
    globalThis.fetch = (async () => {
      throw 'socket reset' // 非 TypeError 且非 Error
    }) as typeof fetch
    const err = await cloudFetch('WebDAV', 'https://dav.example.com/obj').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('WebDAV 网络请求失败：socket reset（dav.example.com/obj）')
    expect((err as Error).message).not.toContain('CORS')
  })

  it('url 非法（URL 构造失败）→ 错误位置回落「<url 解析失败>」占位，不抛二级异常', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const err = await cloudFetch('S3', '::not a url::').then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe('S3 网络请求失败：fetch failed — 若为自建 WebDAV/S3(MinIO)请检查服务端 CORS 配置（<url 解析失败>）')
  })
})
