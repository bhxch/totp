/**
 * backupPlatform 工厂直测（P4，盘点 B3.9-16 装配层全无测试的缺口）：BackupCard 18 成员接线语义——
 * 多源备份编排与 lastBackupHash 仅全成功写（I8）、导出/恢复对话框取消语义（取消不做 KDF 不写盘）、
 * readImportFile/Bytes 的 lastImportPick 成对缓存（F4 避免二次弹窗，P3b 遗留项）、
 * 本地源增删改持久化、聚合列表、kdfProfile 档位接线、createImportSchemesApi 容错。
 * Tauri 边界走 test/mocks/tauri 工厂；core 仅替换 Argon2id 信封为轻量桩（backupService.test.ts 先例，
 * 桩内 payload 携带 vaultJson、openBackupEnvelope 对称反解）。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBackupEnvelope, loadSources, normalizeSchemes, openBackupEnvelope, saveSources, SCHEMES_KEY,
  type BackupSource,
} from '@totp/core'
import { tauriMock } from '../test/mocks/tauri'
import { echoTr, fakeStore, memoryAdapter } from '../test/helpers/fakes'
import { createBackupPlatform, createImportSchemesApi } from '../src/backupPlatform'

vi.mock('@tauri-apps/api/core', async () => (await import('../test/mocks/tauri')).invokeModule())
vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/mocks/tauri')).fsModule())
// Argon2id 慢（数百 ms）：替换为轻量 v2 信封（档位透传可断言）；open 对称反解 payload 供恢复链路
vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  return {
    ...actual,
    createBackupEnvelope: vi.fn(async (vaultJson: string, _password: string, profile?: string) => ({
      v: 2 as const,
      kdf: { alg: 'argon2id' as const, profile: profile ?? 'balanced', m: 1, t: 1, p: 1, salt: 's' },
      payload: vaultJson,
    })),
    openBackupEnvelope: vi.fn(async (env: { payload: string }) => env.payload),
  }
})

const envMock = () => vi.mocked(createBackupEnvelope)
const openEnvMock = () => vi.mocked(openBackupEnvelope)

/** 常用源：默认目录（plugin-fs 通道）/自选目录（os 命令通道）/禁用 */
const src = (over: Partial<BackupSource> = {}): BackupSource => ({
  id: 'a', kind: 'local', name: '家里', dir: null, retention: { type: 'overwrite' }, enabled: true, role: 'replica', ...over,
})

async function makePlatform(sources: BackupSource[] = []) {
  const adapter = memoryAdapter()
  if (sources.length) await saveSources(adapter, sources)
  const store = fakeStore()
  const platform = createBackupPlatform({ getStore: () => store, getAdapter: () => adapter, tr: echoTr })
  return { platform, store, adapter }
}

beforeEach(() => {
  tauriMock.reset()
  localStorage.clear()
  envMock().mockClear()
  openEnvMock().mockClear()
})

