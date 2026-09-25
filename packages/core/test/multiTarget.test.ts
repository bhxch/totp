import { describe, expect, it } from 'vitest'
import { createBackupEnvelope, createSyncEnvelope, KDF_PROFILES, openBackupEnvelope } from '../src/backup/envelope'
import type { OtpEntry } from '../src/model'
import { mergeVaults } from '../src/merge/vaultMerge'
import type { BackupSource } from '../src/backup/sources'
import type { SourceSyncState } from '../src/cloud/syncState'
import type { CloudBackend } from '../src/cloud/backend'
import { CloudHttpError } from '../src/cloud/backend'
import { contentHash } from '../src/cloud/canonical'
import { pushEnvelope, sha256Hex, type RevSyncOutcome } from '../src/cloud/syncOrchestrator'
import { syncMultipleTargets, type MultiTargetInput, type MultiTargetSyncResult, type TargetResult } from '../src/cloud/multiTarget'

const PATH = 'p'
const PW = 'pw'
const DEV = 'dev-a'
const OTHER_DEV = 'dev-b'
const ENC = new TextEncoder()

const e = (uuid: string, over: Partial<OtpEntry> = {}): OtpEntry => ({
  uuid, type: 'totp', issuer: 'I', label: uuid, secret: 'S', algorithm: 'SHA1', digits: 6, period: 30,
  tagIds: [], order: 0, createdAt: 1, updatedAt: 1, ...over,
})
const v = (entries: OtpEntry[], updatedAt = 1): string => JSON.stringify({ version: 2, entries, tags: [], updatedAt })
const uuidsOf = (json: string): string[] =>
  (JSON.parse(json) as { entries: Array<{ uuid: string }> }).entries.map((x) => x.uuid).sort()

const A = v([e('a')])
const AB = v([e('a'), e('b')])

const emptyState = (): SourceSyncState => ({ lastKnownRemoteRev: null, baseSnapshot: null })
const revState = (lastKnownRemoteRev: number | null, baseSnapshot: string | null): SourceSyncState => ({ lastKnownRemoteRev, baseSnapshot })

const src = (role: 'primary' | 'replica', over: Partial<BackupSource> = {}): BackupSource => ({
  id: role === 'primary' ? 'pri' : 'rep',
  kind: 'webdav', name: role, retention: { type: 'overwrite' }, enabled: true, role, ...over,
})

/** 内存 fake 后端：各目标独立 store，可预置初始内容；putCount 供断言零写/推平次数 */
function fakeBackend(initial?: Uint8Array): CloudBackend & { store: Map<string, Uint8Array>; putCount: number } {
  const store = new Map<string, Uint8Array>()
  if (initial) store.set(PATH, initial)
  const backend: CloudBackend & { store: Map<string, Uint8Array>; putCount: number } = {
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
    store,
  }
  return backend
}

/** 以 v3 信封预置远端（他设备 dev-b 写入形态）；baseContentHash 可注入错误值构造降级合并 */
async function sealedRemote(rev: number, content: string, baseContentHash?: string): Promise<Uint8Array> {
  const env = await createSyncEnvelope(content, PW, 'balanced',
    { rev, deviceId: OTHER_DEV, baseRev: rev - 1, baseContentHash: baseContentHash ?? (await contentHash(content)) })
  return ENC.encode(JSON.stringify(env))
}

/** 以 v2 信封（无 sync 头）预置远端：旧版本客户端写入形态 */
async function sealedRemoteV2(content: string): Promise<Uint8Array> {
  const env = await createBackupEnvelope(content, PW)
  return ENC.encode(JSON.stringify(env))
}

/** 断言云端字节可用口令解开为期望 vault 明文 */
async function expectOpensTo(bytes: Uint8Array, password: string, expected: string): Promise<void> {
  const env = JSON.parse(new TextDecoder().decode(bytes))
  expect(await openBackupEnvelope(env, password)).toBe(expected)
}

/** 读远端 v3 信封 sync 头 */
function syncHeaderOf(bytes: Uint8Array): { v: number; sync: { rev: number; deviceId: string; baseRev: number; baseContentHash: string } } {
  return JSON.parse(new TextDecoder().decode(bytes))
}

