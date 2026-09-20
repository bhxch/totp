/**
 * syncEngine 编排层测试：chrome.storage（local/sync）以内存实现注入 globalThis.chrome，
 * 无法自动化真实 chrome.sync（需浏览器账号云），故在编排逻辑层面验证：
 * - meta.rev > appliedRev 时 pushSync 先走 pullOnce 应用远端、再重读本端推送（不覆盖他端较新数据）
 * - pull 未成功应用（分片缺失/损坏）时放弃推送，宁缺勿以陈旧覆盖
 * - rev 已最新 / 远端从未推送 / 同步关闭时的既有语义保持
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  base64ToBytes, bytesToBase64, chunkKey, chunksToMeta, splitIntoChunks, type SyncChunk,
} from '@totp/core'
import { needsPullBeforePush, pullSyncIfNewer, pushSync, SYNC_STATUS_KEY } from '../src/syncEngine'

const VAULT_KEY = 'vault'
const SECURITY_KEY = 'security'
const SETTINGS_KEY = 'settings'
const META_KEY = 'sync:meta'
const APPLIED_REV_KEY = 'sync:appliedRev'

type Store = Record<string, unknown>

/** chrome.storage.Area 的内存实现（get(null)/get(keys)/set/remove/getBytesInUse） */
function makeArea(initial: Store = {}) {
  const data: Store = { ...initial }
  return {
    data,
    async get(keys: string[] | null): Promise<Store> {
      if (keys === null) return { ...data }
      const out: Store = {}
      for (const k of keys) if (k in data) out[k] = data[k]
      return out
    },
    async set(obj: Store): Promise<void> {
      Object.assign(data, obj)
    },
    async remove(keys: string[]): Promise<void> {
      for (const k of keys) delete data[k]
    },
    async getBytesInUse(): Promise<number> {
      return JSON.stringify(data).length
    },
    QUOTA_BYTES: 102_400,
  }
}

function installChrome(localInit: Store = {}, syncInit: Store = {}) {
  const local = makeArea(localInit)
  const sync = makeArea(syncInit)
  ;(globalThis as unknown as { chrome: unknown }).chrome = { storage: { local, sync } }
  return { local, sync }
}

/** UTF-8 字符串 ↔ base64（复用 core 的编解码，与被测实现同语义） */
const b64 = (s: string): string => bytesToBase64(new TextEncoder().encode(s))
const unb64 = (s: string): string => new TextDecoder().decode(base64ToBytes(s))

/** 远端推送一次 payload（rev=rev），返回写入 sync 区的完整批次（模拟他端 push 落库） */
function remotePush(payload: string, rev: number, updatedAt = 1000): Store {
  const chunks = splitIntoChunks(payload, rev, updatedAt)
  const batch: Store = { [META_KEY]: chunksToMeta(chunks) }
  for (const c of chunks) batch[chunkKey(c.part, c.total)] = c
  return batch
}

beforeEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome
})

describe('needsPullBeforePush（纯函数）', () => {
  it('meta 存在且 rev 更大 → true；rev 相同/更小或无 meta → false', () => {
    const meta = { rev: 3, updatedAt: 1, total: 1 }
    expect(needsPullBeforePush(meta, 2)).toBe(true)
    expect(needsPullBeforePush(meta, 3)).toBe(false)
    expect(needsPullBeforePush(meta, 5)).toBe(false)
    expect(needsPullBeforePush(null, 0)).toBe(false)
  })
})

describe('pushOnce 编排（经 pushSync）', () => {
  it('meta.rev > appliedRev：先拉取应用远端，再重读本端推送（推送内容=拉取后的数据，非陈旧 local）', async () => {
    // F6 门控后拉取应用的 payload 必须是合法 vault 形状（结构非法会被拒绝落盘并置 invalid）
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 })
    const { local, sync } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['stale-local'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [APPLIED_REV_KEY]: 1,
      },
      { ...remotePush(remotePayload, 2), 'sync:settings': JSON.stringify({ syncEnabled: true }) },
    )

    await pushSync()

    // 1) 前置 pull 生效：本端 vault 已被远端 payload 覆盖（明文态 security 跟随移除语义，本无 security）
    expect(local.data[VAULT_KEY]).toBe(remotePayload)
    // 2) 随后重读本端推送：新 rev=3，分片内容 = 拉取后的数据（而非初始 stale local）；
    //    appliedRev 终态 3（前置 pull 落 2，推送后落 3）
    const meta = sync.data[META_KEY] as { rev: number }
    expect(meta.rev).toBe(3)
    const pushed = sync.data[chunkKey(0, 1)] as SyncChunk
    expect(unb64(pushed.data)).toBe(remotePayload)
    expect(local.data[APPLIED_REV_KEY]).toBe(3)
    // 3) 状态 ok
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'ok' })
  })

  it('appliedRev 已是最新：不拉取，直接推送本端数据', async () => {
    const localPayload = JSON.stringify({ entries: ['local-latest'] })
    const remotePayload = JSON.stringify({ entries: ['remote-old'] })
    const { local, sync } = installChrome(
      {
        [VAULT_KEY]: localPayload,
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [APPLIED_REV_KEY]: 2,
      },
      { ...remotePush(remotePayload, 2, 500) },
    )

    await pushSync()

    // 本端数据未被远端旧 payload 覆盖（rev 相等不拉取），推送 rev=3 内容为本端数据
    expect(local.data[VAULT_KEY]).toBe(localPayload)
    const meta = sync.data[META_KEY] as { rev: number }
    expect(meta.rev).toBe(3)
    const pushed = sync.data[chunkKey(0, 1)] as SyncChunk
    expect(unb64(pushed.data)).toBe(localPayload)
  })

  it('远端分片缺失致 pull 失败：放弃推送（sync 区保持他端 rev，不以陈旧覆盖）', async () => {
    const { local, sync } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['stale-local'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [APPLIED_REV_KEY]: 1,
      },
      // meta 声称 total=2，实际只落了 part 0 → mergeChunks 得 null → pull 置 error
      {
        [META_KEY]: { rev: 2, updatedAt: 1000, total: 2 },
        [chunkKey(0, 2)]: { rev: 2, updatedAt: 1000, part: 0, total: 2, data: b64('half') },
      },
    )

    await pushSync()

    expect(sync.data[META_KEY]).toMatchObject({ rev: 2 }) // 未推送（推送会 rev=3）
    expect(local.data[VAULT_KEY]).toBe(JSON.stringify({ entries: ['stale-local'] })) // 未被拉取应用
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'error' })
  })

  it('远端从未推送（无 meta）：直接推送本端数据', async () => {
    const localPayload = JSON.stringify({ entries: ['first-push'] })
    const { local, sync } = installChrome(
      {
        [VAULT_KEY]: localPayload,
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      {},
    )

    await pushSync()

    const meta = sync.data[META_KEY] as { rev: number }
    expect(meta.rev).toBe(1)
    const pushed = sync.data[chunkKey(0, 1)] as SyncChunk
    expect(unb64(pushed.data)).toBe(localPayload)
    expect(local.data[APPLIED_REV_KEY]).toBe(1)
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'ok' })
  })

  it('同步关闭：pushSync 直接短路（不拉取不推送）', async () => {
    const { local, sync } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['stale-local'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: false }),
        [APPLIED_REV_KEY]: 1,
      },
      remotePush(JSON.stringify({ entries: ['remote-newer'] }), 2),
    )

    await pushSync()

    expect(sync.data[META_KEY]).toMatchObject({ rev: 2 })
    expect(local.data[VAULT_KEY]).toBe(JSON.stringify({ entries: ['stale-local'] }))
  })
})

