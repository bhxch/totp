/**
 * syncEngine 编排层测试：chrome.storage（local/sync）以内存实现注入 globalThis.chrome
 * （P0 起经公共 fixture test/helpers/chromeShim.ts，原 makeArea 手写 shim 已收敛），
 * 无法自动化真实 chrome.sync（需浏览器账号云），故在编排逻辑层面验证：
 * - meta.rev > appliedRev 时 pushSync 先走 pullOnce 应用远端、再重读本端推送（不覆盖他端较新数据）
 * - pull 未成功应用（分片缺失/损坏）时放弃推送，宁缺勿以陈旧覆盖
 * - rev 已最新 / 远端从未推送 / 同步关闭时的既有语义保持
 * - quota/pct 状态、密文拒推、storage 抛错降级、mkSerialized 串行化（P2a 补全）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  base64ToBytes, bytesToBase64, chunkKey, chunksToMeta, splitIntoChunks, type SyncChunk,
} from '@totp/core'
import {
  markSyncOff, needsPullBeforePush, pullSyncIfNewer, pushSync, SYNC_STATUS_KEY,
} from '../src/syncEngine'
import { installChromeShim, type ChromeShim, type Store } from './helpers/chromeShim'

// ext 是模块导入期快照，逐用例 globalThis.chrome 注入需经惰性桥透传（批⑧ Task 10，见 helper 注释）
vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())

const VAULT_KEY = 'vault'
const SECURITY_KEY = 'security'
const SETTINGS_KEY = 'settings'
const META_KEY = 'sync:meta'
const APPLIED_REV_KEY = 'sync:appliedRev'

/** chrome.storage（local/sync）内存实现注入：初始内容注入即落盘，data 直读可断言 */
function installChrome(localInit: Store = {}, syncInit: Store = {}): ChromeShim {
  return installChromeShim({ local: localInit, sync: syncInit })
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

  it('settings 坏 JSON（读开关即损坏）→ pullSyncIfNewer 静默短路（默认关闭语义）', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 })
    const { local, sync } = installChrome(
      { [VAULT_KEY]: JSON.stringify({ entries: ['old'] }), [SETTINGS_KEY]: '{broken-settings' },
      { ...remotePush(remotePayload, 5) },
    )
    await pullSyncIfNewer()
    expect(local.data[VAULT_KEY]).toBe(JSON.stringify({ entries: ['old'] }))
    expect(local.data[SYNC_STATUS_KEY]).toBeUndefined() // 短路：连状态都不写
    expect(sync.data[META_KEY]).toMatchObject({ rev: 5 })
  })

  it('分片合并成功但 payload 非 JSON → error（JSON.parse 失败分支）', async () => {
    const { local } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['old'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      { ...remotePush('not-json-payload', 2) },
    )
    await pullSyncIfNewer()
    expect(local.data[VAULT_KEY]).toBe(JSON.stringify({ entries: ['old'] }))
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'error' })
  })

  it('密文 vault 缺 sync:security（不一致态）→ error 拒应用：vault/appliedRev 原样', async () => {
    const encryptedPayload = JSON.stringify({ v: 1, enc: true, dataNonce: 'n0nce', ciphertext: 'c1ph3r' })
    const { local } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['old'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [APPLIED_REV_KEY]: 1,
      },
      // 远端密文分片在、sync:security 缺失：拉取后无人可解，属不一致态
      { ...remotePush(encryptedPayload, 2) },
    )

    await pullSyncIfNewer()

    expect(local.data[VAULT_KEY]).toBe(JSON.stringify({ entries: ['old'] })) // 未被密文覆盖
    expect(local.data[SECURITY_KEY]).toBeUndefined()
    expect(local.data[APPLIED_REV_KEY]).toBe(1) // 记账不推进（非 F14 的「推进+conflict」形态）
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'error' })
  })

  it('pull 端 sync 区读取抛错（IO 故障）→ error 状态不向上抛', async () => {
    const shim = installChrome(
      { [VAULT_KEY]: JSON.stringify({ entries: ['old'] }), [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }) },
      {},
    )
    shim.sync.get = async () => {
      throw new Error('sync area IO error')
    }

    await pullSyncIfNewer()

    expect(shim.local.data[VAULT_KEY]).toBe(JSON.stringify({ entries: ['old'] }))
    expect(shim.local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'error' })
  })

  it('pull 端 local 区写入抛错（IO 故障）→ error 状态不向上抛', async () => {
    const shim = installChrome(
      { [VAULT_KEY]: JSON.stringify({ entries: ['old'] }), [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }) },
      remotePush(JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 }), 2),
    )
    shim.local.set = async () => {
      throw new Error('local quota exceeded')
    }

    await pullSyncIfNewer()

    // pull 主路径写盘失败：vault 未应用（无 error 状态落盘通道——连状态写本身也失败，不扩散）
    expect(shim.local.data[VAULT_KEY]).toBe(JSON.stringify({ entries: ['old'] }))
  })

  it('同步关闭时 pullSyncIfNewer 不拉取（显式退出，防他端推送覆写未开启同步的本端数据）', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 })
    const { local, sync } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['local-keep'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: false }),
      },
      { ...remotePush(remotePayload, 9) },
    )

    await pullSyncIfNewer()

    expect(local.data[VAULT_KEY]).toBe(JSON.stringify({ entries: ['local-keep'] }))
    expect(sync.data[META_KEY]).toMatchObject({ rev: 9 }) // 远端原样
    expect(local.data[APPLIED_REV_KEY]).toBeUndefined()
  })

  it('sync:meta 形状非法（rev 非整数）→ readMeta 拒识：pull 无操作（零状态写）', async () => {
    const { local } = installChrome(
      { [VAULT_KEY]: JSON.stringify({ entries: ['old'] }), [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }) },
      {
        [META_KEY]: { rev: 2.5, updatedAt: 1, total: 1 }, // rev 非整数 → readMeta null
        [chunkKey(0, 1)]: { rev: 2, updatedAt: 1, part: 0, total: 1, data: b64('x') },
      },
    )
    await pullSyncIfNewer()
    expect(local.data[VAULT_KEY]).toBe(JSON.stringify({ entries: ['old'] }))
    expect(local.data[SYNC_STATUS_KEY]).toBeUndefined()
  })

  it('appliedRev 缺失（新设备）且远端有 meta → push 前先拉取应用（远端 rev>0 恒判有未应用更新）', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 7 })
    const { local, sync } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['fresh-device'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      { ...remotePush(remotePayload, 5) },
    )

    await pushSync()

    // 前置 pull 生效（appliedRev 缺失按 0 < 5），随后推送 rev=6
    expect(local.data[VAULT_KEY]).toBe(remotePayload)
    expect(sync.data[META_KEY]).toMatchObject({ rev: 6 })
  })

  it('分片同版本过滤：旧 rev 残片与新版分片共存 → 只合并与 meta 同 rev/updatedAt/total 的分片', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 })
    // 残留 rev2 旧分片（若混入会因 total/rev 不一致致 mergeChunks null）
    const stale: Store = {
      [chunkKey(1, 2)]: { rev: 2, updatedAt: 1000, part: 1, total: 2, data: b64('stale-half') } satisfies SyncChunk,
    }
    const { local } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['old'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [APPLIED_REV_KEY]: 1,
      },
      { ...stale, ...remotePush(remotePayload, 3, 2000) },
    )

    await pullSyncIfNewer()

    expect(local.data[VAULT_KEY]).toBe(remotePayload) // 同版本分片合并成功，残片被排除
    expect(local.data[APPLIED_REV_KEY]).toBe(3)
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'ok' })
  })

  it('分片区形状不符条目（null 值/字段缺失对象）不参与合并（isSyncChunk 过滤）', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 })
    const junk: Store = {
      'sync:v1:junk': null,
      'sync:v1:junk2': { rev: 'x', updatedAt: 1, part: 0, total: 1, data: 'aGk=' },
    }
    const { local } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['old'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      { ...junk, ...remotePush(remotePayload, 2) },
    )

    await pullSyncIfNewer()

    expect(local.data[VAULT_KEY]).toBe(remotePayload)
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'ok' })
  })

  it('远端 settings 键为坏 JSON → merge 退化整体采用远端原串（catch 分支，实现行为锚定）', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 })
    const { local } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['old'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      { ...remotePush(remotePayload, 2), 'sync:settings': '{broken-remote-settings' },
    )

    await pullSyncIfNewer()

    // 注意：JSON.parse 失败点在 remoteRaw（坏串原样返回），本端 settings 被整体替换为坏串——
    // 盘点「本端 settings 损坏退化整体采用」在现有 readSyncEnabled 前置门下不可达（本端损坏恒拉取短路），见汇报
    expect(local.data[SETTINGS_KEY]).toBe('{broken-remote-settings')
    expect(local.data[VAULT_KEY]).toBe(remotePayload)
  })

  it('明文 → 明文正向路径：本端无 security 时拉取明文并跟随移除 security 键（同态语义）', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 3 })
    const shim = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['old-plain'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [APPLIED_REV_KEY]: 2,
      },
      { ...remotePush(remotePayload, 3), 'sync:settings': JSON.stringify({ syncEnabled: true, theme: 'dark' }) },
    )

    await pullSyncIfNewer()

    expect(shim.local.data[VAULT_KEY]).toBe(remotePayload)
    expect(shim.local.data[SETTINGS_KEY]).toBe(JSON.stringify({ syncEnabled: true, theme: 'dark' }))
    expect(shim.local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'ok' })
    // removes 通道被触达：security 键移除（本端本无该键，remove 幂等但调用发生=同态语义在位）
    expect(shim.local.calls.remove).toBe(1)
  })

  it('push 后同步区占用 >90% 配额 → quota 状态 + pct 百分比（I57）', async () => {
    const shim = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['data'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      {},
    )
    shim.sync.QUOTA_BYTES = 100 // 收缩配额：推送后占用必然超过 90%

    await pushSync()

    const status = shim.local.data[SYNC_STATUS_KEY] as { state: string; pct?: number }
    expect(status.state).toBe('quota')
    expect(status.pct).toBe(Math.round((await shim.sync.getBytesInUse()) / 100 * 100))
    expect(status.pct).toBeGreaterThan(90)
  })

  it('getBytesInUse 抛错 → pull 状态 ok 但 pct 缺省（setSyncStatus 容错，UI 不显示百分比）', async () => {
    const shim = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['old'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      remotePush(JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 }), 2),
    )
    shim.sync.getBytesInUse = async () => {
      throw new Error('getBytesInUse not supported')
    }

    await pullSyncIfNewer()

    const status = shim.local.data[SYNC_STATUS_KEY] as { state: string; pct?: number }
    expect(status.state).toBe('ok') // pull 主流程成功
    expect('pct' in status).toBe(false) // 配额探测失败不阻断，pct 缺省
  })

  it('push 阶段 getBytesInUse 抛错（quota 判定）→ error 状态（实现行为：判定失败按异常收敛）', async () => {
    const shim = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['data'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      {},
    )
    shim.sync.getBytesInUse = async () => {
      throw new Error('getBytesInUse not supported')
    }

    await pushSync()

    // pushOnce 自身的 inUse 探测在 try 块内：抛错走整体 catch → error（与 setSyncStatus 的 pct 容错不同层）
    expect(shim.local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'error' })
    expect(shim.sync.data[META_KEY]).toMatchObject({ rev: 1 }) // 推送本身已完成
  })

  it('push 全程异常（sync.set 抛错）→ error 状态；恢复后下一轮照常运行', async () => {
    const shim = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['data'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      {},
    )
    const realSet = shim.sync.set.bind(shim.sync)
    let setFail = true
    shim.sync.set = async (obj: Store) => {
      if (setFail) throw new Error('sync quota write failed')
      return realSet(obj)
    }

    await expect(pushSync()).resolves.toBeUndefined() // 吞错不 reject
    expect(shim.local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'error' })

    // 恢复后再次 push：走完整流程（meta rev=1 落盘、状态回 ok）
    setFail = false
    await pushSync()
    expect((shim.sync.data[META_KEY] as { rev: number }).rev).toBe(1)
    expect(shim.local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'ok' })
  })

  it('本端无 vault → 不推送（无 payload 可推，零 sync 区写）', async () => {
    const { local, sync } = installChrome(
      { [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }) },
      {},
    )
    await pushSync()
    expect(sync.data[META_KEY]).toBeUndefined()
    expect(local.data[APPLIED_REV_KEY]).toBeUndefined()
  })

  it('密文 vault 且 local security 缺失 → error 拒推（防密文 vault 落 sync 区后无人可解）', async () => {
    const encrypted = JSON.stringify({ v: 1, enc: true, dataNonce: 'n0nce', ciphertext: 'c1ph3r' })
    const { local, sync } = installChrome(
      { [VAULT_KEY]: encrypted, [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }) },
      {},
    )
    await pushSync()
    expect(sync.data[META_KEY]).toBeUndefined() // 未推送
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'error' })
  })

  it('vault 非 JSON 且无 security（明文路径放行）→ 照常推送', async () => {
    const { local, sync } = installChrome(
      { [VAULT_KEY]: 'plain-not-json{{', [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }) },
      {},
    )
    await pushSync()
    expect(sync.data[META_KEY]).toMatchObject({ rev: 1 })
    expect(local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'ok' })
  })

  it('security 存在才写 sync:security；settings 在场则随批同步（pushSync 前置 readSyncEnabled 语义下 settings 恒在场）', async () => {
    const { sync } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['n1'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [SECURITY_KEY]: '{"wrapped":"k"}',
      },
      {},
    )
    await pushSync()
    expect(sync.data[META_KEY]).toMatchObject({ rev: 1 })
    expect(sync.data['sync:settings']).toBe(JSON.stringify({ syncEnabled: true }))
    expect(sync.data['sync:security']).toBe('{"wrapped":"k"}')
  })

  it('明文 vault 无 security → 推送不含 sync:security（pull 端同态移除语义的对侧）', async () => {
    const { sync } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['plain'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      {},
    )
    await pushSync()
    expect(sync.data['sync:security']).toBeUndefined()
  })

  it('推送后 stale 清理：旧 total 分片键被移除（total 收缩场景）', async () => {
    // 远端曾以 total=2 推送 rev1；本端 applied=1 直推 rev2（total=1）→ 旧 chunk 1/2 成 stale
    const oldPayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 1 })
    const oldChunks = splitIntoChunks(oldPayload, 1, 1000, 10) // 强制 2 片
    const syncInit: Store = { [META_KEY]: chunksToMeta(oldChunks) }
    for (const c of oldChunks) syncInit[chunkKey(c.part, c.total)] = c
    const { sync } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['n1'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
        [APPLIED_REV_KEY]: 1,
      },
      syncInit,
    )

    await pushSync()

    expect(sync.data[META_KEY]).toMatchObject({ rev: 2 })
    expect(sync.data[chunkKey(1, 2)]).toBeUndefined() // stale 已清理
    expect(sync.data[chunkKey(0, 1)]).toBeDefined()
  })

  it('markSyncOff：写 off 状态（无 pct 探测），供 UI 显示「未启用」', async () => {
    const shim = installChrome({}, {})
    await markSyncOff()
    const status = shim.local.data[SYNC_STATUS_KEY] as { state: string; at?: number; pct?: number }
    expect(status.state).toBe('off')
    expect(typeof status.at).toBe('number')
    expect(shim.sync.calls.getBytesInUse).toBe(0) // 非 ok/quota 不探测配额
  })

  it('mkSerialized 并发重入：in-flight 期间重入立即返回，首轮跑完自动补跑一轮（pending 语义）', async () => {
    const shim = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['n1'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      {},
    )
    // 拖慢首轮（readSyncEnabled 的 local.get 落在在途窗口内），让第二次 pushSync 调用命中 inFlight
    const origGet = shim.local.get.bind(shim.local)
    let getCalls = 0
    shim.local.get = async (keys: string | string[] | null) => {
      if (getCalls++ === 0) await new Promise((r) => setTimeout(r, 30))
      return origGet(keys)
    }

    const p1 = pushSync() // 首轮在途
    const p2 = pushSync() // 重入：立即 resolve（pending 记账）
    await expect(p2).resolves.toBeUndefined()
    await p1
    // pending 补跑：第二轮推送 rev2（首轮推 rev1）
    await vi.waitFor(() => {
      expect((shim.sync.data[META_KEY] as { rev: number }).rev).toBe(2)
    })
  })

  it('mkSerialized run 抛错 → inFlight 复位：后续调用可正常运行（不被在途标志卡死）', async () => {
    const shim = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['n1'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true }),
      },
      {},
    )
    // readSyncEnabled 的 local.get 在 mkSerialized run 闭包内：抛错使 run 本体抛出（非 pushOnce 内部吞错）
    const origGet = shim.local.get.bind(shim.local)
    let getFail = true
    shim.local.get = async (keys: string | string[] | null) => {
      if (getFail) throw new Error('IO dead')
      return origGet(keys)
    }
    await expect(pushSync()).resolves.toBeUndefined() // mkSerialized 吞错，inFlight 复位

    // 恢复存储：下一次调用必须真正执行（若 inFlight 未复位会直接短路返回，无任何写入）
    getFail = false
    await pushSync()
    expect((shim.sync.data[META_KEY] as { rev: number }).rev).toBe(1)
    expect(shim.local.data[SYNC_STATUS_KEY]).toMatchObject({ state: 'ok' })
  })
})
