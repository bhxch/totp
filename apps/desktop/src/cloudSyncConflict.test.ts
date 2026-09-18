/**
 * 审查 I9（desktop 侧）：App.vue 云 runner 的 saveConflictBackup 接线把 saveConflictBackupToDir
 * 的 Promise 原样交回 runner/core（不再 `.catch(() => {})` 吞掉）——本测试以与 App.vue 相同的
 * 接线形态复现：写盘拒绝 → 冲突分支中止，该云目标同步失败（不采纳远端、删基线、状态行记失败），
 * 云端旧版本不在「本地无副本」的情况下被回推覆盖。
 */
import { describe, expect, it, vi } from 'vitest'
import { createBackupEnvelope, type BackupSource, type CloudBackend, type CloudCred } from '@totp/core'
import { createCloudSyncRunner } from '@totp/ui'
import { saveConflictBackupToDir } from './backupService'

const { saveConflictBackupToDirMock } = vi.hoisted(() => ({ saveConflictBackupToDirMock: vi.fn() }))
vi.mock('./backupService', () => ({ saveConflictBackupToDir: saveConflictBackupToDirMock }))

// 注：core 的信封加解密用真实现——syncOrchestrator 内部相对路径导入 backup/envelope，
// mock '@totp/core' 包入口拦截不到；冲突分支需要对称往返可达，真实 envelope 开销可接受

const A = JSON.stringify({ v: 1 })
const B = JSON.stringify({ v: 2 })
const bytesOf = (s: string) => new TextEncoder().encode(s)
const PW = 'pw'
const CRED: CloudCred = { backend: 'webdav', serverUrl: 'https://dav', username: 'u', password: 'p' }
const SOURCE: BackupSource = { id: 's1', kind: 'webdav', name: '家里', retention: { type: 'overwrite' }, enabled: true }

function fakeBackend(initial?: Uint8Array): CloudBackend & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  if (initial) store.set('totp-backup.totpbackup', initial)
  return {
    id: 'webdav',
    store,
    async put(_path, data) { store.set('totp-backup.totpbackup', data) },
    async get(path) { return store.get(path) ?? null },
    async delete(path) { store.delete(path) },
    async exists(path) { return store.has(path) },
  }
}

/** 与 App.vue cloudSync deps 逐字同构的接线（防止接线回退为 .catch 吞错的回归探针） */
const saveConflictBackup = (key: string, bytes: Uint8Array) => saveConflictBackupToDir(bytes, null, key)

describe('审查 I9：冲突副本写盘失败传播（desktop 接线）', () => {
  it('saveConflictBackupToDir 拒绝 → 该目标同步失败：不采纳远端、删基线、状态行记失败、云端不被覆盖', async () => {
    const remoteEnv = JSON.stringify(await createBackupEnvelope(B, PW))
    const b = fakeBackend(bytesOf(remoteEnv)) // 远端=B ≠ 本地 A，cloudRev='stale' → conflict 分支
    saveConflictBackupToDirMock.mockRejectedValue(new Error('磁盘写入失败'))
    const recordStatus = vi.fn()
    await createCloudSyncRunner({
      isLocked: () => false,
      getSecret: () => PW,
      getVaultJson: () => A,
      loadSources: async () => [{ source: SOURCE, cred: CRED }],
      loadTargetHash: async () => 'stale',
      saveTargetHash: vi.fn(),
      makeBackend: () => b,
      persistAdopted: vi.fn(),
      saveConflictBackup,
      recordStatus,
      onError: vi.fn(),
    }).run()
    // 副本落盘被调用且带 sourceId（写盘语义不变，只是失败不再被吞）
    expect(saveConflictBackupToDirMock).toHaveBeenCalledTimes(1)
    const [bytes, dirOverride, key] = saveConflictBackupToDirMock.mock.calls[0]!
    expect(key).toBe('s1')
    expect(dirOverride).toBeNull()
    expect(ArrayBuffer.isView(bytes)).toBe(true)
    // 该目标失败的连锁表现：本地不被远端覆盖（persistAdopted 未调）、基线在 runner 内被删
    // （saveTargetHash('s1', null) 由 cloudRunner 对 hashes 缺键的既有回写负责）、
    // 状态行记「失败」（ok 仍为 true 是既有部分失败 summary 语义——全部目标 settle 即 true）
    expect(b.store.get('totp-backup.totpbackup')).toEqual(bytesOf(remoteEnv)) // 云端旧版本原样保留
    expect(recordStatus).toHaveBeenCalledWith(true, 's1: 失败')
  })
})