describe('createBackup（多源编排 + I8 基线语义）', () => {
  it('全部启用源成功 → 中文摘要 + lastBackupHash 写入', async () => {
    const { platform } = await makePlatform([src(), src({ id: 'b', name: '办公室' })])
    const summary = await platform.createBackup('{"v":2}', 'pw')
    expect(summary).toBe('已备份到 2 个目录（家里、办公室）')
    expect(localStorage.getItem('lastBackupHash')).toBeTruthy()
    expect(tauriMock.fs.writeTextFile).toHaveBeenCalledTimes(2)
  })

  it('单源失败 → partial 明细摘要；lastBackupHash 不推进（防自动通道 unchanged 静默停摆）', async () => {
    const { platform } = await makePlatform([src(), src({ id: 'b', name: '办公室', dir: 'C:\\bkB' })])
    tauriMock.on('write_text_file_os', ({ path } = {}) => { throw new Error('磁盘写入失败') })
    const summary = await platform.createBackup('{"v":2}', 'pw')
    expect(summary).toBe('已备份到 1 个目录（家里）；失败：办公室')
    expect(localStorage.getItem('lastBackupHash')).toBeNull()
  })

  it('全部失败 → 「备份失败：…」；无启用源 → empty 提示且不生成 envelope（无谓 KDF）', async () => {
    const { platform } = await makePlatform([src(), src({ id: 'b', name: '办公室', dir: 'C:\\bkB' })])
    tauriMock.on('write_text_file_os', () => { throw new Error('x') })
    tauriMock.fs.rename.mockRejectedValue(new Error('y'))
    expect(await platform.createBackup('{"v":2}', 'pw')).toBe('备份失败：家里、办公室')
    envMock().mockClear()
    const empty = await makePlatform([src({ enabled: false })])
    expect(await empty.platform.createBackup('{"v":2}', 'pw')).toBe('未配置启用的备份目录')
    expect(envMock()).not.toHaveBeenCalled()
  })

  it('envelope 一次生成多源复用（Argon2id 只跑一次）；档位取 store.settings.backupKdfProfile', async () => {
    const { platform, store } = await makePlatform([src(), src({ id: 'b', name: '办公室' })])
    store.settings.backupKdfProfile = 'paranoid'
    await platform.createBackup('{"v":2}', 'pw')
    expect(envMock()).toHaveBeenCalledOnce()
    expect(envMock().mock.calls[0]).toEqual(['{"v":2}', 'pw', 'paranoid'])
  })

  it('自选目录源走 Rust 授权句柄写盘（dir_token_os → write_text_file_os 带 dirToken，F4）', async () => {
    const { platform } = await makePlatform([src({ dir: 'C:\\bkA', retention: { type: 'keep', n: 2 } })])
    tauriMock.on('dir_token_os', () => 'tk-A')
    tauriMock.on('list_backup_files_os', () => [])
    await platform.createBackup('{"v":2}', 'pw')
    expect(tauriMock.calls('dir_token_os').length).toBeGreaterThan(0)
    const [writeArgs] = tauriMock.calls('write_text_file_os')
    expect(writeArgs?.args?.dirToken).toBe('tk-A')
    expect(String(writeArgs?.args?.path)).toContain('C:\\bkA')
  })
})

describe('源列表增删改（backupSources 键持久化）', () => {
  it('listLocalSources → LocalSourceView（kind 过滤 + dir 归一）', async () => {
    const { platform } = await makePlatform([
      src(),
      src({ id: 'c', kind: 'webdav', name: '云源' }),
      src({ id: 'd', name: '自选', dir: 'C:\\bk', enabled: false, retention: { type: 'keep', n: 4 } }),
    ])
    const views = await platform.listLocalSources!()
    expect(views.map((v) => v.id).sort()).toEqual(['a', 'd'])
    const d = views.find((v) => v.id === 'd')!
    expect(d).toEqual({ id: 'd', name: '自选', dir: 'C:\\bk', retention: { type: 'keep', n: 4 }, enabled: false })
  })

  it('saveLocalSource：新增追加、同 id 更新不重复；removeLocalSource 过滤持久化', async () => {
    const { platform, adapter } = await makePlatform([src()])
    await platform.saveLocalSource!({ id: 'b', name: '新目录', dir: 'C:\\new', retention: { type: 'keep', n: 1 }, enabled: true })
    let list = await loadSources(adapter)
    expect(list.map((s) => s.id).sort()).toEqual(['a', 'b'])
    await platform.saveLocalSource!({ id: 'b', name: '改名', dir: 'C:\\new', retention: { type: 'keep', n: 1 }, enabled: true })
    list = await loadSources(adapter)
    expect(list.filter((s) => s.id === 'b')).toHaveLength(1)
    expect(list.find((s) => s.id === 'b')?.name).toBe('改名')
    await platform.removeLocalSource!('a')
    list = await loadSources(adapter)
    expect(list.map((s) => s.id)).toEqual(['b'])
  })
})

