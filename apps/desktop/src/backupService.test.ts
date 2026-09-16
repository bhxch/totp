import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackupToDir, joinBackupPath, listBackups, readBackupByName } from './backupService'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
// 只 mock Tauri invoke/plugin-fs 边界；@totp/core 的文件名与滚动策略用真实现（另一处 mock 掉慢的 KDF）
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  readDir: vi.fn(async (): Promise<Array<{ name: string }>> => []),
  readTextFile: vi.fn(async () => ''),
  rename: vi.fn(async () => undefined),
  writeTextFile: vi.fn(async () => undefined),
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
  mkdir: fsMocks.mkdir,
  readDir: fsMocks.readDir,
  readTextFile: fsMocks.readTextFile,
  rename: fsMocks.rename,
  writeTextFile: fsMocks.writeTextFile,
  BaseDirectory: { AppData: 'AppData' },
}))
// createBackupEnvelope 走 Argon2id（数百 ms）：测试替换为轻量信封，只关心落盘内容通道
vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  return {
    ...actual,
    createBackupEnvelope: vi.fn(async (vaultJson: string) => ({ v: 1, prf: 'test', payload: vaultJson })),
  }
})

beforeEach(() => {
  invokeMock.mockReset()
  fsMocks.mkdir.mockClear()
  fsMocks.readDir.mockReset().mockResolvedValue([])
  fsMocks.readTextFile.mockReset().mockResolvedValue('')
  fsMocks.rename.mockClear()
  fsMocks.writeTextFile.mockClear()
})

describe('joinBackupPath', () => {
  it('dir 含反斜杠（Windows 目录选择器）：以反斜杠连接', () => {
    expect(joinBackupPath('C:\\dir', 'vault-20260916-120000.totpbackup')).toBe('C:\\dir\\vault-20260916-120000.totpbackup')
    expect(joinBackupPath('C:\\dir\\', 'vault-20260916-120000.totpbackup')).toBe('C:\\dir\\vault-20260916-120000.totpbackup')
  })
  it('dir 含正斜杠或相对名（POSIX/相对目录）：以正斜杠连接', () => {
    expect(joinBackupPath('/home/u/bk', 'vault-20260916-120000.totpbackup')).toBe('/home/u/bk/vault-20260916-120000.totpbackup')
    expect(joinBackupPath('/home/u/bk/', 'vault-20260916-120000.totpbackup')).toBe('/home/u/bk/vault-20260916-120000.totpbackup')
    expect(joinBackupPath('dir/sub', 'vault-20260916-120000.totpbackup')).toBe('dir/sub/vault-20260916-120000.totpbackup')
  })
})

describe('backupService dirOverride 分支', () => {
  it('createBackupToDir override：写盘/列表/滚动删除全走 os 命令', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_backup_files_os') {
        return ['vault-20260916-120000.totpbackup', 'vault-20260916-120001.totpbackup', 'conflict-20260916-120000.totpbackup', 'other.txt']
      }
      return null
    })
    const r = await createBackupToDir('{"v":1}', 'pw', { type: 'keep', n: 1 }, 'C:\\bk')
    expect(r).toBe('created')
    const writeCall = invokeMock.mock.calls.find((c) => c[0] === 'write_text_file_os')
    expect(writeCall).toBeDefined()
    const writeArgs = writeCall?.[1] as { path: string; allowedDir: string }
    expect(writeArgs).toMatchObject({ allowedDir: 'C:\\bk' })
    expect(writeArgs.path).toMatch(/^C:\\bk\\vault-\d{8}-\d{6}\.totpbackup$/)
    expect(invokeMock).toHaveBeenCalledWith('list_backup_files_os', { dir: 'C:\\bk' })
    // 滚动保留 1 份：最旧的 vault-...120000 被删，overwrite/conflict 名不参与
    expect(invokeMock).toHaveBeenCalledWith('remove_backup_file_os', {
      path: 'C:\\bk\\vault-20260916-120000.totpbackup',
      allowedDir: 'C:\\bk',
    })
  })

  it('createBackupToDir 无 override：走 AppData plugin-fs 分支（行为不变）', async () => {
    await createBackupToDir('{"v":1}', 'pw', { type: 'overwrite' }, null)
    expect(fsMocks.writeTextFile).toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('listBackups override：os 列表倒序返回', async () => {
    invokeMock.mockResolvedValue(['vault-20260916-120000.totpbackup', 'vault-20260916-120001.totpbackup'])
    const list = await listBackups('C:\\bk')
    expect(invokeMock).toHaveBeenCalledWith('list_backup_files_os', { dir: 'C:\\bk' })
    expect(list.map((x) => x.name)).toEqual(['vault-20260916-120001.totpbackup', 'vault-20260916-120000.totpbackup'])
  })

  it('listBackups 无 override：走 plugin-fs readDir', async () => {
    fsMocks.readDir.mockResolvedValue([{ name: 'vault-20260916-120000.totpbackup' }])
    const list = await listBackups(null)
    expect(fsMocks.readDir).toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(list).toEqual([{ name: 'vault-20260916-120000.totpbackup' }])
  })

  it('readBackupByName override：read_text_file_os 带 allowedDir', async () => {
    invokeMock.mockResolvedValue('envelope-text')
    const text = await readBackupByName('vault-20260916-120000.totpbackup', 'C:\\bk')
    expect(text).toBe('envelope-text')
    expect(invokeMock).toHaveBeenCalledWith('read_text_file_os', {
      path: 'C:\\bk\\vault-20260916-120000.totpbackup',
      allowedDir: 'C:\\bk',
    })
  })

  it('readBackupByName override：非法名仍被 READABLE_BACKUP_RE 拒绝', async () => {
    await expect(readBackupByName('../evil.totpbackup', 'C:\\bk')).rejects.toThrow('invalid backup name')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('readBackupByName：多目标冲突副本名（conflict-{backend}-{ts}）通过 RE 校验可读', async () => {
    invokeMock.mockResolvedValue('envelope-text')
    const text = await readBackupByName('conflict-webdav-20260916-120000.totpbackup', 'C:\\bk')
    expect(text).toBe('envelope-text')
    expect(invokeMock).toHaveBeenCalledWith('read_text_file_os', {
      path: 'C:\\bk\\conflict-webdav-20260916-120000.totpbackup',
      allowedDir: 'C:\\bk',
    })
    await expect(readBackupByName('conflict-x-y-20260916-120000.totpbackup', 'C:\\bk')).rejects.toThrow('invalid backup name')
  })
})
