import { describe, expect, it } from 'vitest'
import type { CloudBackend } from '../src/cloud/backend'
import { CloudHttpError, ensureHttpOk, isAuthError } from '../src/cloud/backend'
import { createBackupEnvelope, createSyncEnvelope, openBackupEnvelope } from '../src/backup/envelope'
import { contentHash } from '../src/cloud/canonical'
import { sha256Hex, syncWithCloud, syncWithCloudRev } from '../src/cloud/syncOrchestrator'
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

describe('syncWithCloud', () => {
  it('云端不存在：加密上传 → uploaded，hash 为所传字节摘要，put 内容可用口令解开', async () => {
    const backend = mockBackend()
    const out = await syncWithCloud({ backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD, localHash: null })
    expect(out.action).toBe('uploaded')
    expect(out.conflictBackup).toBeUndefined()
    expect(backend.putCount).toBe(1)
    const stored = backend.store.get(PATH)!
    expect(out.hash).toBe(await sha256Hex(stored))
    // envelopeJson 即本次上传的 envelope JSON（C3：uploaded 分支携带 envelope 供校验）
    expect(out.envelopeJson).toBeDefined()
    const env = JSON.parse(out.envelopeJson!)
    expect(await import('../src/backup/envelope').then((m) => m.openBackupEnvelope(env, PASSWORD))).toBe(LOCAL_VAULT)
  })

  it('exists 为真但 get 为 null（竞态）→ 视作不存在，走上传分支', async () => {
    const backend = mockBackend()
    backend.exists = async () => true
    const out = await syncWithCloud({ backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD, localHash: null })
    expect(out.action).toBe('uploaded')
    expect(backend.putCount).toBe(1)
  })

  it('in-sync 分支契约（仅 mock 形态短路，生产不可达）：远端字节==本地明文 → in-sync（不依赖 cloudRev）不写云端', async () => {
    // 勘误（2026-09-18 审查）：本用例为 syncWithCloud in-sync 分支的纯契约单测——mock 远端存明文
    // 才能触发该分支。生产形态远端恒为 envelope 密文，密文摘要 ≠ 本地明文摘要，判据永不相等、
    // 分支不可达，编排层并无「内容未变→跳过」去重；生产去重已由宿主自动通道的明文内容 hash 门
    // 落地（cloudRunner，见 packages/ui/src/components/cloudRunner.ts）。下一用例为 envelope 真实形态的现状行为。
    const bytes = ENC.encode(LOCAL_VAULT)
    const backend = mockBackend(bytes)
    const out = await syncWithCloud({
      backend,
      path: PATH,
      vaultJson: LOCAL_VAULT,
      password: PASSWORD,
      localHash: '0'.repeat(64), // cloudRev 不一致也以内容一致优先
    })
    expect(out.action).toBe('in-sync')
    expect(out.hash).toBe(await sha256Hex(bytes))
    // in-sync 不再返回 envelopeJson：其语义为密文/明文混用，调用方需要时应自行 backend.get
    expect(out.envelopeJson).toBeUndefined()
    expect(backend.putCount).toBe(0)
  })

  it('远端为 envelope 且内容与基线一致 → 现状走 uploaded 重传（in-sync 生产不可达，去重由宿主门承担）', async () => {
    // 真实形态：远端恒为 envelope 密文。即使解密后内容与本地完全一致，密文摘要 ≠ 本地明文摘要，
    // 判据不可达 → 现状每轮全量重传；该路径的去重已由宿主明文 hash 门承担（cloudRunner，见
    // packages/ui/src/components/cloudRunner.ts）
    const { bytes, hash } = await putRemoteEnvelope(LOCAL_VAULT, PASSWORD)
    const backend = mockBackend(bytes)
    const out = await syncWithCloud({
      backend,
      path: PATH,
      vaultJson: LOCAL_VAULT,
      password: PASSWORD,
      localHash: hash, // 基线与远端字节一致（「远端未变」），仍因内容判据失效而重传
    })
    expect(out.action).toBe('uploaded')
    expect(backend.putCount).toBe(1)
    // 重传后远端仍可同口令解开为本地 vault，基线为新信封字节摘要
    const env = JSON.parse(new TextDecoder().decode(backend.store.get(PATH)!))
    expect(await openBackupEnvelope(env, PASSWORD)).toBe(LOCAL_VAULT)
    expect(out.hash).toBe(await sha256Hex(backend.store.get(PATH)!))
  })

  it('本地较新（远端 == cloudRev 且 != 本地内容）→ uploaded：put 一次，云端可解开为本地 vault', async () => {
    const { bytes, hash } = await putRemoteEnvelope(REMOTE_VAULT, PASSWORD)
    const backend = mockBackend(bytes)
    const out = await syncWithCloud({ backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD, localHash: hash })
    expect(out.action).toBe('uploaded')
    expect(backend.putCount).toBe(1)
    expect(out.hash).toBe(await sha256Hex(backend.store.get(PATH)!))
    const env = JSON.parse(new TextDecoder().decode(backend.store.get(PATH)!))
    expect(await import('../src/backup/envelope').then((m) => m.openBackupEnvelope(env, PASSWORD))).toBe(LOCAL_VAULT)
  })

  it('put 后回读内容与所传字节不一致 → 抛「云端校验失败」，不返回 uploaded', async () => {
    const backend = mockBackend()
    const origPut = backend.put.bind(backend)
    backend.put = async (p, data) => {
      await origPut(p, data)
      backend.store.set(PATH, ENC.encode('tampered-by-cloud')) // 模拟云端落盘内容损坏
    }
    await expect(
      syncWithCloud({ backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD, localHash: null }),
    ).rejects.toThrow('云端校验失败：上传内容与回读不一致')
    expect(backend.store.get(PATH)!).toEqual(ENC.encode('tampered-by-cloud'))
  })

  it('首次接云（localHash=null，远端可解）→ downloaded：冲突副本为加密 envelope（可同口令解开），envelopeJson 为远端明文', async () => {
    const { bytes, hash } = await putRemoteEnvelope(REMOTE_VAULT, PASSWORD)
    const backend = mockBackend(bytes)
    const seen: Uint8Array[] = []
    const out = await syncWithCloud({
      backend,
      path: PATH,
      vaultJson: LOCAL_VAULT,
      password: PASSWORD,
      localHash: null,
      onConflictBackup: (b) => {
        seen.push(b)
        return 'conflict-1.json'
      },
    })
    expect(out.action).toBe('downloaded')
    expect(seen).toHaveLength(1)
    const copyEnv = JSON.parse(new TextDecoder().decode(seen[0]!))
    expect(await import('../src/backup/envelope').then((m) => m.openBackupEnvelope(copyEnv, PASSWORD))).toBe(LOCAL_VAULT)
    expect(out.conflictBackup).toBe('conflict-1.json')
    expect(out.hash).toBe(hash)
    expect(out.envelopeJson).toBe(REMOTE_VAULT)
    expect(backend.putCount).toBe(0)
  })

  it('基线不一致（localHash 有值但内容不同，远端可解）→ conflict-resolved，副本加密可解开', async () => {
    const { bytes } = await putRemoteEnvelope(REMOTE_VAULT, PASSWORD)
    const backend = mockBackend(bytes)
    const seen: Uint8Array[] = []
    const out = await syncWithCloud({
      backend,
      path: PATH,
      vaultJson: LOCAL_VAULT,
      password: PASSWORD,
      localHash: '0'.repeat(64),
      onConflictBackup: (b) => {
        seen.push(b)
        return 'conflict-2.json'
      },
    })
    expect(out.action).toBe('conflict-resolved')
    expect(out.conflictBackup).toBe('conflict-2.json')
    expect(out.envelopeJson).toBe(REMOTE_VAULT)
    const copyEnv = JSON.parse(new TextDecoder().decode(seen[0]!))
    expect(await import('../src/backup/envelope').then((m) => m.openBackupEnvelope(copyEnv, PASSWORD))).toBe(LOCAL_VAULT)
    expect(new TextDecoder().decode(seen[0]!)).not.toContain('local') // 副本为密文，不含明文片段
  })

  it('冲突回调返回 null / 未提供回调 → conflictBackup 为 undefined，分支仍完成', async () => {
    const { bytes } = await putRemoteEnvelope(REMOTE_VAULT, PASSWORD)
    const backend = mockBackend(bytes)
    const out = await syncWithCloud({
      backend,
      path: PATH,
      vaultJson: LOCAL_VAULT,
      password: PASSWORD,
      localHash: '0'.repeat(64),
      onConflictBackup: () => null,
    })
    expect(out.action).toBe('conflict-resolved')
    expect(out.conflictBackup).toBeUndefined()

    const bare = await syncWithCloud({ backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD, localHash: '0'.repeat(64) })
    expect(bare.action).toBe('conflict-resolved')
    expect(bare.conflictBackup).toBeUndefined()
  })

  it('口令错误 → 抛中文错误，且不写云端、不触发冲突副本回调', async () => {
    const { bytes } = await putRemoteEnvelope(REMOTE_VAULT, '另一个口令')
    const backend = mockBackend(bytes)
    let called = false
    await expect(
      syncWithCloud({
        backend,
        path: PATH,
        vaultJson: LOCAL_VAULT,
        password: PASSWORD,
        localHash: '0'.repeat(64),
        onConflictBackup: () => {
          called = true
        },
      }),
    ).rejects.toThrow('云端备份口令不匹配，无法合并——请确认口令或手动下载处理')
    expect(called).toBe(false)
    expect(backend.putCount).toBe(0)
  })

  it('远端结构坏（非 envelope JSON）→ 同样抛中文错误', async () => {
    const backend = mockBackend(ENC.encode('not a json {{'))
    await expect(
      syncWithCloud({ backend, path: PATH, vaultJson: LOCAL_VAULT, password: PASSWORD, localHash: '0'.repeat(64) }),
    ).rejects.toThrow('云端备份口令不匹配，无法合并——请确认口令或手动下载处理')
  })
})