describe('pullSyncIfNewer（经 pullOnce）', () => {
  it('远端较新：应用合法 payload 并保留本端 syncEnabled 位', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 123 })
    const remoteSettings = JSON.stringify({ syncEnabled: true, theme: 'dark' })
    const { local } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['old'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true, theme: 'dark' }),
        [APPLIED_REV_KEY]: 0,
      },
      {
        ...remotePush(remotePayload, 4),
        'sync:settings': remoteSettings,
      },
    )

    await pullSyncIfNewer()

    expect(local.data[VAULT_KEY]).toBe(remotePayload)
    expect(local.data[APPLIED_REV_KEY]).toBe(4)
    // 远端 settings 整体采用但开关位保留本端值
    expect(JSON.parse(local.data[SETTINGS_KEY] as string)).toEqual({ syncEnabled: true, theme: 'dark' })
  })

  it('F6 远端明文 payload 结构非法：拒绝落盘（vault 原样、推进 appliedRev 并置 invalid，无重拉循环）', async () => {
    const localPlain = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 1 })
    const { local } = installChrome(
      {
        [VAULT_KEY]: localPlain,
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [APPLIED_REV_KEY]: 1,
      },
      // entries 为对象而非数组：能过 JSON.parse 但过不了 validateVaultObject
      remotePush(JSON.stringify({ version: 2, entries: { uuid: 'x' }, tags: [], updatedAt: 2 }), 2),
    )

    await pullSyncIfNewer()

    // 毒 payload 未落盘：vault 原样保留，仅记账 rev 防重拉循环
    expect(local.data[VAULT_KEY]).toBe(localPlain)
    expect(local.data[APPLIED_REV_KEY]).toBe(2)
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'invalid' })

    await pullSyncIfNewer()
    expect(local.data[VAULT_KEY]).toBe(localPlain)
    expect(local.data[APPLIED_REV_KEY]).toBe(2)
  })

  it('F14 远端明文 + 本机已加密：拒绝降级（不覆写 vault、不删 security，推进 appliedRev 并置 conflict）', async () => {
    const localEncrypted = JSON.stringify({ v: 1, enc: true, dataNonce: 'n0nce', ciphertext: 'c1ph3r' })
    const { local } = installChrome(
      {
        [VAULT_KEY]: localEncrypted,
        [SECURITY_KEY]: '{"wrapped":"kek","nonce":"n"}',
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [APPLIED_REV_KEY]: 1,
      },
      remotePush(JSON.stringify({ entries: ['attacker-controlled-plain'] }), 2),
    )

    await pullSyncIfNewer()

    // 本端加密态原样保留：vault 未被明文覆盖，SECURITY_KEY 未被移除
    expect(local.data[VAULT_KEY]).toBe(localEncrypted)
    expect(local.data[SECURITY_KEY]).toBe('{"wrapped":"kek","nonce":"n"}')
    // 记账本次拒绝：appliedRev 推进至远端 rev，置 conflict 状态
    expect(local.data[APPLIED_REV_KEY]).toBe(2)
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'conflict' })

    // 同 rev 再次拉取：appliedRev 已记账 → 无重拉循环，状态保持
    await pullSyncIfNewer()
    expect(local.data[VAULT_KEY]).toBe(localEncrypted)
    expect(local.data[SECURITY_KEY]).toBe('{"wrapped":"kek","nonce":"n"}')
    expect(local.data[APPLIED_REV_KEY]).toBe(2)
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'conflict' })
  })
})