describe('导出/恢复（对话框取消=不做 KDF 不写盘）', () => {
  it('exportToFile 取消 → false 且不生成 envelope', async () => {
    const { platform } = await makePlatform()
    expect(await platform.exportToFile!('{"v":2}', 'pw')).toBe(false)
    expect(envMock()).not.toHaveBeenCalled()
    expect(tauriMock.calls('write_text_file_os')).toHaveLength(0)
  })

  it('exportToFile 成功 → envelope JSON 经授权句柄写盘；过滤器为备份过滤器', async () => {
    const { platform } = await makePlatform()
    tauriMock.onReturn('pick_save_file_os', { path: 'C:\\out\\vault-1.totpbackup', dirToken: 'tk-out' })
    expect(await platform.exportToFile!('{"v":2}', 'pw')).toBe(true)
    expect(envMock()).toHaveBeenCalledOnce()
    const [pickArgs] = tauriMock.calls('pick_save_file_os')
    expect(pickArgs?.args?.filters).toEqual([{ name: 'desktop.filterBackup', extensions: ['totpbackup'] }])
    const [writeArgs] = tauriMock.calls('write_text_file_os')
    expect(writeArgs?.args).toMatchObject({ path: 'C:\\out\\vault-1.totpbackup', dirToken: 'tk-out' })
    expect(JSON.parse(writeArgs?.args?.contents as string)).toMatchObject({ payload: '{"v":2}' })
  })

  it('saveTextFile：取消 false；成功按文本过滤器原样写', async () => {
    const { platform } = await makePlatform()
    expect(await platform.saveTextFile!('aegis.json', '{}')).toBe(false)
    tauriMock.onReturn('pick_save_file_os', { path: 'C:\\out\\aegis.json', dirToken: 'tk' })
    expect(await platform.saveTextFile!('aegis.json', '{}')).toBe(true)
    const [pickArgs] = tauriMock.calls('pick_save_file_os')
    expect(pickArgs?.args?.filters).toEqual([{ name: 'desktop.filterExport', extensions: ['json', 'txt'] }])
    expect(tauriMock.calls('write_text_file_os')[0]?.args?.contents).toBe('{}')
  })

  it('saveImageFile：dataUrl 去头解 base64 原始字节（不经文本管道）', async () => {
    const { platform } = await makePlatform()
    tauriMock.onReturn('pick_save_file_os', { path: 'C:\\out\\board.png', dirToken: 'tk' })
    expect(await platform.saveImageFile!('board.png', 'data:image/png;base64,AAA=')).toBe(true)
    const [writeArgs] = tauriMock.calls('write_bytes_file_os')
    expect(writeArgs?.args?.contents).toEqual([0, 0])
    expect(writeArgs?.args?.dirToken).toBe('tk')
  })

  it('restoreFromPicker：取消 null；成功经授权句柄读文件并解密', async () => {
    const { platform } = await makePlatform()
    expect(await platform.restoreFromPicker!('pw')).toBeNull()
    tauriMock.onReturn('pick_open_file_os', { path: 'C:\\bk\\vault-1.totpbackup', dirToken: 'tk-r' })
    tauriMock.onReturn('read_text_file_os', JSON.stringify({ payload: '{"v":9}' }))
    expect(await platform.restoreFromPicker!('pw')).toEqual({ json: '{"v":9}' })
    const [readArgs] = tauriMock.calls('read_text_file_os')
    expect(readArgs?.args).toMatchObject({ path: 'C:\\bk\\vault-1.totpbackup', dirToken: 'tk-r' })
    expect(openEnvMock()).toHaveBeenCalledOnce()
  })

  it('restoreByName：非法名（RE 白名单防穿越）与未知源抛错；合法经对应源目录读取', async () => {
    const { platform } = await makePlatform([src(), src({ id: 'b', name: '办公室', dir: 'D:\\bkB' })])
    await expect(platform.restoreByName!('a', '../evil.totpbackup', 'pw')).rejects.toThrow('invalid backup name')
    await expect(platform.restoreByName!('nope', 'vault-20260925-130000.totpbackup', 'pw')).rejects.toThrow('未找到该备份目录')
    tauriMock.onReturn('read_text_file_os', JSON.stringify({ payload: '{"v":9}' }))
    expect(await platform.restoreByName!('b', 'vault-20260925-120000.totpbackup', 'pw')).toEqual({ json: '{"v":9}' })
    const [readArgs] = tauriMock.calls('read_text_file_os')
    expect(readArgs?.args).toMatchObject({ path: 'D:\\bkB\\vault-20260925-120000.totpbackup' })
  })

  it('listBackups：聚合全部源倒序（新在前）+ 非 .totpbackup 过滤；单源失败跳过', async () => {
    const { platform } = await makePlatform([src(), src({ id: 'b', name: '办公室', dir: 'D:\\bkB' })])
    tauriMock.fs.readDir.mockResolvedValue([{ name: 'vault-20260925-100000.totpbackup' }, { name: 'notes.txt' }])
    tauriMock.on('list_backup_files_os', () => ['vault-20260925-120000.totpbackup'])
    const list = await platform.listBackups!()
    expect(list).toEqual([
      { sourceId: 'b', name: 'vault-20260925-120000.totpbackup' },
      { sourceId: 'a', name: 'vault-20260925-100000.totpbackup' },
    ])
  })

  it('pickBackupDir：返回 Rust 登记的 path；取消 null', async () => {
    const { platform } = await makePlatform()
    tauriMock.onReturn('pick_dir_os', { path: 'C:\\sel', dirToken: 'tk' })
    expect(await platform.pickBackupDir!()).toBe('C:\\sel')
    tauriMock.onReturn('pick_dir_os', null)
    expect(await platform.pickBackupDir!()).toBeNull()
  })
})

