/**
 * cloudPlatforms 直测（P4，盘点 B5.18-21 云同步装配层缺口）：
 * - createCloudPlatform：源模型成员/保管区凭据 op/冲突副本命名/revSeal 三态（明文回落、
 *   锁定态拒落明文不吞错、unseal 不可解回落原文）/deviceId/autoPrefs/loadAutoStatus 接线；
 * - createDesktopCloudSync：runner deps 接线——「启用云源×凭据」装配对、retentionNotes 拼接后
 *   清空不跨轮、onMergeConflicts fire-and-forget、内容门基线键、saveConflictBackup 接线形状
 *   （cloudSyncConflict 回归探针同口径）。
 * runner 侧沿 extension cloudRunnerFactory.test 先例：mock '@totp/ui' 捕获 createCloudSyncRunner
 * 的 deps 后类型视图直调（宿主接线是本侧职责，runner 编排本体归 ui 包测试）。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDeviceId, loadSources, loadSyncState, saveSources, SYNC_STATE_KEY, type BackupSource, type CloudCred } from '@totp/core'
import { tauriMock } from '../test/mocks/tauri'
import { echoTr, fakeStore, memoryAdapter } from '../test/helpers/fakes'
import { createCloudPlatform, createDesktopCloudSync } from '../src/cloudPlatforms'

vi.mock('@tauri-apps/api/core', async () => (await import('../test/mocks/tauri')).invokeModule())
vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/mocks/tauri')).fsModule())

// 捕获 createCloudSyncRunner deps（接线断言）+ 可编程 spy；vi.hoisted 保证先于 mock 工厂可用
const ui = vi.hoisted(() => ({
  runnerDeps: null as import('@totp/ui').CloudRunnerDeps | null,
  runImpl: vi.fn(async (_mode?: string) => {}),
  mergeConfirmMock: vi.fn(async (_preview?: unknown) => true),
  progressMock: vi.fn(),
}))
vi.mock('@totp/ui', async () => {
  const { vi: v } = await import('vitest')
  return {
    createCloudSyncRunner: v.fn((deps: import('@totp/ui').CloudRunnerDeps) => {
      ui.runnerDeps = deps
      return { run: (mode?: string) => ui.runImpl(mode) }
    }),
    createCloudBackend: v.fn((cred: { backend: string }) => ({
      id: cred.backend,
      put: v.fn(async () => {}),
      get: v.fn(async () => null),
      delete: v.fn(async () => {}),
      exists: v.fn(async () => false),
    })),
    requestMergeConfirm: v.fn((preview: unknown) => ui.mergeConfirmMock(preview)),
    setSyncProgress: v.fn((done: number, total: number) => ui.progressMock(done, total)),
  }
})

const src = (over: Partial<BackupSource> = {}): BackupSource => ({
  id: 'w1', kind: 'webdav', name: '家里网盘', retention: { type: 'overwrite' }, enabled: true, role: 'primary', ...over,
})
const localSrc = (over: Partial<BackupSource> = {}): BackupSource => ({
  id: 'l1', kind: 'local', name: '本地备份', retention: { type: 'overwrite' }, enabled: true, role: 'replica', dir: null, ...over,
})
const cred: CloudCred = { backend: 'webdav', serverUrl: 'https://dav', username: 'u', password: 'p' }

/** zh 翻译桩（desktop.* 段与 ui locales/zh 逐字一致；同 extension cloudRunnerFactory.test 口径） */
const tStub = (key: string, params: Record<string, unknown> = {}): string => {
  const table: Record<string, string> = {
    'desktop.noteSep': '；',
    'desktop.retentionCleaned': '{name} 清理 {count} 份旧云备份',
    'desktop.retentionUnsupported': '{name} 后端不支持远端清理',
  }
  return (table[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]))
}

function makePlatform(storeOverrides: Record<string, unknown> = {}, seed: BackupSource[] = []) {
  const adapter = memoryAdapter()
  const store = fakeStore(storeOverrides)
  const platform = createCloudPlatform({ getStore: () => store, getAdapter: () => adapter, tr: echoTr })
  return { platform, store, adapter }
}

/** runner deps 类型视图直调（mock 装配恒提供全部成员） */
function deps(): import('@totp/ui').CloudRunnerDeps {
  if (!ui.runnerDeps) throw new Error('runner deps 未捕获')
  return ui.runnerDeps
}

beforeEach(() => {
  tauriMock.reset()
  localStorage.clear()
  ui.runnerDeps = null
  ui.runImpl.mockClear()
})

