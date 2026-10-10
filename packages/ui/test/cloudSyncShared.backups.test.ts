import { describe, expect, it, vi } from 'vitest'
import type { CloudBackend } from '@totp/core'
import { listCloudBackups } from '../src/components/cloudSyncShared'

function backendOf(over: Partial<CloudBackend>): CloudBackend {
  return {
    id: 'webdav',
    put: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    ...over,
  } as unknown as CloudBackend
}

describe('listCloudBackups（plan23 §1）', () => {
  it('有 listBackupsEx：优先走 Ex，透传 complete 标志', async () => {
    const listBackups = vi.fn(async () => [] as string[])
    const ex = vi.fn(async () => ({ names: ['dir/vault-20261010-090000.totpbackup'], complete: false }))
    const r = await listCloudBackups(backendOf({ listBackups, listBackupsEx: ex }))
    expect(ex).toHaveBeenCalled()
    expect(listBackups).not.toHaveBeenCalled()
    expect(r.complete).toBe(false)
    expect(r.items).toEqual([{ path: 'dir/vault-20261010-090000.totpbackup', base: 'vault-20261010-090000.totpbackup', at: expect.any(Number) }])
  })

  it('无 Ex：回落 listBackups 且 complete=true（retention.ts 既有回退语义）', async () => {
    const r = await listCloudBackups(backendOf({ listBackups: vi.fn(async () => ['vault-20261009-210000.totpbackup']) }))
    expect(r.complete).toBe(true)
    expect(r.items[0]).toMatchObject({ base: 'vault-20261009-210000.totpbackup', at: new Date(2026, 9, 9, 21, 0, 0).getTime() }) // 本地 2026-10-09 21:00:00（锁定解析口径）
  })

  it('倒序输出（字典序=时间序，最新在前）且 basename 映射 at（不可解析名 at=null）', async () => {
    const r = await listCloudBackups(backendOf({
      listBackups: vi.fn(async () => ['d/vault-20261009-210000.totpbackup', 'vault-20261010-090000.totpbackup']),
    }))
    expect(r.items.map((x) => x.base)).toEqual(['vault-20261010-090000.totpbackup', 'vault-20261009-210000.totpbackup'])
    expect(r.items.every((x) => x.at !== null)).toBe(true)
  })

  it('混合目录前缀仍按文件名时间倒序（basename 口径，不受目录字典序干扰）', async () => {
    const r = await listCloudBackups(backendOf({
      listBackups: vi.fn(async () => ['e/vault-20261010-090000.totpbackup', 'd/vault-20261009-210000.totpbackup']),
    }))
    expect(r.items.map((x) => x.base)).toEqual(['vault-20261010-090000.totpbackup', 'vault-20261009-210000.totpbackup'])
  })

  it('错误原样上抛（UI 逐源行内展示，区别于 latestKeepPath 吞错语义）', async () => {
    const backend = backendOf({ listBackups: vi.fn(async () => { throw new Error('401') }) })
    await expect(listCloudBackups(backend)).rejects.toThrow('401')
  })
})