describe('自动偏好/状态/kdf 档位/整体替换接线', () => {
  it('getAutoPrefs/setAutoPrefs 与 desktopPrefs 同一 localStorage 实现', async () => {
    const { platform } = await makePlatform()
    expect(platform.getAutoPrefs!()).toEqual({ onChange: false, onInterval: false, intervalMinutes: 60 })
    await platform.setAutoPrefs!({ onChange: true, onInterval: false, intervalMinutes: 30 })
    expect(platform.getAutoPrefs!()).toEqual({ onChange: true, onInterval: false, intervalMinutes: 30 })
  })

  it('getAutoStatus 读 backupAutoStatus 键并格式化（无记录 null）', async () => {
    const { platform } = await makePlatform()
    expect(await platform.getAutoStatus!()).toBeNull()
    localStorage.setItem('backupAutoStatus', JSON.stringify({ at: Date.now(), ok: true, summary: '已备份' }))
    expect(await platform.getAutoStatus!()).toContain('成功：已备份')
  })

  it('replaceAllOp → store.replaceAllOp；backupKdfProfile get/set → settings + commitSettings', async () => {
    const { platform, store } = await makePlatform()
    await platform.replaceAllOp!({ version: 2, entries: [], tags: [], updatedAt: 1 })
    expect(store.replaceAllOp).toHaveBeenCalledWith({ version: 2, entries: [], tags: [], updatedAt: 1 })
    expect(platform.backupKdfProfile!.get()).toBe('balanced') // store 未设档位兜底
    platform.backupKdfProfile!.set('paranoid')
    expect(store.settings.backupKdfProfile).toBe('paranoid')
    expect(store.commitSettings).toHaveBeenCalled()
  })
})

describe('readImportFile/Bytes 的 lastImportPick 成对缓存（F4，P3b 遗留）', () => {
  it('文本入口：取消 null；成功返回 {text, name=路径尾段}；每次文本入口恒弹窗（缓存仅字节入口复用）', async () => {
    const { platform } = await makePlatform()
    expect(await platform.readImportFile!()).toBeNull() // 未注册 handler → 取消
    tauriMock.onReturn('pick_open_file_os', { path: 'C:\\imp\\data.json', dirToken: 'tk1' })
    tauriMock.onReturn('read_import_file_os', '{"entries":[]}')
    expect(await platform.readImportFile!()).toEqual({ text: '{"entries":[]}', name: 'data.json' })
    expect(await platform.readImportFile!()).toEqual({ text: '{"entries":[]}', name: 'data.json' })
    // 文本入口每次弹窗（取消 1 + 成功 2）；字节入口才复用 lastImportPick（见下例）
    expect(tauriMock.calls('pick_open_file_os')).toHaveLength(3)
  })

  it('字节入口复用最近登记结果（同一文件二次入口不二次弹窗）；无缓存时补弹', async () => {
    const { platform } = await makePlatform()
    tauriMock.onReturn('pick_open_file_os', { path: 'C:\\imp\\db\\x.db', dirToken: 'tk1' })
    tauriMock.onReturn('read_import_file_os', 'x')
    tauriMock.onReturn('read_import_file_bytes_os', [1, 2, 3])
    await platform.readImportFile!()
    const r = await platform.readImportFileBytes!()
    expect(r).toEqual({ bytes: new Uint8Array([1, 2, 3]), name: 'x.db' })
    // 缓存路径不重复弹窗：pick 调用数与 readImportFile 次数一致
    const picksAfterCache = tauriMock.calls('pick_open_file_os').length
    await platform.readImportFileBytes!()
    expect(tauriMock.calls('pick_open_file_os').length).toBe(picksAfterCache)
    expect(tauriMock.calls('read_import_file_bytes_os')[0]?.args?.dirToken).toBe('tk1')
  })

  it('无最近选择：字节入口自行补弹；取消 null', async () => {
    const { platform } = await makePlatform()
    tauriMock.onReturn('read_import_file_bytes_os', [9])
    tauriMock.onReturn('pick_open_file_os', { path: 'D:\\i\\y.sqlite', dirToken: 'tk2' })
    expect(await platform.readImportFileBytes!()).toEqual({ bytes: new Uint8Array([9]), name: 'y.sqlite' })
    tauriMock.onReturn('pick_open_file_os', null)
    expect(await platform.readImportFileBytes!()).toBeNull()
  })

  it('每平台实例独立缓存（工厂闭包，不跨实例串文件）', async () => {
    const a = await makePlatform()
    const b = await makePlatform()
    tauriMock.onReturn('pick_open_file_os', { path: 'C:\\1.json', dirToken: 'tk' })
    tauriMock.onReturn('read_import_file_os', 'a-text')
    tauriMock.onReturn('read_import_file_bytes_os', [7])
    await a.platform.readImportFile!()
    // b 实例无缓存：字节入口补弹（同 onReturn 恒定返回同一 picked）
    expect(await b.platform.readImportFileBytes!()).toEqual({ bytes: new Uint8Array([7]), name: '1.json' })
    expect(tauriMock.calls('pick_open_file_os')).toHaveLength(2)
  })
})