describe('createCloudPlatform：源模型与凭据保管区', () => {
  it('loadSources 只返回云源（local 项归 BackupCard）', async () => {
    const adapter = memoryAdapter()
    await saveSources(adapter, [src(), localSrc(), src({ id: 'g1', kind: 'gdrive', name: 'G盘', role: 'replica' })])
    const store = fakeStore()
    const platform = createCloudPlatform({ getStore: () => store, getAdapter: () => adapter, tr: echoTr })
    const list = await platform.loadSources()
    expect(list.map((s) => s.id).sort()).toEqual(['g1', 'w1'])
  })

  it('saveSources 合并写保留并发改动中的本地源（审查 I11），被移除的云源删除', async () => {
    const adapter = memoryAdapter()
    await saveSources(adapter, [localSrc(), src(), src({ id: 'gone', kind: 'gist', name: '移除我', role: 'replica' })])
    const store = fakeStore()
    const platform = createCloudPlatform({ getStore: () => store, getAdapter: () => adapter, tr: echoTr })
    await platform.saveSources([src()])
    const after = await loadSources(adapter)
    expect(after.map((s) => s.id).sort()).toEqual(['l1', 'w1']) // local 保留、gone 随提交删除
  })

  it('saveCred/removeCred → store 保管区 op 传参；creds getter 读 credsCache 只读视图', async () => {
    const store = fakeStore({ credsCache: { value: { w1: cred } as never } })
    const platform = createCloudPlatform({ getStore: () => store, getAdapter: () => memoryAdapter(), tr: echoTr })
    await platform.saveCred('w1', cred)
    expect(store.saveSourceCredOp).toHaveBeenCalledWith('w1', cred)
    await platform.removeCred('w1')
    expect(store.removeSourceCredOp).toHaveBeenCalledWith('w1')
    expect(platform.creds['w1']).toEqual(cred)
  })

  it('readVaultJson 序列化当前 vault；persistDownloaded → store.replaceAllOp 整体替换', async () => {
    const store = fakeStore()
    ;(store.vault as { updatedAt: number }).updatedAt = 7
    const platform = createCloudPlatform({ getStore: () => store, getAdapter: () => memoryAdapter(), tr: echoTr })
    expect(platform.readVaultJson()).toContain('"updatedAt":7')
    await platform.persistDownloaded('{"version":2,"entries":[],"tags":[],"updatedAt":9}')
    expect(store.replaceAllOp).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: 9 }))
  })

  it('saveConflictBackup：conflict-{sourceId}-{ts}.totpbackup 恒写默认目录（plugin-fs 原子写）并返回名', async () => {
    const { platform } = makePlatform()
    const bytes = new TextEncoder().encode('{"conflict":true}')
    const name = await platform.saveConflictBackup!(bytes, 'w1')
    expect(name).toMatch(/^conflict-w1-\d{8}-\d{6}\.totpbackup$/)
    const renameArgs = tauriMock.fs.rename.mock.calls.at(-1) as unknown as [string, string, unknown]
    expect(renameArgs[1]).toBe(`backups/${name}`)
    const [writePath, contents] = tauriMock.fs.writeTextFile.mock.calls.at(-1) as unknown as [string, string]
    expect(writePath).toBe(`backups/${name}.tmp`)
    expect(contents).toBe('{"conflict":true}')
  })

  it('deviceId：loadDeviceId 持久 UUID（同 adapter 两次一致，落 cloudDeviceId 键）', async () => {
    const { platform, adapter } = makePlatform()
    const d1 = await platform.deviceId()
    const d2 = await platform.deviceId()
    expect(d1).toBe(d2)
    expect(await adapter.get('cloudDeviceId')).toBe(d1)
  })

  it('kdfProfile：读 settings.backupKdfProfile，未设兜底 balanced', () => {
    const store = fakeStore()
    const platform = createCloudPlatform({ getStore: () => store, getAdapter: () => memoryAdapter(), tr: echoTr })
    expect(platform.kdfProfile!()).toBe('balanced')
    store.settings.backupKdfProfile = 'fast'
    expect(platform.kdfProfile!()).toBe('fast')
  })

  it('autoPrefs 读写 cloudAutoPrefs 键；loadAutoStatus 读 cloudAutoStatus 格式化', async () => {
    const { platform } = makePlatform()
    expect(await platform.autoPrefs.get()).toEqual({ onChange: false, onInterval: false, intervalMinutes: 60 })
    await platform.autoPrefs.set({ onChange: true, onInterval: true, intervalMinutes: 20 })
    expect(await platform.autoPrefs.get()).toEqual({ onChange: true, onInterval: true, intervalMinutes: 20 })
    expect(await platform.loadAutoStatus!()).toBeNull()
    localStorage.setItem('cloudAutoStatus', JSON.stringify({ at: Date.now(), ok: null, summary: '库已锁定' }))
    expect(await platform.loadAutoStatus!()).toContain('跳过：库已锁定')
  })

  it('store 未就绪：saveCred/readVaultJson/loadSourceState 统一「数据尚未就绪」（非 async 箭头，同步 throw 与原实现一致）', () => {
    const platform = createCloudPlatform({ getStore: () => null, getAdapter: () => memoryAdapter(), tr: echoTr })
    expect(() => platform.saveCred('w1', cred)).toThrow('数据尚未就绪')
    expect(() => platform.readVaultJson()).toThrow('数据尚未就绪')
    expect(() => platform.loadSourceState('w1')).toThrow('数据尚未就绪')
  })
})