function pri(t: Partial<MultiTargetInput> = {}): MultiTargetInput {
  return { key: 'pri', backend: fakeBackend(), path: PATH, source: src('primary'), state: emptyState(), ...t }
}
function rep(t: Partial<MultiTargetInput> = {}): MultiTargetInput {
  return { key: 'rep', backend: fakeBackend(), path: PATH, source: src('replica'), state: emptyState(), ...t }
}
const find = (r: MultiTargetSyncResult, key: string): TargetResult =>
  r.results.find((x) => x.key === key)!

describe('pushEnvelope', () => {
  it('上传并回读校验：hash 为上传信封字节的摘要，store 有对象且可解开为原文', async () => {
    const backend = fakeBackend()
    const pushed = await pushEnvelope({ backend, path: PATH, vaultJson: A, password: PW })
    const stored = backend.store.get(PATH)!
    expect(stored).toBeDefined()
    // 回读校验已内建于 pushEnvelope：存储内容可同口令解开为 A
    await expectOpensTo(stored, PW, A)
    expect(pushed.hash).toBe(await sha256Hex(stored))
    expect(await sha256Hex(ENC.encode(pushed.envelopeJson))).toBe(await sha256Hex(stored))
  })

  it('回读 get→null（假写成功竞态）→ 抛「云端校验失败」', async () => {
    const backend = fakeBackend()
    backend.get = async () => null // put 声称成功但对象立即可读消失
    await expect(
      pushEnvelope({ backend, path: PATH, vaultJson: A, password: PW }),
    ).rejects.toThrow('云端校验失败：上传内容与回读不一致')
  })

  it('回读内容被篡改（sha256 不一致，如代理/网关截断改写）→ 抛「云端校验失败」', async () => {
    const backend = fakeBackend()
    backend.put = async (_p, data) => {
      // 落盘时被中间层损坏：截掉尾部字节（回读 hash ≠ 上传 hash）
      backend.store.set(PATH, data.slice(0, data.length - 8))
    }
    await expect(
      pushEnvelope({ backend, path: PATH, vaultJson: A, password: PW }),
    ).rejects.toThrow('云端校验失败：上传内容与回读不一致')
  })
})

