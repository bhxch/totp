import { describe, expect, it } from 'vitest'
import type { CloudBackend } from '../src/cloud/backend'
import { createBackupEnvelope, openBackupEnvelope } from '../src/backup/envelope'
import { sha256Hex, syncWithCloud } from '../src/cloud/syncOrchestrator'

const PATH = 'totp-backup.totpbackup'
const PASSWORD = '口令123'
const LOCAL_VAULT = JSON.stringify({ version: 1, entries: [{ uuid: 'local' }], groups: [], updatedAt: 1 })
const REMOTE_VAULT = JSON.stringify({ version: 1, entries: [{ uuid: 'remote' }], groups: [], updatedAt: 2 })
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
    // 分支不可达，编排层并无「内容未变→跳过」去重；生产去重由宿主自动通道的明文内容 hash 门
    // 承担（cloudRunner/desktop autoBackup，属后续任务）。下一用例为 envelope 真实形态的现状行为。
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
    // 判据不可达 → 现状每轮全量重传；该路径的去重修复由宿主明文 hash 门承担（后续任务）
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