describe('syncWithCloud 下载后内容比对（跨端同步审查 C1）', () => {
  it('基线漂移但解密内容与本地一致 → in-sync 仅刷新基线：不存副本、不写云（密文随机 IV 去重）', async () => {
    // 场景：对端全量重推了内容相同的 vault（密文随机盐/IV → 字节摘要必变，旧基线恒失配）。
    // 修复前此处走 conflict-resolved：存无意义副本 + converge 回推，且 hash 持续漂移。
    const { bytes, hash } = await putRemoteEnvelope(LOCAL_VAULT, PASSWORD)
    const backend = mockBackend(bytes)
    let copyCalled = false
    const out = await syncWithCloud({
      backend,
      path: PATH,
      vaultJson: LOCAL_VAULT,
      password: PASSWORD,
      localHash: '0'.repeat(64), // 基线 ≠ 远端字节（漂移态）→ 旧实现必走 conflict 分支
      onConflictBackup: () => {
        copyCalled = true
        return 'conflict-x.json'
      },
    })
    expect(out.action).toBe('in-sync')
    expect(out.hash).toBe(hash) // hash=远端字节摘要，调用方回写即完成基线刷新
    expect(out.envelopeJson).toBeUndefined() // in-sync 契约：不含 envelopeJson
    expect(copyCalled).toBe(false) // 不存冲突副本
    expect(backend.putCount).toBe(0) // 不写云（不回推）
  })

  it('手动路径回归不变：基线漂移且内容不同 → 仍 conflict-resolved 存副本（既有冲突语义不受 C1 影响）', async () => {
    const { bytes } = await putRemoteEnvelope(REMOTE_VAULT, PASSWORD)
    const backend = mockBackend(bytes)
    const seen: Uint8Array[] = []
    const out = await syncWithCloud({
      backend,
      path: PATH,
      vaultJson: LOCAL_VAULT,
      password: PASSWORD,
      localHash: '0'.repeat(64),
      onConflictBackup: (b) => {
        seen.push(b)
        return 'conflict-keep.json'
      },
    })
    expect(out.action).toBe('conflict-resolved')
    expect(seen).toHaveLength(1)
    expect(backend.putCount).toBe(0)
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
