import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackupEnvelope, loadSources, type BackupSource, type StorageAdapter } from '@totp/core'
import { createBackupToSources, joinBackupPath, listBackupsFromSources, pickBackupDirOs, readBackupByName, readBackupFileOs, saveCloudSourcesPreservingLocal, type BackupSourceInput } from './backupService'

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
      if (cmd === 'dir_token_os') return 'tok-A'
      if (cmd === 'list_backup_files_os') {
        return ['vault-20260916-120000.totpbackup', 'vault-20260916-120001.totpbackup', 'conflict-20260916-120000.totpbackup', 'other.txt']
      }
      return null
    })
    const r = await createBackupToSources(sources, '{"v":1}', 'pw', 'paranoid')
    expect(r.outcome).toBe('ok')
    expect(r.okCount).toBe(2)
    expect(r.failed).toEqual([])
    expect(r.summary).toBe('已备份到 2 个目录（家里、办公室）')
    // envelope 一次生成（Argon2id 昂贵，多目录复用同一密文）且档位第三参透传
    expect(envMock()).toHaveBeenCalledTimes(1)
    expect(envMock()).toHaveBeenCalledWith('{"v":1}', 'pw', 'paranoid')
    // 源 A（自选目录 keep）：os 写时间戳名 + 滚动删除最旧（overwrite/conflict 名不参与）；
    // F4：目录路径经 dir_token_os 重取后端登记句柄，文件命令携带 dirToken（不再有自证 allowedDir）
    expect(invokeMock).toHaveBeenCalledWith('dir_token_os', { dir: 'C:\\bkA' })
    const writeCall = invokeMock.mock.calls.find((c) => c[0] === 'write_text_file_os')
    expect(writeCall).toBeDefined()
    const writeArgs = writeCall?.[1] as { path: string; dirToken: string }
    expect(writeArgs).toMatchObject({ dirToken: 'tok-A' })
    expect(writeArgs.path).toMatch(/^C:\\bkA\\vault-\d{8}-\d{6}\.totpbackup$/)
    expect(invokeMock).toHaveBeenCalledWith('list_backup_files_os', { dirToken: 'tok-A' })
    expect(invokeMock).toHaveBeenCalledWith('remove_backup_file_os', {
      path: 'C:\\bkA\\vault-20260916-120000.totpbackup',
      dirToken: 'tok-A',
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

  it('单源失败不阻断其余源：outcome=partial，failed 带错误消息，摘要列出失败源名（审查 I8）', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'dir_token_os') return 'tok'
      if (cmd === 'write_text_file_os') throw new Error('disk full')
      return null
    })
    const r = await createBackupToSources(sources, '{"v":1}', 'pw', 'balanced')
    expect(r.outcome).toBe('partial')
    expect(r.okCount).toBe(1)
    expect(r.failed).toEqual([{ source: '家里', error: 'disk full' }])
    expect(r.summary).toBe('已备份到 1 个目录（办公室）；失败：家里')
    // 其余源照常落盘
    expect(fsMocks.writeTextFile).toHaveBeenCalled()
  })

  it('全部失败：outcome=failed，failed 明细含每源错误消息，摘要只列失败名单', async () => {
    invokeMock.mockRejectedValue(new Error('disk full'))
    fsMocks.writeTextFile.mockRejectedValue(new Error('disk full'))
    const r = await createBackupToSources(sources, '{}', 'pw', 'balanced')
    expect(r.outcome).toBe('failed')
    expect(r.okCount).toBe(0)
    expect(r.failed).toEqual([
      { source: '家里', error: 'disk full' },
      { source: '办公室', error: 'disk full' },
    ])
    expect(r.summary).toBe('备份失败：家里、办公室')
  })

  it('无启用源：outcome=empty 提示文案，不生成 envelope 不写盘', async () => {
    const r = await createBackupToSources([sources[2]!], '{}', 'pw', 'balanced')
    expect(r.outcome).toBe('empty')
    expect(r.okCount).toBe(0)
    expect(r.summary).toBe('未配置启用的备份目录')
    expect(envMock()).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(fsMocks.writeTextFile).not.toHaveBeenCalled()
  })
})

