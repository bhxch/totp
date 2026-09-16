import { describe, expect, it } from 'vitest'
import { createBackupEnvelope, openBackupEnvelope } from '../src/backup/envelope'
import { pushEnvelope, syncMultipleTargets } from '../src/cloud/multiTarget'
import { sha256Hex } from '../src/cloud/syncOrchestrator'
import type { CloudBackend } from '../src/cloud/backend'

const PATH = 'p'
const PW = 'pw'
const A = JSON.stringify({ version: 1, entries: [{ label: 'A' }], groups: [], updatedAt: 1 })
const B = JSON.stringify({ version: 1, entries: [{ label: 'B' }], groups: [], updatedAt: 2 })
const bytesOf = (s: string) => new TextEncoder().encode(s)

/** 内存 fake 后端：多目标各持独立 store，可预置初始内容 */
function fakeBackend(initial?: Uint8Array): CloudBackend & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  if (initial) store.set(PATH, initial)
  return {
    store,
    id: 'webdav',
    async put(path, data) {
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
}

/** 预置远端 envelope：vaultJson 加密后的 JSON 字节 */
async function envelopeBytesOf(vaultJson: string, password: string): Promise<Uint8Array> {
  return bytesOf(JSON.stringify(await createBackupEnvelope(vaultJson, password)))
}

/** 断言云端字节可用口令解开为期望的 vault 明文 */
async function expectOpensTo(bytes: Uint8Array, password: string, expected: string): Promise<void> {
  const env = JSON.parse(new TextDecoder().decode(bytes))
  expect(await openBackupEnvelope(env, password)).toBe(expected)
}

describe('pushEnvelope', () => {
  it('上传并回读校验：hash 为 vault 明文内容摘要，store 有对象且可解开为原文', async () => {
    const backend = fakeBackend()
    const pushed = await pushEnvelope({ backend, path: PATH, vaultJson: A, password: PW })
    expect(pushed.hash).toBe(await sha256Hex(bytesOf(A)))
    const stored = backend.store.get(PATH)!
    expect(stored).toBeDefined()
    // 回读校验已内建于 pushEnvelope：存储内容可同口令解开为 A
    await expectOpensTo(stored, PW, A)
    // envelopeJson 与存储字节一致
    expect(await sha256Hex(bytesOf(pushed.envelopeJson))).toBe(await sha256Hex(stored))
  })
})

describe('syncMultipleTargets', () => {
  it('本地新 → 双目标都 uploaded，两目标云端内容一致（解密后均为 A）', async () => {
    const b1 = fakeBackend()
    const b2 = fakeBackend()
    const r = await syncMultipleTargets({
      targets: [
        { key: 'k1', backend: b1, path: PATH, hash: null },
        { key: 'k2', backend: b2, path: PATH, hash: null },
      ],
      vaultJson: A,
      password: PW,
    })
    expect(r.adopted).toBe(false)
    expect(r.results).toHaveLength(2)
    expect(r.results[0]!.outcome!.action).toBe('uploaded')
    expect(r.results[1]!.outcome!.action).toBe('uploaded')
    // envelope 含随机盐/nonce，密文字节必然不同——「内容相等」按解密后语义断言
    await expectOpensTo(b1.store.get(PATH)!, PW, A)
    await expectOpensTo(b2.store.get(PATH)!, PW, A)
  })

  it('目标2云端较新 → 采纳并回推目标1（收敛）', async () => {
    const b1 = fakeBackend()
    const b2 = fakeBackend(await envelopeBytesOf(B, PW))
    const r = await syncMultipleTargets({
      targets: [
        { key: 'fake1', backend: b1, path: PATH, hash: null },
        { key: 'fake2', backend: b2, path: PATH, hash: null },
      ],
      vaultJson: A,
      password: PW,
    })
    expect(r.adopted).toBe(true)
    expect(r.finalVaultJson).toBe(B)
    // 目标1（原空）被回推 B
    await expectOpensTo(b1.store.get(PATH)!, PW, B)
    expect(r.results[0]!.outcome!.action).toBe('uploaded')
    expect(r.hashes['fake1']).toBe(await sha256Hex(bytesOf(B)))
  })

  it('全部 in-sync → 不重写（in-sync 需远端字节即本地明文内容）', async () => {
    const aHash = await sha256Hex(bytesOf(A))
    const b = fakeBackend(bytesOf(A))
    const r = await syncMultipleTargets({
      targets: [{ key: 'k', backend: b, path: PATH, hash: aHash }],
      vaultJson: A,
      password: PW,
    })
    expect(r.adopted).toBe(false)
    expect(r.results[0]!.outcome!.action).toBe('in-sync')
    expect(r.hashes['k']).toBe(aHash)
  })

  it('单目标失败不阻断：失败目标 outcome 为 null 且带 error，成功目标正常 uploaded', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络错误')
    }
    const good = fakeBackend()
    const r = await syncMultipleTargets({
      targets: [
        { key: 'bad', backend: bad, path: PATH, hash: null },
        { key: 'good', backend: good, path: PATH, hash: null },
      ],
      vaultJson: A,
      password: PW,
    })
    expect(r.results[0]!.outcome).toBeNull()
    expect(r.results[0]!.error).toContain('网络错误')
    expect(r.results[1]!.outcome!.action).toBe('uploaded')
    expect(r.adopted).toBe(false)
  })

  it('云端口令不符 → 该目标报错不采纳（localHash=null 时远端解不开直接抛错）', async () => {
    const b = fakeBackend(await envelopeBytesOf(A, 'other'))
    const r = await syncMultipleTargets({
      targets: [{ key: 'k', backend: b, path: PATH, hash: null }],
      vaultJson: A,
      password: PW,
    })
    expect(r.results[0]!.outcome).toBeNull()
    expect(r.results[0]!.error).toContain('口令')
    expect(r.adopted).toBe(false)
    expect(r.hashes['k']).toBeUndefined()
  })

  it('conflict-resolved 触发采纳并回推其他目标', async () => {
    const b1 = fakeBackend()
    const b2 = fakeBackend(await envelopeBytesOf(B, PW))
    const calls: Array<{ key: string; bytes: Uint8Array }> = []
    const r = await syncMultipleTargets({
      targets: [
        { key: 'k1', backend: b1, path: PATH, hash: null },
        { key: 'k2', backend: b2, path: PATH, hash: 'stale' },
      ],
      vaultJson: A,
      password: PW,
      onConflictBackup: (key, bytes) => {
        calls.push({ key, bytes })
      },
    })
    // t2 触发 conflict 流程，副本回调以目标 key 透传，副本为本地 A 的加密 envelope
    expect(calls).toHaveLength(1)
    expect(calls[0]!.key).toBe('k2')
    await expectOpensTo(calls[0]!.bytes, PW, A)
    expect(r.adopted).toBe(true)
    expect(r.finalVaultJson).toBe(B)
    await expectOpensTo(b1.store.get(PATH)!, PW, B)
  })

  it('onConflictBackup 透传目标 key', async () => {
    const b = fakeBackend(await envelopeBytesOf(B, PW))
    const keys: string[] = []
    const r = await syncMultipleTargets({
      targets: [{ key: 'only', backend: b, path: PATH, hash: 'stale' }],
      vaultJson: A,
      password: PW,
      onConflictBackup: (key) => {
        keys.push(key)
      },
    })
    expect(keys).toEqual(['only'])
    expect(r.adopted).toBe(true)
  })

  it('hashes 只含本轮处理成功的目标', async () => {
    const bad = fakeBackend()
    bad.get = async () => {
      throw new Error('网络错误')
    }
    const good = fakeBackend()
    const r = await syncMultipleTargets({
      targets: [
        { key: 'bad', backend: bad, path: PATH, hash: null },
        { key: 'good', backend: good, path: PATH, hash: null },
      ],
      vaultJson: A,
      password: PW,
    })
    expect(Object.keys(r.hashes)).toEqual(['good'])
  })

  it('in-sync 目标在 adopted 终局被回推（基线持旧内容 hash ≠ 赢家）', async () => {
    const aHash = await sha256Hex(bytesOf(A))
    const b1 = fakeBackend(bytesOf(A))
    const b2 = fakeBackend(await envelopeBytesOf(B, PW))
    const r = await syncMultipleTargets({
      targets: [
        { key: 't1', backend: b1, path: PATH, hash: aHash },
        { key: 't2', backend: b2, path: PATH, hash: null },
      ],
      vaultJson: A,
      password: PW,
    })
    expect(r.adopted).toBe(true)
    expect(r.finalVaultJson).toBe(B)
    // t1 原为 in-sync（持旧 A），基线 ≠ 赢家 → 回推 B 且 outcome 改写 uploaded
    expect(r.results[0]!.outcome!.action).toBe('uploaded')
    expect(r.hashes['t1']).toBe(await sha256Hex(bytesOf(B)))
    await expectOpensTo(b1.store.get(PATH)!, PW, B)
  })

  it('空 targets 数组 → adopted=false、finalVaultJson 为入参、results/hashes 为空', async () => {
    const r = await syncMultipleTargets({ targets: [], vaultJson: A, password: PW })
    expect(r.adopted).toBe(false)
    expect(r.finalVaultJson).toBe(A)
    expect(r.results).toEqual([])
    expect(r.hashes).toEqual({})
  })
})
