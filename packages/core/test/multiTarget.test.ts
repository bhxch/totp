import { describe, expect, it } from 'vitest'
import { createBackupEnvelope, KDF_PROFILES, openBackupEnvelope } from '../src/backup/envelope'
import { pushEnvelope, syncMultipleTargets } from '../src/cloud/multiTarget'
import { sha256Hex } from '../src/cloud/syncOrchestrator'
import type { CloudBackend } from '../src/cloud/backend'

const PATH = 'p'
const PW = 'pw'
const A = JSON.stringify({ version: 2, entries: [{ label: 'A' }], tags: [], updatedAt: 1 })
const B = JSON.stringify({ version: 2, entries: [{ label: 'B' }], tags: [], updatedAt: 2 })
const bytesOf = (s: string) => new TextEncoder().encode(s)

/** 内存 fake 后端：多目标各持独立 store，可预置初始内容；putCount 供断言收敛轮是否重推 */
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
  it('上传并回读校验：hash 为上传信封字节的摘要（cloudRev 口径），store 有对象且可解开为原文', async () => {
    const backend = fakeBackend()
    const pushed = await pushEnvelope({ backend, path: PATH, vaultJson: A, password: PW })
    const stored = backend.store.get(PATH)!
    expect(stored).toBeDefined()
    expect(pushed.hash).toBe(await sha256Hex(stored))
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
      // profile 透传：pass1 上传与收敛回推的信封均按注入档位生成
      profile: 'fast',
    })
    expect(r.adopted).toBe(true)
    expect(r.finalVaultJson).toBe(B)
    // 目标1（原空）被回推 B，基线为回推后服务器现字节的摘要
    await expectOpensTo(b1.store.get(PATH)!, PW, B)
    // 收敛回推透传 profile：回推信封以 fast 档展开参数落盘
    const converged = JSON.parse(new TextDecoder().decode(b1.store.get(PATH)!)) as { kdf: { profile: string; m: number } }
    expect(converged.kdf.profile).toBe('fast')
    expect(converged.kdf.m).toBe(KDF_PROFILES.fast.m)
    expect(r.results[0]!.outcome!.action).toBe('uploaded')
    expect(r.hashes['fake1']).toBe(await sha256Hex(b1.store.get(PATH)!))
    // 采纳源 t2 基线已等于赢家（downloaded 的 hash 即远端字节摘要）→ 收敛轮跳过，不被重推
    expect(b2.putCount).toBe(0)
    expect(r.hashes['fake2']).toBe(await sha256Hex(b2.store.get(PATH)!))
  })

  it('远端存 envelope 且内容与基线一致 → 现状走 uploaded 重传（in-sync 判据生产不可达，去重由宿主门承担）', async () => {
    // 生产形态：远端恒为 envelope 密文。in-sync 分支判据 remoteHash === sha256(vaultJson) 拿密文摘要
    // 与本地明文摘要比较，永不相等——本用例锁定现状行为：基线一致也全量重传（审查建议 5：远端 mock
    // 一律用 envelope 密文，防「远端存明文」假 in-sync 回归）。该路径的去重已由宿主自动通道的
    // 明文内容 hash 门承担（cloudRunner，见 packages/ui/src/components/cloudRunner.ts）
    const remote = await envelopeBytesOf(A, PW)
    const b = fakeBackend(remote)
    const r = await syncMultipleTargets({
      targets: [{ key: 'k', backend: b, path: PATH, hash: await sha256Hex(remote) }],
      vaultJson: A,
      password: PW,
    })
    expect(r.adopted).toBe(false)
    expect(r.results[0]!.outcome!.action).toBe('uploaded')
    expect(b.putCount).toBe(1)
    // 重传后远端可解开为 A，基线为新信封字节摘要
    await expectOpensTo(b.store.get(PATH)!, PW, A)
    expect(r.hashes['k']).toBe(await sha256Hex(b.store.get(PATH)!))
  })

  it('双目标远端均 envelope 且各自基线一致 → 两目标各自 uploaded，编排层无内容级去重（现状防回归哨兵）', async () => {
    // envelope 含随机盐：两目标密文字节不同但内容同为 A；各自基线均与远端一致仍各重传一次
    // （编排层无「未变→跳过」短路），去重已由宿主明文 hash 门承担（见 cloudRunner hash 门）
    const r1 = await envelopeBytesOf(A, PW)
    const r2 = await envelopeBytesOf(A, PW)
    const b1 = fakeBackend(r1)
    const b2 = fakeBackend(r2)
    const r = await syncMultipleTargets({
      targets: [
        { key: 'k1', backend: b1, path: PATH, hash: await sha256Hex(r1) },
        { key: 'k2', backend: b2, path: PATH, hash: await sha256Hex(r2) },
      ],
      vaultJson: A,
      password: PW,
    })
    expect(r.adopted).toBe(false)
    expect(r.results[0]!.outcome!.action).toBe('uploaded')
    expect(r.results[1]!.outcome!.action).toBe('uploaded')
    expect(b1.putCount).toBe(1)
    expect(b2.putCount).toBe(1)
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

  it('pass1 失败的目标在收敛回推成功后改写为 uploaded 且清除残留 error', async () => {
    // flaky 仅首次 get 抛错：pass1 上传回读失败；收敛回推时 get 已恢复，可成功
    const flaky = fakeBackend()
    let getCalls = 0
    flaky.get = async (p) => {
      getCalls++
      if (getCalls === 1) throw new Error('网络错误')
      return flaky.store.get(p) ?? null
    }
    const newer = fakeBackend(await envelopeBytesOf(B, PW))
    const r = await syncMultipleTargets({
      targets: [
        { key: 'flaky', backend: flaky, path: PATH, hash: null },
        { key: 'newer', backend: newer, path: PATH, hash: null },
      ],
      vaultJson: A,
      password: PW,
    })
    expect(r.adopted).toBe(true)
    expect(r.finalVaultJson).toBe(B)
    // pass1 失败（outcome null + error），收敛回推成功后改写为 uploaded 且 error 清除
    expect(r.results[0]!.outcome!.action).toBe('uploaded')
    expect(r.results[0]!.error).toBeUndefined()
    expect(r.results[0]!.convergeError).toBeUndefined()
    await expectOpensTo(flaky.store.get(PATH)!, PW, B)
    expect(r.hashes['flaky']).toBe(await sha256Hex(flaky.store.get(PATH)!))
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

  it('C1 基线漂移但解密内容一致 → in-sync 零处理：不采纳、无副本、不触发收敛回推', async () => {
    // 对端重推同内容（密文随机盐 → 字节摘要必变）：修复前 k1 走 conflict-resolved → 采纳 A →
    // 终局把 A 回推 k2（无意义云端写）。修复后 k1 in-sync 仅刷基线，无赢家 → 无收敛轮。
    const b1 = fakeBackend(await envelopeBytesOf(A, PW))
    const b2 = fakeBackend()
    const copies: string[] = []
    const r = await syncMultipleTargets({
      targets: [
        { key: 'k1', backend: b1, path: PATH, hash: 'stale' }, // 基线 ≠ 远端字节（漂移），内容同为 A
        { key: 'k2', backend: b2, path: PATH, hash: null },
      ],
      vaultJson: A,
      password: PW,
      onConflictBackup: (key) => {
        copies.push(key)
      },
    })
    expect(r.adopted).toBe(false)
    expect(r.results[0]!.outcome!.action).toBe('in-sync')
    expect(r.results[0]!.error).toBeUndefined()
    expect(copies).toHaveLength(0)
    expect(b1.putCount).toBe(0) // 零重推、零收敛回推
    expect(r.hashes['k1']).toBe(await sha256Hex(b1.store.get(PATH)!)) // 基线=远端字节摘要（供宿主回写）
    // 空云目标照常上传（推通道职责不受影响）
    expect(r.results[1]!.outcome!.action).toBe('uploaded')
    await expectOpensTo(b2.store.get(PATH)!, PW, A)
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

  it('基线一致目标（envelope 重传态）在 adopted 终局被回推（基线 ≠ 赢家）', async () => {
    const r1 = await envelopeBytesOf(A, PW)
    const b1 = fakeBackend(r1)
    const b2 = fakeBackend(await envelopeBytesOf(B, PW))
    const r = await syncMultipleTargets({
      targets: [
        { key: 't1', backend: b1, path: PATH, hash: await sha256Hex(r1) },
        { key: 't2', backend: b2, path: PATH, hash: null },
      ],
      vaultJson: A,
      password: PW,
    })
    expect(r.adopted).toBe(true)
    expect(r.finalVaultJson).toBe(B)
    // t1 远端为 envelope(A) 且基线一致：pass1 现状仍重传（无内容级短路，去重由宿主门承担），
    // 基线变为新信封摘要 ≠ 赢家 → 收敛回推 B 且 outcome 改写 uploaded，基线为回推后现字节摘要
    expect(b1.putCount).toBe(2)
    expect(r.results[0]!.outcome!.action).toBe('uploaded')
    expect(r.hashes['t1']).toBe(await sha256Hex(b1.store.get(PATH)!))
    await expectOpensTo(b1.store.get(PATH)!, PW, B)
    // 采纳源 t2 基线已等于赢家（downloaded 的 hash 即远端字节摘要）→ 收敛轮跳过，不被重推
    expect(b2.putCount).toBe(0)
    expect(r.hashes['t2']).toBe(await sha256Hex(b2.store.get(PATH)!))
  })

  it('空 targets 数组 → adopted=false、finalVaultJson 为入参、results/hashes 为空', async () => {
    const r = await syncMultipleTargets({ targets: [], vaultJson: A, password: PW })
    expect(r.adopted).toBe(false)
    expect(r.finalVaultJson).toBe(A)
    expect(r.results).toEqual([])
    expect(r.hashes).toEqual({})
  })

  it('收敛回推失败：convergeError 记录原因、outcome 保持 null 且 pass1 error 保留', async () => {
    // 云端不存在 → pass1 走上传分支；put/回读均坏 → pass1 error；收敛回推 pushEnvelope 再次 put 抛错
    const bad = fakeBackend()
    bad.put = async () => {
      throw new Error('put坏')
    }
    const newer = fakeBackend(await envelopeBytesOf(B, PW))
    const r = await syncMultipleTargets({
      targets: [
        { key: 'bad', backend: bad, path: PATH, hash: null },
        { key: 'newer', backend: newer, path: PATH, hash: null },
      ],
      vaultJson: A,
      password: PW,
    })
    expect(r.adopted).toBe(true)
    expect(r.finalVaultJson).toBe(B)
    expect(r.results[0]!.outcome).toBeNull()
    expect(r.results[0]!.error).toContain('put坏')
    expect(r.results[0]!.convergeError).toContain('put坏')
    expect(r.hashes['newer']).toBeDefined()
    expect(r.hashes['bad']).toBeUndefined()
  })
})