describe('revSeal 三态（spec §1.2 静态保护，经 loadSourceState/saveSourceState 接线）', () => {
  it('未启用加密（sealWithDek→null）→ 明文回落落盘、读回一致（明文库语义）', async () => {
    const { platform, adapter, store } = makePlatform() // fakeStore 缺省 sealWithDek→null
    await platform.saveSourceState('w1', { lastKnownRemoteRev: 3, baseSnapshot: 'PLAIN-BASE' })
    expect(await adapter.get(SYNC_STATE_KEY)).toContain('PLAIN-BASE') // 明文形态（未启用加密=明文库）
    const st = await platform.loadSourceState('w1')
    expect(st).toEqual({ lastKnownRemoteRev: 3, baseSnapshot: 'PLAIN-BASE' })
    expect(store.sealWithDek).toHaveBeenCalled()
  })

  it('加密启用但窗口锁定（sealWithDek 抛 vault locked）→ 不吞错拒绝落盘，明文 baseSnapshot 绝不回落', async () => {
    const { platform, adapter } = makePlatform({
      sealWithDek: vi.fn(async () => { throw new Error('vault locked') }),
      unsealWithDek: vi.fn(async () => { throw new Error('vault locked') }),
    })
    await expect(platform.saveSourceState('w1', { lastKnownRemoteRev: 3, baseSnapshot: 'SECRET' })).rejects.toThrow('vault locked')
    expect(await adapter.get(SYNC_STATE_KEY)).toBeNull() // 键未落盘（下轮按旧基线重做）
  })

  it('unseal 不可解（换 DEK）→ 回落原文判废 → 空态重建（不抛错阻断）', async () => {
    const { platform } = makePlatform({
      sealWithDek: vi.fn(async (plain: string) => `ENC:${btoa(plain)}`),
      unsealWithDek: vi.fn(async () => null), // 密文解不开 → null 回落原文 → core 解析失败 → 空态
    })
    await expect(platform.loadSourceState('w1')).resolves.toEqual({ lastKnownRemoteRev: null, baseSnapshot: null })
  })
})