describe('decryptDpapi（WinAuth 层，Rust 要求用途声明）', () => {
  it('委托 decrypt_dpapi 并携带 purpose=winauth-import', async () => {
    const { platform } = await makePlatform()
    tauriMock.onReturn('decrypt_dpapi', 'aabbcc')
    expect(await platform.decryptDpapi!('aGVsbG8=')).toBe('aabbcc')
    expect(tauriMock.calls('decrypt_dpapi')[0]?.args).toEqual({ b64: 'aGVsbG8=', purpose: 'winauth-import' })
  })
})

describe('store/adapter 未就绪（「数据尚未就绪」契约 + schemesApi 容错）', () => {
  it('store 未就绪：replaceAllOp/backupKdfProfile.set 中文报错；kdfProfileOf 兜底 balanced', async () => {
    const platform = createBackupPlatform({ getStore: () => null, getAdapter: () => memoryAdapter(), tr: echoTr })
    expect(platform.backupKdfProfile!.get()).toBe('balanced')
    expect(() => platform.backupKdfProfile!.set('fast')).toThrow('数据尚未就绪')
    await expect(platform.replaceAllOp!({ version: 2, entries: [], tags: [], updatedAt: 0 })).rejects.toThrow('数据尚未就绪')
  })

  it('adapter 未就绪：schemesApi.load 返回空表、save 中文报错；备份平台写源报错', async () => {
    const schemesApi = createImportSchemesApi({ getAdapter: () => null })
    expect(await schemesApi.load()).toEqual([])
    await expect(schemesApi.save([])).rejects.toThrow('数据尚未就绪')
    const platform = createBackupPlatform({ getStore: () => fakeStore(), getAdapter: () => null, tr: echoTr })
    await expect(platform.saveLocalSource!({ id: 'x', name: 'x', dir: null, retention: { type: 'overwrite' }, enabled: true })).rejects.toThrow('数据尚未就绪')
  })

  it('schemesApi：坏 JSON → 空表（load 容错）；合法经 normalizeSchemes；save 原样序列化', async () => {
    const adapter = memoryAdapter({ [SCHEMES_KEY]: '{bad json' })
    const schemesApi = createImportSchemesApi({ getAdapter: () => adapter })
    expect(await schemesApi.load()).toEqual([])
    const scheme = { id: 's1', name: '谷歌地图', enabled: true, mappings: [] }
    await adapter.set(SCHEMES_KEY, JSON.stringify([scheme]))
    expect(await schemesApi.load()).toEqual(normalizeSchemes([scheme]))
    await schemesApi.save([scheme] as never)
    expect(await adapter.get(SCHEMES_KEY)).toBe(JSON.stringify([scheme]))
  })
})