describe('syncMultipleTargets（primary 裁决 + replica 收敛复制）', () => {
  it('primary 上传裁决 + replica 内容一致且 rev 匹配 → replica 跳过零写，states 按出口推导', async () => {
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemote(2, A))
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, A) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'pri').outcome!.action).toBe('uploaded')
    expect(find(r, 'pri').outcome!.newRev).toBe(1)
    expect(find(r, 'rep').outcome!.action).toBe('in-sync')
    expect(find(r, 'rep').outcome!.remoteRev).toBe(2)
    expect(rb.putCount).toBe(0) // 跳过零写
    // primary uploaded → { lastKnownRemoteRev: newRev, baseSnapshot: 实际上传内容 }
    expect(r.states['pri']).toEqual({ lastKnownRemoteRev: 1, baseSnapshot: A })
    // replica 跳过 → 原 state 不变（内容等价）
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 2, baseSnapshot: A })
    expect(r.adopted).toBe(false)
    expect(r.finalVaultJson).toBe(A)
    expect(r.conflicts).toEqual([])
  })

  it('replica 内容落后 → 推平 final（newRev=replica remote+1），state 记 newRev+final', async () => {
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemote(2, v([e('x')])))
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, v([e('x')])) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'rep').outcome!.action).toBe('uploaded')
    expect(find(r, 'rep').outcome!.newRev).toBe(3)
    // 推平后 replica 云端可解开为 final
    await expectOpensTo(rb.store.get(PATH)!, PW, A)
    const header = syncHeaderOf(rb.store.get(PATH)!)
    expect(header.v).toBe(3)
    expect(header.sync).toMatchObject({ rev: 3, deviceId: DEV, baseRev: 2, baseContentHash: await contentHash(v([e('x')])) })
    // profile 缺省 balanced：推平信封按默认档位生成
    expect((JSON.parse(new TextDecoder().decode(rb.store.get(PATH)!)) as { kdf: { profile: string } }).kdf.profile).toBe('balanced')
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 3, baseSnapshot: A })
  })

  it('profile 透传：推平信封按注入档位展开 KDF 参数', async () => {
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemote(2, v([e('x')])))
    await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, v([e('x')])) })],
      vaultJson: A, password: PW, deviceId: DEV, profile: 'fast',
    })
    const env = JSON.parse(new TextDecoder().decode(rb.store.get(PATH)!)) as { kdf: { profile: string; m: number } }
    expect(env.kdf.profile).toBe('fast')
    expect(env.kdf.m).toBe(KDF_PROFILES.fast.m)
  })

  it('replica rev 领先（误配置他设备写入）→ 先合并进 final 再推平，不丢数据', async () => {
    // final=AB（primary 裁决后），replica 云端被 dev-b 写入 AC rev5（base 声明失配 → 降级两方合并）
    const ac = v([e('a'), e('c')])
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemote(5, ac, 'wrong'))
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, A) })],
      vaultJson: AB, password: PW, deviceId: DEV,
    })
    expect(find(r, 'rep').outcome!.action).toBe('merged')
    expect(find(r, 'rep').outcome!.mergeDegraded).toBe(true)
    expect(find(r, 'rep').outcome!.newRev).toBe(6) // max(remoteRev=5, known=2) + 1：不回退时钟
    // final 采纳合并结果：误配置写入的 c 不丢
    expect(uuidsOf(r.finalVaultJson)).toEqual(['a', 'b', 'c'])
    expect(r.adopted).toBe(true)
    await expectOpensTo(rb.store.get(PATH)!, PW, r.finalVaultJson)
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 6, baseSnapshot: r.finalVaultJson })
  })

  it('primary 失败 → 该源 outcome null + error，replica 仍按 final=本地内容推平（不阻断）', async () => {
    const pb = fakeBackend()
    pb.get = async () => {
      throw new Error('网络错误')
    }
    const stale = v([e('x')])
    const rb = fakeBackend(await sealedRemote(2, stale))
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, stale) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'pri').outcome).toBeNull()
    expect(find(r, 'pri').error).toContain('网络错误')
    expect(find(r, 'rep').outcome!.action).toBe('uploaded')
    expect(find(r, 'rep').outcome!.newRev).toBe(3)
    await expectOpensTo(rb.store.get(PATH)!, PW, A)
    expect(r.finalVaultJson).toBe(A)
    // primary 失败：state 原样保留
    expect(r.states['pri']).toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 3, baseSnapshot: A })
  })

  it('primary 凭据失效（CloudHttpError）→ errorStatus 结构化透传', async () => {
    const pb = fakeBackend()
    pb.get = async () => {
      throw new CloudHttpError('WebDAV', 401)
    }
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'pri').outcome).toBeNull()
    expect(find(r, 'pri').errorStatus).toBe(401)
  })

  it.each([
    ['空 targets', []],
    ['仅 replica', [rep()]],
    ['primary 未启用', [pri({ source: src('primary', { enabled: false }) }), rep()]],
    ['role=primary 但 disabled 的残留 + replica', [pri({ source: src('primary', { enabled: false }) })]],
  ])('%s → 抛 no primary target', async (_name, targets) => {
    await expect(
      syncMultipleTargets({ targets: targets as MultiTargetInput[], vaultJson: A, password: PW, deviceId: DEV }),
    ).rejects.toThrow('no primary target')
  })

  it('preview：primary merged → 不写云不存副本，conflicts 汇总返回，states 原样（宿主不得持久化）', async () => {
    const base = v([e('a', { label: 'old' })])
    const ours = v([e('a', { label: 'local', updatedAt: 2 }), e('b')])
    const theirs = v([e('a', { label: 'remote', updatedAt: 3 }), e('c')])
    const pb = fakeBackend(await sealedRemote(5, theirs, await contentHash(base)))
    const rb = fakeBackend()
    const copies: Array<{ key: string; bytes: Uint8Array }> = []
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: revState(4, base) }), rep({ backend: rb })],
      vaultJson: ours, password: PW, deviceId: DEV, mode: 'preview',
      onConflictBackup: (key, bytes) => {
        copies.push({ key, bytes })
      },
    })
    const priOut = find(r, 'pri').outcome!
    expect(priOut.action).toBe('merged')
    expect(priOut.newRev).toBeUndefined() // preview 无写入时钟
    expect(priOut.conflicts).toHaveLength(1)
    expect(r.conflicts).toHaveLength(1) // 冲突汇总拼接
    expect(r.adopted).toBe(true) // final 为合并预览
    expect(uuidsOf(r.finalVaultJson)).toEqual(['a', 'b', 'c'])
    expect(copies).toHaveLength(0)
    expect(pb.putCount).toBe(0)
    expect(rb.putCount).toBe(0) // replica 空云也只预览不首推
    // 整轮只读：states 原样返回（零推导，preview 结果不得落盘）
    expect(r.states['pri']).toEqual(revState(4, base))
    expect(r.states['rep']).toEqual(emptyState())
  })

  it('replica 云端无对象（remoteRev null）→ 首推 rev 从 1 起、baseRev 0', async () => {
    const pb = fakeBackend()
    const rb = fakeBackend()
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'rep').outcome!.action).toBe('uploaded')
    expect(find(r, 'rep').outcome!.remoteRev).toBeNull() // null=云端无对象，与 rev=0 不混用
    expect(find(r, 'rep').outcome!.newRev).toBe(1)
    const header = syncHeaderOf(rb.store.get(PATH)!)
    expect(header.sync).toMatchObject({ rev: 1, baseRev: 0, deviceId: DEV, baseContentHash: await contentHash(A) })
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 1, baseSnapshot: A })
  })

  it('replica 云端较新且 final 未动 → downloaded 两方并入 final（base 未知防丢）后推平', async () => {
    // 外部改写丢了条目 b：replica 上次收敛在 AB（state 基线=final），云端被 dev-b 重写为 AD rev5 →
    // downloaded；并入（merge(null, AB, AD)=ABD）后 ≠ 远端现内容 → 二次调用推平 newRev=6
    const ad = v([e('a'), e('d')])
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemote(5, ad))
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, AB) })],
      vaultJson: AB, password: PW, deviceId: DEV,
    })
    expect(find(r, 'rep').outcome!.action).toBe('uploaded')
    expect(find(r, 'rep').outcome!.newRev).toBe(6)
    expect(uuidsOf(r.finalVaultJson)).toEqual(['a', 'b', 'd']) // replica 云端的 d 并入 final，不丢
    expect(r.adopted).toBe(true)
    await expectOpensTo(rb.store.get(PATH)!, PW, r.finalVaultJson)
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 6, baseSnapshot: r.finalVaultJson })
  })

  it('replica 云端为 final 超集且 final 未动 → 并入后与远端一致，in-sync 零写（推平无必要）', async () => {
    const ad = v([e('a'), e('d')])
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemote(5, ad))
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, A) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'rep').outcome!.action).toBe('in-sync')
    expect(rb.putCount).toBe(0)
    expect(uuidsOf(r.finalVaultJson)).toEqual(['a', 'd']) // 并入生效
    expect(r.adopted).toBe(true)
    // in-sync 落 state 以远端现值刷新（远端内容==final），下轮零处理
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 5, baseSnapshot: ad })
  })

  it('downloaded 后推平失败 → convergeError 记录原因，outcome 保持 downloaded 原值，state 原样', async () => {
    const ad = v([e('a'), e('d')])
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemote(5, ad))
    rb.put = async () => {
      throw new Error('put坏')
    }
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, AB) })],
      vaultJson: AB, password: PW, deviceId: DEV,
    })
    const repRes = find(r, 'rep')
    expect(repRes.outcome!.action).toBe('downloaded') // 不被推平失败覆盖
    expect(repRes.outcome!.appliedVaultJson).toBe(ad)
    expect(repRes.convergeError).toContain('put坏')
    expect(repRes.error).toBeUndefined()
    // 并入不因推平失败回滚（数据不丢，随 finalVaultJson 交宿主采纳）
    expect(uuidsOf(r.finalVaultJson)).toEqual(['a', 'b', 'd'])
    // 推平失败 → 原 state 不变（下轮重做）
    expect(r.states['rep']).toEqual(revState(2, AB))
  })

  it('apply 模式 primary merged：副本先于上传、副本回调透传 target key、conflicts 汇总', async () => {
    const base = v([e('a', { label: 'old' })])
    const ours = v([e('a', { label: 'local', updatedAt: 2 }), e('b')])
    const theirs = v([e('a', { label: 'remote', updatedAt: 3 }), e('c')])
    const pb = fakeBackend(await sealedRemote(5, theirs, await contentHash(base)))
    const events: string[] = []
    const copies: Array<{ key: string; bytes: Uint8Array }> = []
    const origPut = pb.put.bind(pb)
    pb.put = async (p, d) => {
      await origPut(p, d)
      events.push('put')
    }
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: revState(4, base) })],
      vaultJson: ours, password: PW, deviceId: DEV,
      onConflictBackup: (key, bytes) => {
        events.push('copy')
        copies.push({ key, bytes })
      },
    })
    expect(events).toEqual(['copy', 'put']) // 安全序：先存本地旧内容副本，再上传合并结果
    expect(copies).toHaveLength(1)
    expect(copies[0]!.key).toBe('pri')
    await expectOpensTo(copies[0]!.bytes, PW, ours) // 副本为合并前的本地旧内容
    expect(find(r, 'pri').outcome!.action).toBe('merged')
    expect(find(r, 'pri').outcome!.newRev).toBe(6)
    expect(r.conflicts).toHaveLength(1)
    expect(r.conflicts[0]!.ours!.label).toBe('local')
    expect(r.conflicts[0]!.theirs!.label).toBe('remote')
  })

  it('primary merged 后 state 记 newRev（非合并前 remoteRev）：下轮本地改动走纯上传，裁决不被降级合并回滚（T13 回归）', async () => {
    // base 校验通过的三方合并（updatedAt 新者 remote 胜出）→ state 必须记录合并结果落云的 newRev=6；
    // 若误记合并前 remoteRev=5，下轮本地改动（宿主裁决改回本地方）会被误判为双方都动，且 base 失配
    // 降级两方合并，把裁决结果回滚成合并默认主体
    const base = v([e('a', { label: 'old' })])
    const ours = v([e('a', { label: 'local', updatedAt: 2 })])
    const theirs = v([e('a', { label: 'remote', updatedAt: 3 })])
    const pb = fakeBackend(await sealedRemote(5, theirs, await contentHash(base)))
    const r1 = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: revState(4, base) })],
      vaultJson: ours, password: PW, deviceId: DEV,
    })
    expect(find(r1, 'pri').outcome).toMatchObject({ action: 'merged', remoteRev: 5, newRev: 6 })
    expect(r1.states['pri']).toEqual({ lastKnownRemoteRev: 6, baseSnapshot: r1.finalVaultJson })

    // 模拟宿主裁决：重写本地为合并败者（本地方）→ 下轮必须纯上传（云端相对基线未动）
    const adjudicated = v([e('a', { label: 'local', updatedAt: 2 })])
    const r2 = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: r1.states['pri']! })],
      vaultJson: adjudicated, password: PW, deviceId: DEV,
    })
    expect(find(r2, 'pri').outcome).toMatchObject({ action: 'uploaded', newRev: 7 })
    expect(find(r2, 'pri').outcome!.conflicts).toBeUndefined()
    await expectOpensTo(pb.store.get(PATH)!, PW, adjudicated)
  })

  it('primary in-sync（对端重推同内容 rev 前进）→ state 跟进 lastKnownRemoteRev，下轮走 rev 快路径', async () => {
    // 对端 dev-b 以 rev 5 重推与本地一致的内容：远端时钟前进但内容相等 → in-sync 零写；
    // state 必须跟进到 5（否则本端 lastKnownRemoteRev 恒滞后，每轮都要走内容比对慢路径）
    const pb = fakeBackend(await sealedRemote(5, A))
    const r1 = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: revState(2, A) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r1, 'pri').outcome).toMatchObject({ action: 'in-sync', remoteRev: 5 })
    expect(pb.putCount).toBe(0)
    // 仅跟进时钟，baseSnapshot 保持原值（两 in-sync 分支均以本地未动为前提）
    expect(r1.states['pri']).toEqual({ lastKnownRemoteRev: 5, baseSnapshot: A })
    // 下轮：remoteRev==已知 且 本地==baseSnapshot → rev 快路径 in-sync，仍零写
    const r2 = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: r1.states['pri']! })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r2, 'pri').outcome).toMatchObject({ action: 'in-sync', remoteRev: 5 })
    expect(pb.putCount).toBe(0)
    expect(r2.states['pri']).toEqual({ lastKnownRemoteRev: 5, baseSnapshot: A })
  })

  it('多 replica：首个 replica 并入的内容随 final 推给后续 replica', async () => {
    const ad = v([e('a'), e('d')])
    const pb = fakeBackend()
    const r1b = fakeBackend(await sealedRemote(5, ad))
    const r2b = fakeBackend(await sealedRemote(2, A))
    const r = await syncMultipleTargets({
      targets: [
        pri({ backend: pb }),
        rep({ key: 'rep1', backend: r1b, state: revState(2, A) }),
        rep({ key: 'rep2', backend: r2b, state: revState(2, A) }),
      ],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    // rep1 云端较新 → 并入 d 进 final（并入后与远端一致 → in-sync，记录=远端现值 5）；
    // rep2 处理时 final 已含 d → 推平 AD
    expect(uuidsOf(r.finalVaultJson)).toEqual(['a', 'd'])
    expect(find(r, 'rep1').outcome!.action).toBe('in-sync')
    expect(find(r, 'rep2').outcome!.action).toBe('uploaded')
    await expectOpensTo(r2b.store.get(PATH)!, PW, r.finalVaultJson)
  })

  it('单 replica 失败不阻断其余 replica 与结果汇总', async () => {
    const pb = fakeBackend()
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络错误')
    }
    const good = fakeBackend()
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ key: 'bad', backend: bad }), rep({ key: 'good', backend: good })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'bad').outcome).toBeNull()
    expect(find(r, 'bad').error).toContain('网络错误')
    expect(find(r, 'good').outcome!.action).toBe('uploaded')
    expect(find(r, 'pri').outcome!.action).toBe('uploaded')
    // 失败 replica state 原样，成功 replica 正常推导
    expect(r.states['bad']).toEqual(emptyState())
    expect(r.states['good']).toEqual({ lastKnownRemoteRev: 1, baseSnapshot: A })
  })

  it('disabled replica 不参与收敛复制', async () => {
    const pb = fakeBackend()
    const rb = fakeBackend()
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, source: src('replica', { enabled: false }) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(rb.putCount).toBe(0)
    expect(r.results.map((x) => x.key)).toEqual(['pri'])
    expect(r.states['rep']).toBeUndefined()
  })

  it('primary in-sync（对端重推同内容）+ replica 落后 → replica 照常推平（states 混合形态）', async () => {
    // primary 云端 rev5==内容一致 → in-sync（final=本地入参）；replica 云端停留在旧内容 rev2 → 推平
    const pb = fakeBackend(await sealedRemote(5, A))
    const stale = v([e('x')])
    const rb = fakeBackend(await sealedRemote(2, stale))
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: revState(5, A) }), rep({ backend: rb, state: revState(2, stale) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'pri').outcome!.action).toBe('in-sync')
    expect(find(r, 'rep').outcome!.action).toBe('uploaded')
    expect(find(r, 'rep').outcome!.newRev).toBe(3)
    await expectOpensTo(rb.store.get(PATH)!, PW, A)
    expect(r.states['pri']).toEqual({ lastKnownRemoteRev: 5, baseSnapshot: A })
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 3, baseSnapshot: A })
  })

  it('全部目标失败收敛：primary 与 replica 全失败 → final=本地、adopted=false、states 原样、错误逐目标记录', async () => {
    const pb = fakeBackend()
    pb.get = async () => {
      throw new Error('primary 网络错误')
    }
    const rb = fakeBackend()
    rb.exists = async () => {
      throw 'replica 字符串异常' // 非 Error 抛出物：error 字段按 String(err) 归一
    }
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: revState(4, A) }), rep({ backend: rb, state: revState(2, A) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'pri').outcome).toBeNull()
    expect(find(r, 'pri').error).toContain('primary 网络错误')
    expect(find(r, 'rep').outcome).toBeNull()
    expect(find(r, 'rep').error).toBe('replica 字符串异常') // String(err) 分支
    expect(r.finalVaultJson).toBe(A)
    expect(r.adopted).toBe(false)
    expect(r.states['pri']).toEqual(revState(4, A))
    expect(r.states['rep']).toEqual(revState(2, A))
  })

  it('onConflictBackup reject 在 multiTarget 层：primary merged 副本失败 → 该目标 outcome null，零写云，state 原样', async () => {
    const base = v([e('a', { label: 'old' })])
    const ours = v([e('a', { label: 'local', updatedAt: 2 }), e('b')])
    const theirs = v([e('a', { label: 'remote', updatedAt: 3 }), e('c')])
    const pb = fakeBackend(await sealedRemote(5, theirs, await contentHash(base)))
    const rb = fakeBackend() // replica 空云：验证 primary 失败不阻断 replica 首推
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: revState(4, base) }), rep({ backend: rb })],
      vaultJson: ours, password: PW, deviceId: DEV,
      onConflictBackup: () => Promise.reject(new Error('副本存储已满')),
    })
    expect(find(r, 'pri').outcome).toBeNull()
    expect(find(r, 'pri').error).toContain('副本存储已满')
    expect(pb.putCount).toBe(0) // 安全序：副本失败绝不继续上传合并结果
    expect(r.states['pri']).toEqual(revState(4, base)) // 失败目标 state 原样
    // replica 仍照常按 final=本地内容首推（单目标失败不阻断）
    expect(find(r, 'rep').outcome!.action).toBe('uploaded')
  })

  it('replica merged：副本回调同样透传 target key（副本=合并前 final 内容）', async () => {
    const ac = v([e('a'), e('c')])
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemote(5, ac, 'wrong'))
    const copies: Array<{ key: string; bytes: Uint8Array }> = []
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, A) })],
      vaultJson: AB, password: PW, deviceId: DEV,
      onConflictBackup: (key, bytes) => {
        copies.push({ key, bytes })
      },
    })
    expect(find(r, 'rep').outcome!.action).toBe('merged')
    expect(copies).toHaveLength(1)
    expect(copies[0]!.key).toBe('rep')
    await expectOpensTo(copies[0]!.bytes, PW, AB) // 副本=合并前本地内容（此处=final）
  })

  it('primary in-sync 且 remoteRev=null（v2 无头内容一致）→ state 保持原 lastKnownRemoteRev 不写 0', async () => {
    const pb = fakeBackend(await sealedRemoteV2(A)) // v2 信封无 sync 头
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb, state: revState(7, A) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'pri').outcome).toMatchObject({ action: 'in-sync', remoteRev: null })
    // newRev/remoteRev 均 null → 回退 state 原值（不落 0）
    expect(r.states['pri']).toEqual({ lastKnownRemoteRev: 7, baseSnapshot: A })
  })

  it('replica in-sync 且 remoteRev=null（v2 无头内容一致）→ state 保持原 lastKnownRemoteRev 不写 0', async () => {
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemoteV2(A))
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(9, A) })],
      vaultJson: A, password: PW, deviceId: DEV,
    })
    expect(find(r, 'rep').outcome).toMatchObject({ action: 'in-sync', remoteRev: null })
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 9, baseSnapshot: A })
  })

  it('replica 云端为 v2 较新内容 → downloaded 并入后二次收敛推平：中间态 remoteRev=null 回退已知时钟', async () => {
    // v2 无头使 downloaded 的 remoteRev=null：二次调用 state.lastKnownRemoteRev 回退 t.state 原值，
    // 二次调用对 v2 远端再走保守内容比对 → merged（降级两方），newRev=max(0, known)+1 单调
    const ad = v([e('a'), e('d')])
    const pb = fakeBackend()
    const rb = fakeBackend(await sealedRemoteV2(ad))
    const copies: Array<{ key: string; bytes: Uint8Array }> = []
    const r = await syncMultipleTargets({
      targets: [pri({ backend: pb }), rep({ backend: rb, state: revState(2, AB) })],
      vaultJson: AB, password: PW, deviceId: DEV,
      onConflictBackup: (key, bytes) => {
        copies.push({ key, bytes })
      },
    })
    expect(uuidsOf(r.finalVaultJson)).toEqual(['a', 'b', 'd']) // 并入不丢
    expect(find(r, 'rep').outcome!.action).toBe('merged')
    expect(find(r, 'rep').outcome!.newRev).toBe(3) // max(null→0, 2) + 1
    await expectOpensTo(rb.store.get(PATH)!, PW, r.finalVaultJson)
    expect(r.states['rep']).toEqual({ lastKnownRemoteRev: 3, baseSnapshot: r.finalVaultJson })
    // 首轮 downloaded 零副本；二次收敛轮 merged 落安全副本（key 透传，副本=该轮上传前的 final 内容）
    expect(copies.map((c) => c.key)).toEqual(['rep'])
    await expectOpensTo(copies[0]!.bytes, PW, r.finalVaultJson)
  })
})

describe('mergeVaults 两方并入参数序（裁定 4 防丢语义哨兵）', () => {
  it('mergeVaults(null, ours=final, theirs=replica)：theirs 独有条目保留，ours 改动胜出', () => {
    const final = v([e('a', { label: 'final' })])
    const replicaApplied = v([e('a', { label: 'replica' }), e('d')])
    const merged = mergeVaults(null, JSON.parse(final), JSON.parse(replicaApplied))
    expect(merged.vault.entries.map((x: { uuid: string }) => x.uuid).sort()).toEqual(['a', 'd'])
    expect(merged.conflicts).toHaveLength(1) // 双方同改 → 冲突记录（不静默覆盖）
  })
})