describe('saveCloudSourcesPreservingLocal（审查 I11：云源保存不丢本地源）', () => {
  // LOCAL 首个启用源 → loadSources 归一为 primary（toEqual 断言锚定）
  const LOCAL: BackupSource = { id: 'loc-1', kind: 'local', name: '本地目录', retention: { type: 'keep', n: 3 }, enabled: true, dir: 'C:\\bk', role: 'primary' }
  const CLOUD1: BackupSource = { id: 'w1', kind: 'webdav', name: '家里', retention: { type: 'overwrite' }, enabled: true, role: 'replica' }
  const CLOUD2: BackupSource = { id: 'g1', kind: 'gist', name: '备份 Gist', retention: { type: 'overwrite' }, enabled: false, role: 'replica' }

  function memAdapter(initial: BackupSource[] = []): StorageAdapter & { dump(): Promise<BackupSource[]> } {
    const m = new Map<string, string>()
    const adapter: StorageAdapter = {
      get: async (k) => m.get(k) ?? null,
      set: async (k, v) => { m.set(k, v) },
      delete: async (k) => { m.delete(k) },
    }
    return {
      ...adapter,
      async dump() { return loadSources(adapter) },
    }
  }

  it('云卡提交仅含云源的快照：并发存在的本地源原样保留，云源按提交覆盖', async () => {
    const adapter = memAdapter()
    await saveCloudSourcesPreservingLocal(adapter, [LOCAL, CLOUD1]) // 现值：local + 云源（BackupCard 刚写入 local）
    await saveCloudSourcesPreservingLocal(adapter, [{ ...CLOUD1, name: '家里 WebDAV' }]) // CloudCard 盲写旧场景的快照
    const list = await adapter.dump()
    expect(list.find((s) => s.id === 'loc-1')).toEqual(LOCAL) // 本地源元数据不丢
    expect(list.find((s) => s.id === 'w1')?.name).toBe('家里 WebDAV')
  })

  it('云源移除（提交列表缺该 id）：该云源被删除，本地源不受影响', async () => {
    const adapter = memAdapter()
    await saveCloudSourcesPreservingLocal(adapter, [LOCAL, CLOUD1, CLOUD2])
    await saveCloudSourcesPreservingLocal(adapter, [CLOUD1]) // CloudCard onConfirmRemove：列表减去 g1
    const list = await adapter.dump()
    expect(list.map((s) => s.id)).toEqual(['loc-1', 'w1'])
  })

  it('新增云源：追加落盘且与既有本地源共存', async () => {
    const adapter = memAdapter()
    await saveCloudSourcesPreservingLocal(adapter, [LOCAL])
    await saveCloudSourcesPreservingLocal(adapter, [CLOUD1, CLOUD2])
    const list = await adapter.dump()
    expect(list.map((s) => s.id)).toEqual(['loc-1', 'w1', 'g1'])
  })
})

describe('listBackupsFromSources（聚合列表）', () => {
  it('多源聚合：标注 sourceId、过滤 .totpbackup、文件名倒序=新在前', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'dir_token_os') return 'tok'
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
    expect(invokeMock).toHaveBeenCalledWith('list_backup_files_os', { dirToken: 'tok' })
  })

  it('单源列表失败跳过（目录被移除等），其余源照常返回', async () => {
    invokeMock.mockRejectedValue(new Error('dir missing'))
    fsMocks.readDir.mockResolvedValue([{ name: 'vault-20260916-140000.totpbackup' }])
    const list = await listBackupsFromSources(sources)
    expect(list).toEqual([{ sourceId: 'b', name: 'vault-20260916-140000.totpbackup' }])
  })

  it('M4 默认目录分支同口径过滤：仅后缀 .totpbackup 的非白名单名不混入（与 os 分支一致）', async () => {
    fsMocks.readDir.mockResolvedValue([
      { name: 'vault-20260916-140000.totpbackup' },
      { name: 'evil-20260916-120000.totpbackup' }, // 后缀合法、前缀不在白名单
      { name: 'conflict-x-20260916-120000.totpbackup' }, // 多段 sourceId 冲突副本：白名单内
      { name: 'notes.txt' },
    ])
    const list = await listBackupsFromSources([{ ...sources[1]! }])
    expect(list).toEqual([
      { sourceId: 'b', name: 'vault-20260916-140000.totpbackup' },
      { sourceId: 'b', name: 'conflict-x-20260916-120000.totpbackup' },
    ])
  })
})

describe('readBackupByName（按 sourceId 读取）', () => {
  it('自选目录源：先 dir_token_os 取登记句柄，read_text_file_os 带 dirToken', async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'dir_token_os' ? 'tok-A' : 'envelope-text'))
    const text = await readBackupByName('a', 'vault-20260916-120000.totpbackup', sources)
    expect(text).toBe('envelope-text')
    expect(invokeMock).toHaveBeenCalledWith('read_text_file_os', {
      path: 'C:\\bkA\\vault-20260916-120000.totpbackup',
      dirToken: 'tok-A',
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
    invokeMock.mockImplementation(async (cmd: string) => (cmd === 'dir_token_os' ? 'tok-A' : 'envelope-text'))
    const text = await readBackupByName('a', 'conflict-webdav-20260916-120000.totpbackup', sources)
    expect(text).toBe('envelope-text')
    await expect(readBackupByName('a', 'conflict-2dc4bf8a-5ca7-4087-8b3e-2f1a4d5c6b7e-20260918-024714.totpbackup', sources)).resolves.toBe('envelope-text')
    await expect(readBackupByName('a', '../evil.totpbackup', sources)).rejects.toThrow('invalid backup name')
  })
})

describe('对话框授权句柄（F4：授权源头收归后端）', () => {
  it('pickBackupDirOs 仅透出 Rust 目录选择 path；readBackupFileOs 以 {path, dirToken} 调用（不再自证 allowedDir）', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'pick_dir_os') return { dirToken: 'tok', path: 'C:\\bk' }
      if (cmd === 'read_text_file_os') return 'envelope-text'
      return null
    })
    expect(await pickBackupDirOs()).toBe('C:\\bk')
    const picked = { path: 'C:\\bk\\vault-20260916-120000.totpbackup', dirToken: 'tok' }
    await expect(readBackupFileOs(picked)).resolves.toBe('envelope-text')
    expect(invokeMock).toHaveBeenCalledWith('read_text_file_os', { path: picked.path, dirToken: 'tok' })
  })

  it('Rust pick_* 取消（返回 null）：pickBackupDirOs 为 null', async () => {
    invokeMock.mockResolvedValue(null)
    expect(await pickBackupDirOs()).toBeNull()
  })
})
