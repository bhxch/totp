import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import type { StorageAdapter } from '../src/storage/adapter'
import { isBackupSource, loadSourceRevs, loadSources, normalizeRetention, normalizeSourceRoles, saveSourceRev, saveSources, type BackupSource } from '../src/backup/sources'

const src = (over: Partial<BackupSource> = {}): BackupSource => ({
  id: 's1', kind: 'webdav', name: '家里 WebDAV', retention: { type: 'overwrite' }, enabled: true, role: 'replica', ...over,
})

describe('BackupSource 存取', () => {
  it('normalizeRetention：overwrite 与 keep(n≥1)，非法回退 overwrite', () => {
    expect(normalizeRetention({ type: 'overwrite' })).toEqual({ type: 'overwrite' })
    expect(normalizeRetention({ type: 'keep', n: 3 })).toEqual({ type: 'keep', n: 3 })
    expect(normalizeRetention({ type: 'keep', n: 0 })).toEqual({ type: 'overwrite' })
    expect(normalizeRetention(undefined)).toEqual({ type: 'overwrite' })
  })
  it('isBackupSource：合法真、缺 id/kind/retention 假、kind 非法假', () => {
    expect(isBackupSource(src())).toBe(true)
    expect(isBackupSource({ ...src(), id: '' })).toBe(false)
    expect(isBackupSource({ ...src(), kind: 'ftp' })).toBe(false)
    expect(isBackupSource({ ...src(), retention: { type: 'keep', n: -1 } })).toBe(false)
  })
  it('isBackupSource：非对象（null/标量）→ false；retention 非对象/null → false', () => {
    for (const bad of [null, undefined, 'str', 42, true]) expect(isBackupSource(bad)).toBe(false)
    expect(isBackupSource({ ...src(), retention: null })).toBe(false)
    expect(isBackupSource({ ...src(), retention: 'keep' })).toBe(false)
    expect(isBackupSource({ ...src(), retention: 3 })).toBe(false)
  })
  it('loadSources：坏 JSON/缺键 → 空数组；非法条目过滤不抛', async () => {
    const a = createMemoryStorage()
    await expect(loadSources(a)).resolves.toEqual([])
    await a.set('backupSources', 'not json')
    await expect(loadSources(a)).resolves.toEqual([])
    await a.set('backupSources', '{"x":1}')
    await expect(loadSources(a)).resolves.toEqual([])
    await a.set('backupSources', JSON.stringify([src(), { id: 'bad' }]))
    await expect(loadSources(a)).resolves.toHaveLength(1)
  })
  it('loadSources：旧数据残留源级 objectPath 死字段 → 宽容接受不拒绝（审查 M4 已移除该字段）', async () => {
    const a = createMemoryStorage()
    // 历史版本源级 objectPath 无消费方（实际用凭据保管区 cred.objectPath），旧数据多余字段被宽容忽略
    await a.set('backupSources', JSON.stringify([src(), { ...src(), id: 's2', objectPath: 'legacy/bk.totpbackup' }]))
    expect(await loadSources(a)).toHaveLength(2)
    expect(isBackupSource({ ...src(), objectPath: 'legacy/bk.totpbackup' })).toBe(true)
  })
  it('loadSources/loadSourceRevs：adapter.get 抛错 → 空、不抛', async () => {
    const bad: StorageAdapter = {
      get: async () => { throw new Error('storage unavailable') },
      set: async () => {},
      delete: async () => {},
    }
    await expect(loadSources(bad)).resolves.toEqual([])
    await expect(loadSourceRevs(bad)).resolves.toEqual({})
  })
  it('saveSources→loadSources 往返', async () => {
    const a = createMemoryStorage()
    await saveSources(a, [src({ retention: { type: 'keep', n: 5 } }), src({ id: 's2', kind: 'local', dir: 'C:\\bp' })])
    expect(await loadSources(a)).toHaveLength(2)
  })
  it('sourceRevs：按 id 存删基线；坏 JSON/值非字符串 → 过滤或空', async () => {
    const a = createMemoryStorage()
    expect(await loadSourceRevs(a)).toEqual({})
    await a.set('sourceRevs', 'not json')
    expect(await loadSourceRevs(a)).toEqual({})
    await a.set('sourceRevs', JSON.stringify({ s0: 123 }))
    expect(await loadSourceRevs(a)).toEqual({})
    await saveSourceRev(a, 's1', 'abc')
    await saveSourceRev(a, 's2', 'def')
    expect(await loadSourceRevs(a)).toEqual({ s1: 'abc', s2: 'def' })
    await saveSourceRev(a, 's1', null) // null=删除该源基线
    expect(await loadSourceRevs(a)).toEqual({ s2: 'def' })
  })
})

