import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackupEnvelope } from '@totp/core'
import { createBackupToSources, joinBackupPath, listBackupsFromSources, readBackupByName, type BackupSourceInput } from './backupService'

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
// createBackupEnvelope 走 Argon2id（数百 ms）：测试替换为轻量 v2 信封，档位写入 kdf.profile（落盘内容可断言透传）
vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  return {
    ...actual,
    createBackupEnvelope: vi.fn(async (vaultJson: string, _password: string, profile?: string) => ({
      v: 2 as const,
      kdf: { alg: 'argon2id' as const, profile: profile ?? 'balanced', m: 1, t: 1, p: 1, salt: 's' },
      payload: vaultJson,
    })),
  }
})

const envMock = () => vi.mocked(createBackupEnvelope)

/** 常用源组：A=自选目录 keep、B=默认目录 overwrite、C=禁用（不应写盘） */
const sources: BackupSourceInput[] = [
  { id: 'a', name: '家里', dir: 'C:\\bkA', retention: { type: 'keep', n: 1 }, enabled: true },
  { id: 'b', name: '办公室', dir: null, retention: { type: 'overwrite' }, enabled: true },
  { id: 'c', name: '停用', dir: 'C:\\bkC', retention: { type: 'keep', n: 3 }, enabled: false },
]

beforeEach(() => {
  invokeMock.mockReset()
  fsMocks.mkdir.mockClear()
  fsMocks.readDir.mockReset().mockResolvedValue([])
  fsMocks.readTextFile.mockReset().mockResolvedValue('')
  fsMocks.rename.mockClear()
  fsMocks.writeTextFile.mockClear()
  envMock().mockClear()
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

describe('createBackupToSources（每源备份）', () => {
  it('keep/overwrite 混合多目录：禁用源跳过、envelope 一次生成、各源走各自分支', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_backup_files_os') {
        return ['vault-20260916-120000.totpbackup', 'vault-20260916-120001.totpbackup', 'conflict-20260916-120000.totpbackup', 'other.txt']
      }
      return null
    })
    const summary = await createBackupToSources(sources, '{"v":1}', 'pw', 'paranoid')
    expect(summary).toBe('已备份到 2 个目录（家里、办公室）')
    // envelope 一次生成（Argon2id 昂贵，多目录复用同一密文）且档位第三参透传
    expect(envMock()).toHaveBeenCalledTimes(1)
    expect(envMock()).toHaveBeenCalledWith('{"v":1}', 'pw', 'paranoid')
    // 源 A（自选目录 keep）：os 写时间戳名 + 滚动删除最旧（overwrite/conflict 名不参与）
    const writeCall = invokeMock.mock.calls.find((c) => c[0] === 'write_text_file_os')
    expect(writeCall).toBeDefined()
    const writeArgs = writeCall?.[1] as { path: string; allowedDir: string }
    expect(writeArgs).toMatchObject({ allowedDir: 'C:\\bkA' })
    expect(writeArgs.path).toMatch(/^C:\\bkA\\vault-\d{8}-\d{6}\.totpbackup$/)
    expect(invokeMock).toHaveBeenCalledWith('list_backup_files_os', { dir: 'C:\\bkA' })
    expect(invokeMock).toHaveBeenCalledWith('remove_backup_file_os', {
      path: 'C:\\bkA\\vault-20260916-120000.totpbackup',
      allowedDir: 'C:\\bkA',
    })
    // 源 B（默认目录 overwrite）：plugin-fs 写固定名，不走 os 命令之外的目录
    expect(fsMocks.writeTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/^backups\/vault-backup\.totpbackup\.tmp$/),
      expect.stringContaining('"profile": "paranoid"'),
      { baseDir: 'AppData' },
    )
    expect(fsMocks.rename).toHaveBeenCalledWith(
      'backups/vault-backup.totpbackup.tmp', 'backups/vault-backup.totpbackup',
      { oldPathBaseDir: 'AppData', newPathBaseDir: 'AppData' },
    )
    // 禁用源 C 不写盘
    expect(invokeMock.mock.calls.some((c) => String(c[1]?.dir ?? c[1]?.path ?? '').includes('bkC'))).toBe(false)
  })

  it('profile 缺省 → balanced（envelope 第三参兜底档位）', async () => {
    await createBackupToSources([{ ...sources[0]!, name: 'B', dir: null }], '{}', 'pw')
    expect(envMock()).toHaveBeenCalledWith('{}', 'pw', 'balanced')
  })

  it('envelope v2 kdf.profile 透传落盘：自选目录写盘内容携带档位', async () => {
    await createBackupToSources([{ id: 'a', name: '家里', dir: 'C:\\bkA', retention: { type: 'overwrite' }, enabled: true }], '{}', 'pw', 'paranoid')
    const writeArgs = invokeMock.mock.calls.find((c) => c[0] === 'write_text_file_os')?.[1] as { contents: string }
    expect(JSON.parse(writeArgs.contents)).toMatchObject({ v: 2, kdf: { profile: 'paranoid' } })
  })

  it('单源失败不阻断其余源：摘要列出失败源名', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'write_text_file_os') throw new Error('disk full')
      return null
    })
    const summary = await createBackupToSources(sources, '{"v":1}', 'pw', 'balanced')
    expect(summary).toBe('已备份到 1 个目录（办公室）；失败：家里')
    // 其余源照常落盘
    expect(fsMocks.writeTextFile).toHaveBeenCalled()
  })

  it('全部失败：摘要只列失败名单', async () => {
    invokeMock.mockRejectedValue(new Error('disk full'))
    fsMocks.writeTextFile.mockRejectedValue(new Error('disk full'))
    const summary = await createBackupToSources(sources, '{}', 'pw', 'balanced')
    expect(summary).toBe('备份失败：家里、办公室')
  })

  it('无启用源：返回提示文案，不生成 envelope 不写盘', async () => {
    const summary = await createBackupToSources([sources[2]!], '{}', 'pw', 'balanced')
    expect(summary).toBe('未配置启用的备份目录')
    expect(envMock()).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(fsMocks.writeTextFile).not.toHaveBeenCalled()
  })
})