describe('createDesktopCloudSync：runner deps 接线（类型视图直调）', () => {
  function makeSync(storeOverrides: Record<string, unknown> = {}, seed: BackupSource[] = []) {
    const adapter = memoryAdapter()
    if (seed.length) return adapter.set('backupSources', JSON.stringify(seed)).then(() => adapter)
    return Promise.resolve(adapter)
  }

  it('锁定守护/口令/vault 快照闭包实时读 store；未就绪兜底（isLocked true / conflictCount 0）', async () => {
    const store = fakeStore({ backupSecret: { value: 'pw' } as never })
    const holder: { value: typeof store | null } = { value: store }
    createDesktopCloudSync({ getStore: () => holder.value, getAdapter: () => memoryAdapter(), tr: echoTr })
    expect(deps().isLocked()).toBe(false)
    expect(deps().getSecret()).toBe('pw')
    holder.value = null // 未就绪：守护兜底 true（runner skip），冲突计数 0
    expect(deps().isLocked()).toBe(true)
    expect(deps().getSecret()).toBeNull()
    expect(deps().conflictCount!()).toBe(0)
  })

  it('loadSources 装配「启用云源×凭据」对：local 过滤、无凭据/禁用跳过按 credsCache；sourceName 缓存解析显示名', async () => {
    const adapter = await makeSync({}, [
      src(),
      src({ id: 'w2', kind: 'gist', name: 'Gist 备份', role: 'replica' }), // 无凭据 → 跳过
      src({ id: 'w3', kind: 's3', name: 'S3 归档', role: 'replica' }),
      localSrc({ id: 'l9' }), // 本地源不进云通道
    ])
    const store = fakeStore({ credsCache: { value: { w1: cred, w3: cred } as never } })
    createDesktopCloudSync({ getStore: () => store, getAdapter: () => adapter, tr: echoTr })
    const pairs = await deps().loadSources()
    expect(pairs.map((p) => p.source.id).sort()).toEqual(['w1', 'w3'])
    expect(pairs[0]!.cred).toEqual(cred)
    // sourceName：runner 每轮 loadSources 刷新的 id→名称缓存
    expect(deps().sourceName!('w1')).toBe('家里网盘')
    expect(deps().sourceName!('w3')).toBe('S3 归档')
    expect(deps().sourceName!('unknown')).toBe('unknown')
  })

  it('rev 基线与冲突副本接线与 cloudPlatform 共用同一形态（cloudSyncState 键 + (key,bytes) 探针口径）', async () => {
    const adapter = await makeSync()
    const store = fakeStore()
    createDesktopCloudSync({ getStore: () => store, getAdapter: () => adapter, tr: echoTr })
    await deps().saveSyncState!('w1', { lastKnownRemoteRev: 1, baseSnapshot: null })
    expect(await adapter.get(SYNC_STATE_KEY)).toBeTruthy()
    // saveConflictBackup(key, bytes) → saveConflictBackupToDir(bytes, null, key)：探针接线形状
    const spy = vi.spyOn(await import('../src/backupService'), 'saveConflictBackupToDir')
    await deps().saveConflictBackup!('w1', new TextEncoder().encode('x'))
    expect(spy).toHaveBeenCalledWith(new TextEncoder().encode('x'), null, 'w1')
    spy.mockRestore()
  })

  it('内容门基线：cloudContentHash 键读写，null=删键', async () => {
    const adapter = await makeSync()
    createDesktopCloudSync({ getStore: () => fakeStore(), getAdapter: () => adapter, tr: echoTr })
    expect(await deps().loadContentHash()).toBeNull()
    await deps().saveContentHash!('hash-1')
    expect(localStorage.getItem('cloudContentHash')).toBe('hash-1')
    await deps().saveContentHash!(null)
    expect(localStorage.getItem('cloudContentHash')).toBeNull()
  })

  it('retentionNotes：deleted>0 追加清理提示、deleted<0 记不支持；recordStatus 拼接后清空不跨轮残留', async () => {
    createDesktopCloudSync({ getStore: () => fakeStore(), getAdapter: () => memoryAdapter(), tr: tStub })
    deps().onRetentionDeleted!('家里网盘', 3)
    deps().onRetentionDeleted!('Gist', -1)
    deps().onRetentionDeleted!('S3', 0) // deleted=0 → 清理提示照记（count=0，desktop 装配口径）
    deps().recordStatus!(true, '家里网盘: 已上传')
    const first = JSON.parse(localStorage.getItem('cloudAutoStatus')!) as { summary: string }
    expect(first.summary).toBe('家里网盘: 已上传；家里网盘 清理 3 份旧云备份；Gist 后端不支持远端清理；S3 清理 0 份旧云备份')
    deps().recordStatus!(true, '第二轮') // 已清空：不再拼接旧 notes
    const second = JSON.parse(localStorage.getItem('cloudAutoStatus')!) as { summary: string }
    expect(second.summary).toBe('第二轮')
  })

  it('onMergeConflicts fire-and-forget：入库拒绝仅告警不中断同步结果', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = fakeStore({ addMergeConflictsOp: vi.fn(async () => { throw new Error('locked') }) })
    createDesktopCloudSync({ getStore: () => store, getAdapter: () => memoryAdapter(), tr: echoTr })
    const conflicts = [{ uuid: 'e1', field: 'label' }] as never
    expect(() => deps().onMergeConflicts!(conflicts)).not.toThrow()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[cloudAutoSync] 冲突记录入库失败', expect.any(Error)))
    warnSpy.mockRestore()
  })

  it('onManualConfirm/onProgress/onConflicts/t 接线：桥到 ui 桥与壳层取词', async () => {
    createDesktopCloudSync({ getStore: () => fakeStore({ conflictCount: { value: 5 } as never }), getAdapter: () => memoryAdapter(), tr: echoTr })
    const preview = { sourceName: '家里网盘', entries: [], tags: [] } as never
    await expect(deps().onManualConfirm!(preview)).resolves.toBe(true)
    expect(ui.mergeConfirmMock).toHaveBeenCalledWith(preview)
    deps().onProgress!(2, 3)
    expect(ui.progressMock).toHaveBeenCalledWith(2, 3)
    expect(deps().conflictCount!()).toBe(5)
    deps().onConflicts!(5)
    expect(deps().t!('desktop.noteSep', {})).toBe('desktop.noteSep') // tr 桩：键名回显
  })

  it('makeBackend：cred → ui createCloudBackend（真实工厂，五后端 switch 在 ui 包已测）', async () => {
    const adapter = await makeSync()
    createDesktopCloudSync({ getStore: () => fakeStore(), getAdapter: () => adapter, tr: echoTr })
    const backend = deps().makeBackend(cred) as { id: string }
    expect(backend.id).toBe('webdav')
  })
})
