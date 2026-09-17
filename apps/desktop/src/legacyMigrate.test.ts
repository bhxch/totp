/**
 * legacyMigrate 单测：内存 StorageAdapter（仿 extension cloudCredStore.test 桩）。
 * plan16 T14 双迁移纯逻辑：
 * - migrateLegacyLocalSource：backupSources 键不存在 → 写默认本地源（dir/retention 取旧偏好）+ 删
 *   AppData backupDir 键；键已存在（含空数组）→ skipped 不动任何键（幂等）
 * - migrateLegacyCloudSources：旧 cloudCreds/cloudCred → BackupSource[]（id=旧 backend 键）+ 凭据经
 *   注入 saveCred 入保管区 + cloudRevs/cloudRev → sourceRevs 平移 + 四旧键删除；先写新后删旧、幂等
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SOURCE_REVS_KEY, SOURCES_KEY, type CloudCred, type StorageAdapter } from '@totp/core'
import { BACKUP_DIR_KEY, migrateLegacyCloudSources, migrateLegacyLocalSource } from './legacyMigrate'

const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_CREDS_KEY = 'cloudCreds'
const CLOUD_REV_KEY = 'cloudRev'
const CLOUD_REVS_KEY = 'cloudRevs'

/** 内存 StorageAdapter：字符串键值 + data 供键存在性断言 */
function makeAdapter(initial: Record<string, string> = {}): StorageAdapter & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    async get(key) {
      return data[key] ?? null
    },
    async set(key, value) {
      data[key] = value
    },
    async delete(key) {
      delete data[key]
    },
  }
}

const WEBDAV: CloudCred = { backend: 'webdav', serverUrl: 'https://dav', username: 'u', password: 'p' }
const GIST: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }

let adapter: StorageAdapter & { data: Record<string, string> }

beforeEach(() => {
  adapter = makeAdapter()
})

describe('migrateLegacyLocalSource（旧备份偏好 → 默认本地源）', () => {
  it('①首次迁移：写 id=local-default 单源（kind/name/dir/retention）并删除 backupDir 键', async () => {
    adapter.data[BACKUP_DIR_KEY] = 'D:\\旧自选目录'
    await expect(migrateLegacyLocalSource(adapter, { retention: { type: 'keep', n: 5 }, dir: 'D:\\旧自选目录' })).resolves.toBe('migrated')
    expect(JSON.parse(adapter.data[SOURCES_KEY]!)).toEqual([
      { id: 'local-default', kind: 'local', name: '本地备份', retention: { type: 'keep', n: 5 }, enabled: true, dir: 'D:\\旧自选目录' },
    ])
    expect(adapter.data[BACKUP_DIR_KEY]).toBeUndefined()
  })

  it('②新装（无任何旧键）：同样建 dir=null 默认源（开箱即用与旧行为连续）', async () => {
    await expect(migrateLegacyLocalSource(adapter, { retention: { type: 'keep', n: 3 }, dir: null })).resolves.toBe('migrated')
    expect(JSON.parse(adapter.data[SOURCES_KEY]!)).toEqual([
      { id: 'local-default', kind: 'local', name: '本地备份', retention: { type: 'keep', n: 3 }, enabled: true, dir: null },
    ])
  })

  it('③幂等：backupSources 键已存在（含空数组）→ skipped，不覆盖不删键', async () => {
    adapter.data[SOURCES_KEY] = '[]'
    await expect(migrateLegacyLocalSource(adapter, { retention: { type: 'keep', n: 3 }, dir: 'C:\\x' })).resolves.toBe('skipped')
    expect(adapter.data[SOURCES_KEY]).toBe('[]')
    expect(adapter.data[BACKUP_DIR_KEY]).toBeUndefined() // 原本就不存在，未误删他键

    adapter.data[BACKUP_DIR_KEY] = 'C:\\x'
    adapter.data[SOURCES_KEY] = JSON.stringify([{ id: 'webdav', kind: 'webdav', name: 'W', retention: { type: 'overwrite' }, enabled: true }])
    await expect(migrateLegacyLocalSource(adapter, { retention: { type: 'keep', n: 3 }, dir: 'C:\\x' })).resolves.toBe('skipped')
    expect(JSON.parse(adapter.data[SOURCES_KEY]!)).toHaveLength(1) // 用户已有源不被动
    expect(adapter.data[BACKUP_DIR_KEY]).toBe('C:\\x') // skipped 不删键
  })
})