describe('primary/replica 角色（活动目标单选，设计 §2）', () => {
  it('normalizeSourceRoles：首个启用=primary，其余 replica', () => {
    const r = normalizeSourceRoles([
      { id: 'a', kind: 'webdav', name: 'a', retention: { type: 'overwrite' }, enabled: false, role: 'replica' },
      { id: 'b', kind: 's3', name: 'b', retention: { type: 'overwrite' }, enabled: true, role: 'replica' },
      { id: 'c', kind: 'gist', name: 'c', retention: { type: 'overwrite' }, enabled: true, role: 'primary' },
    ])
    expect(r.find((s) => s.id === 'b')!.role).toBe('primary')
    expect(r.find((s) => s.id === 'c')!.role).toBe('replica')
    expect(r.find((s) => s.id === 'a')!.role).toBe('replica') // disabled 不参与，保持归一为 replica
  })
  it('normalizeSourceRoles：全部 disabled → 保持输入原 role 不变', () => {
    const list = [src({ id: 'a', enabled: false, role: 'primary' }), src({ id: 'b', enabled: false, role: 'replica' })]
    expect(normalizeSourceRoles(list)).toEqual(list)
  })
  it('normalizeSourceRoles：无 primary 且存量数据缺 role → 补 replica（?? 兜底分支）', () => {
    const list = [
      { id: 'a', kind: 'webdav', name: 'a', retention: { type: 'overwrite' }, enabled: false },
    ] as unknown as BackupSource[]
    expect(normalizeSourceRoles(list)[0]!.role).toBe('replica')
  })
  it('normalizeSourceRoles：local 源不参与 primary 选举——盘上 [local(enabled), cloud(enabled)] → cloud=primary、local=replica（T11F）', () => {
    // desktop saveCloudSourcesPreservingLocal 恒把保留的 local 源置于盘上列表头：按旧「首个 enabled」
    // 选举会把 local 选为 primary、云源全降 replica，云通道过滤 local 后无 primary → no primary target
    const r = normalizeSourceRoles([
      { id: 'loc', kind: 'local', name: '本地目录', retention: { type: 'keep', n: 3 }, enabled: true, dir: 'C:\\bk', role: 'replica' },
      { id: 'cloud', kind: 'webdav', name: '云', retention: { type: 'overwrite' }, enabled: true, role: 'replica' },
    ])
    expect(r.find((s) => s.id === 'cloud')!.role).toBe('primary')
    expect(r.find((s) => s.id === 'loc')!.role).toBe('replica')
  })
  it('normalizeSourceRoles：仅 local enabled → 保持输入原 role 不变（无 primary，T11F）', () => {
    const list = [
      { id: 'loc1', kind: 'local', name: '本地目录', retention: { type: 'keep', n: 3 }, enabled: true, dir: null, role: 'replica' },
      { id: 'cloud', kind: 'webdav', name: '云', retention: { type: 'overwrite' }, enabled: false, role: 'primary' },
    ] as BackupSource[]
    expect(normalizeSourceRoles(list)).toEqual(list)
  })
  it('isBackupSource：role 缺失合法（存量数据经 normalize 补齐）；role 值域外拒绝', () => {
    const legacy: Record<string, unknown> = { ...src() }
    delete legacy['role']
    expect(isBackupSource(legacy)).toBe(true)
    expect(isBackupSource({ ...src(), role: 'bogus' })).toBe(false)
  })
  it('loadSources 对无 role 存量数据归一（首个 enabled=primary）', async () => {
    const a = createMemoryStorage()
    await a.set('backupSources', JSON.stringify([
      { id: 'x', kind: 'webdav', name: 'x', retention: { type: 'overwrite' }, enabled: true },
    ]))
    const list = await loadSources(a)
    expect(list[0]!.role).toBe('primary')
  })
  it('loadSources：多源存量归一——首个启用 primary，其余（含 disabled）replica', async () => {
    const a = createMemoryStorage()
    await a.set('backupSources', JSON.stringify([
      { id: 'x', kind: 'webdav', name: 'x', retention: { type: 'overwrite' }, enabled: false },
      { id: 'y', kind: 's3', name: 'y', retention: { type: 'overwrite' }, enabled: true },
      { id: 'z', kind: 'gist', name: 'z', retention: { type: 'overwrite' }, enabled: true },
    ]))
    const list = await loadSources(a)
    expect(list.map((s) => `${s.id}:${s.role}`)).toEqual(['x:replica', 'y:primary', 'z:replica'])
  })
})
