import { describe, expect, it, vi } from 'vitest'
import { enforceRemoteRetention } from '../src/backup/retention'
import { selectBackupsToKeep } from '../src/backup/policy'

describe('远端滚动删除', () => {
  const names = ['vault-20260101-000000.totpbackup', 'vault-20260202-000000.totpbackup', 'vault-20260303-000000.totpbackup', 'conflict-webdav-20260101-000000.totpbackup', 'other.txt']
  it('keep=2：仅删最旧的正则匹配份，conflict/其他文件不动', async () => {
    const del = vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined)
    const deleted = await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 2)
    expect(deleted).toBe(1)
    expect(del).toHaveBeenCalledOnce()
    expect(del).toHaveBeenCalledWith('vault-20260101-000000.totpbackup')
  })
  it('keep=0/负数视作不删除；未超额定删除 0；backend 无 listBackups → 返回 -1（不支持）', async () => {
    const del = vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined)
    expect(await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 0)).toBe(0)
    expect(await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, -1)).toBe(0)
    expect(await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 5)).toBe(0)
    expect(del).not.toHaveBeenCalled()
    expect(await enforceRemoteRetention({ delete: async () => {} } as never, 2)).toBe(-1)
  })
  it('删除名单与 selectBackupsToKeep 同源（超额=旧→新前 N）', () => {
    expect(selectBackupsToKeep(names, 2)).toEqual(['vault-20260101-000000.totpbackup'])
  })
  it('单个删除失败不阻断：其余照删，返回成功删除数', async () => {
    const del = vi.fn(async (name: string) => {
      if (name === 'vault-20260202-000000.totpbackup') throw new Error('HTTP 500')
    })
    const deleted = await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 1)
    expect(deleted).toBe(1)
    expect(del).toHaveBeenCalledTimes(2)
    expect(del.mock.calls.map((c) => c[0]!).sort()).toEqual(['vault-20260101-000000.totpbackup', 'vault-20260202-000000.totpbackup'])
  })
})