describe('migrateLegacyCloudSources（旧云多目标键 → 源模型 + 保管区）', () => {
  it('①旧 cloudCreds+cloudRevs：源列表/凭据调用序列/基线平移/旧键全删/返回源数', async () => {
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify([
      { cred: WEBDAV, enabled: true },
      { cred: GIST, enabled: false },
    ])
    adapter.data[CLOUD_REVS_KEY] = JSON.stringify({ webdav: 'w-hash', gist: 'g-hash' })
    const saveCred = vi.fn().mockResolvedValue(undefined)

    await expect(migrateLegacyCloudSources(adapter, { saveCred })).resolves.toBe(2)

    // 源列表：id=旧 backend 键（保基线兼容）、kind/name 映射、retention overwrite、enabled 原值
    expect(JSON.parse(adapter.data[SOURCES_KEY]!)).toEqual([
      { id: 'webdav', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true },
      { id: 'gist', kind: 'gist', name: 'GitHub Gist', retention: { type: 'overwrite' }, enabled: false },
    ])
    expect(saveCred).toHaveBeenCalledTimes(2)
    expect(saveCred).toHaveBeenNthCalledWith(1, 'webdav', WEBDAV)
    expect(saveCred).toHaveBeenNthCalledWith(2, 'gist', GIST)
    // 基线平移至 sourceRevs（键=源 id）
    expect(JSON.parse(adapter.data[SOURCE_REVS_KEY]!)).toEqual({ webdav: 'w-hash', gist: 'g-hash' })
    expect(adapter.data[CLOUD_CREDS_KEY]).toBeUndefined()
    expect(adapter.data[CLOUD_CRED_KEY]).toBeUndefined()
    expect(adapter.data[CLOUD_REVS_KEY]).toBeUndefined()
    expect(adapter.data[CLOUD_REV_KEY]).toBeUndefined()
  })

  it('②旧单对象 cloudCred 回退：1 源 enabled:true；无 cloudRevs 时 cloudRev 仅由首源继承', async () => {
    adapter.data[CLOUD_CRED_KEY] = JSON.stringify(WEBDAV)
    adapter.data[CLOUD_REV_KEY] = 'legacy-hash'
    const saveCred = vi.fn().mockResolvedValue(undefined)

    await expect(migrateLegacyCloudSources(adapter, { saveCred })).resolves.toBe(1)
    expect(JSON.parse(adapter.data[SOURCES_KEY]!)).toEqual([
      { id: 'webdav', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true },
    ])
    expect(saveCred).toHaveBeenCalledWith('webdav', WEBDAV)
    expect(JSON.parse(adapter.data[SOURCE_REVS_KEY]!)).toEqual({ webdav: 'legacy-hash' })
    expect(adapter.data[CLOUD_CRED_KEY]).toBeUndefined()
    expect(adapter.data[CLOUD_REV_KEY]).toBeUndefined()
  })

  it('③幂等：迁移后二次调用返回 0，sources/sourceRevs 不再写', async () => {
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify([{ cred: WEBDAV, enabled: true }])
    adapter.data[CLOUD_REVS_KEY] = JSON.stringify({ webdav: 'w-hash' })
    const saveCred = vi.fn().mockResolvedValue(undefined)
    await migrateLegacyCloudSources(adapter, { saveCred })
    const sources = adapter.data[SOURCES_KEY]
    const revs = adapter.data[SOURCE_REVS_KEY]

    saveCred.mockClear()
    await expect(migrateLegacyCloudSources(adapter, { saveCred })).resolves.toBe(0)
    expect(saveCred).not.toHaveBeenCalled()
    expect(adapter.data[SOURCES_KEY]).toBe(sources)
    expect(adapter.data[SOURCE_REVS_KEY]).toBe(revs)
  })

  it('④无旧键：返回 0 且不创建 sources/sourceRevs 键', async () => {
    await expect(migrateLegacyCloudSources(adapter, { saveCred: vi.fn() })).resolves.toBe(0)
    expect(SOURCES_KEY in adapter.data).toBe(false)
    expect(SOURCE_REVS_KEY in adapter.data).toBe(false)
  })

  it('⑤坏 JSON：返回 0 且旧键保留（读不出 = 不删）', async () => {
    adapter.data[CLOUD_CREDS_KEY] = '{not-json'
    adapter.data[CLOUD_CRED_KEY] = JSON.stringify(WEBDAV)
    await expect(migrateLegacyCloudSources(adapter, { saveCred: vi.fn() })).resolves.toBe(0)
    expect(adapter.data[CLOUD_CREDS_KEY]).toBe('{not-json')
    expect(adapter.data[CLOUD_CRED_KEY]).toBe(JSON.stringify(WEBDAV))
  })

  it('⑥迁移失败不删旧键（先写新后删旧）：saveCred 抛错 → 异常上抛，旧键原样保留', async () => {
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify([
      { cred: WEBDAV, enabled: true },
      { cred: GIST, enabled: true },
    ])
    const saveCred = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('需先启用加密才能保存云凭据'))

    await expect(migrateLegacyCloudSources(adapter, { saveCred })).rejects.toThrow('需先启用加密才能保存云凭据')
    expect(adapter.data[CLOUD_CREDS_KEY]).toBe(JSON.stringify([
      { cred: WEBDAV, enabled: true },
      { cred: GIST, enabled: true },
    ]))
    expect(adapter.data[CLOUD_REVS_KEY]).toBeUndefined()
  })

  it('⑦与本地源迁移组合（desktop 编排顺序）：默认源已存在时追加云源不覆盖；cloudRevs 无关键不平移', async () => {
    // 前置：本地偏好迁移已写默认源（runLegacyMigrations 先 local 后 cloud）
    await migrateLegacyLocalSource(adapter, { retention: { type: 'keep', n: 3 }, dir: null })
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify([{ cred: WEBDAV, enabled: true }])
    adapter.data[CLOUD_REVS_KEY] = JSON.stringify({ webdav: 'w-hash', gdrive: 'ghost' })

    await expect(migrateLegacyCloudSources(adapter, { saveCred: vi.fn() })).resolves.toBe(1)
    const sources = JSON.parse(adapter.data[SOURCES_KEY]!) as Array<{ id: string }>
    expect(sources.map((s) => s.id)).toEqual(['local-default', 'webdav']) // 默认源在前，云源追加
    expect(JSON.parse(adapter.data[SOURCE_REVS_KEY]!)).toEqual({ webdav: 'w-hash' }) // ghost 不平移
  })
})