describe('listBackupsFromSources（聚合列表）', () => {
  it('多源聚合：标注 sourceId、过滤 .totpbackup、文件名倒序=新在前', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_backup_files_os') {
        return ['vault-20260916-120000.totpbackup', 'conflict-20260916-130000.totpbackup', 'other.txt']
      }
      return null
    })
    fsMocks.readDir.mockResolvedValue([{ name: 'vault-20260916-140000.totpbackup' }, { name: 'notes.txt' }])
    const list = await listBackupsFromSources(sources)
    // 禁用源（c）目录内既有备份仍列出（停用=不再写入，历史文件保持可恢复）；
    // 倒序=码点降序（vault-140000 > vault-120000 > conflict-130000），同名词保持逐源插入序
    expect(list).toEqual([
      { sourceId: 'b', name: 'vault-20260916-140000.totpbackup' },
      { sourceId: 'a', name: 'vault-20260916-120000.totpbackup' },
      { sourceId: 'c', name: 'vault-20260916-120000.totpbackup' },
      { sourceId: 'a', name: 'conflict-20260916-130000.totpbackup' },
      { sourceId: 'c', name: 'conflict-20260916-130000.totpbackup' },
    ])
    expect(invokeMock).toHaveBeenCalledWith('list_backup_files_os', { dir: 'C:\\bkA' })
  })

  it('单源列表失败跳过（目录被移除等），其余源照常返回', async () => {
    invokeMock.mockRejectedValue(new Error('dir missing'))
    fsMocks.readDir.mockResolvedValue([{ name: 'vault-20260916-140000.totpbackup' }])
    const list = await listBackupsFromSources(sources)
    expect(list).toEqual([{ sourceId: 'b', name: 'vault-20260916-140000.totpbackup' }])
  })
})

describe('readBackupByName（按 sourceId 读取）', () => {
  it('自选目录源：read_text_file_os 带 allowedDir', async () => {
    invokeMock.mockResolvedValue('envelope-text')
    const text = await readBackupByName('a', 'vault-20260916-120000.totpbackup', sources)
    expect(text).toBe('envelope-text')
    expect(invokeMock).toHaveBeenCalledWith('read_text_file_os', {
      path: 'C:\\bkA\\vault-20260916-120000.totpbackup',
      allowedDir: 'C:\\bkA',
    })
  })

  it('默认目录源：走 plugin-fs readTextFile', async () => {
    fsMocks.readTextFile.mockResolvedValue('envelope-text')
    const text = await readBackupByName('b', 'vault-20260916-120000.totpbackup', sources)
    expect(text).toBe('envelope-text')
    expect(fsMocks.readTextFile).toHaveBeenCalledWith('backups/vault-20260916-120000.totpbackup', { baseDir: 'AppData' })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('非法名被 READABLE_BACKUP_RE 拒绝（防路径穿越）', async () => {
    await expect(readBackupByName('a', '../evil.totpbackup', sources)).rejects.toThrow('invalid backup name')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('未知 sourceId 抛错', async () => {
    await expect(readBackupByName('ghost', 'vault-20260916-120000.totpbackup', sources)).rejects.toThrow('未找到该备份目录')
  })

  it('多源冲突副本名（conflict-{sourceId}-{ts}）通过 RE 校验可读：旧 backend 单段与 uuid 五段均可恢复（审查 C2）', async () => {
    invokeMock.mockResolvedValue('envelope-text')
    const text = await readBackupByName('a', 'conflict-webdav-20260916-120000.totpbackup', sources)
    expect(text).toBe('envelope-text')
    await expect(readBackupByName('a', 'conflict-2dc4bf8a-5ca7-4087-8b3e-2f1a4d5c6b7e-20260918-024714.totpbackup', sources)).resolves.toBe('envelope-text')
    await expect(readBackupByName('a', '../evil.totpbackup', sources)).rejects.toThrow('invalid backup name')
  })
})
