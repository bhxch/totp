/**
 * cloudCredStore 单测：内存 StorageAdapter（仿 syncEngine.test 的 storage 桩）注入。
 * plan16 T13 源化后职责：
 * - migrateLegacySources：旧 cloudCreds（数组）/cloudCred（单对象回退）→ BackupSource[]（id=旧 backend 键）
 *   + 凭据经注入 saveCred 入保管区 + cloudRevs/cloudRev → sourceRevs 平移 + 四旧键删除；先写新后删旧、
 *   幂等（二次调用返回 0 且不再写）、坏 JSON 不迁移不删键、saveCred 失败旧键保留
 * - loadSourcesImpl/saveSourcesImpl：core 包装 roundtrip 与坏 JSON 安全默认
 * - conflictBackupName / formatAutoStatusText：本任务不变面，沿用既有断言
 * （旧 loadCreds/saveCreds/loadTargetHash/saveTargetHash 四成员已删，CloudTarget 断言随之移除）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { READABLE_BACKUP_RE, SOURCE_REVS_KEY, SOURCES_KEY, type CloudCred, type StorageAdapter } from '@totp/core'
import { conflictBackupName, formatAutoStatusText, hasLegacyCloudKeys, loadSourcesImpl, migrateLegacySources, retentionDeletedNote, saveSourcesImpl } from '../src/cloudCredStore'

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

describe('migrateLegacySources（旧多目标键 → 源模型 + 保管区）', () => {
  it('①旧 cloudCreds+cloudRevs：源列表/凭据调用序列/基线平移/旧键全删/返回源数', async () => {
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify([
      { cred: WEBDAV, enabled: true },
      { cred: GIST, enabled: false },
    ])
    adapter.data[CLOUD_REVS_KEY] = JSON.stringify({ webdav: 'w-hash', gist: 'g-hash' })
    const saveCred = vi.fn().mockResolvedValue(undefined)

    await expect(migrateLegacySources(adapter, { saveCred })).resolves.toBe(2)

    // 源列表：id=旧 backend 键（保基线兼容）、kind/name 映射、retention overwrite、enabled 原值
    expect(JSON.parse(adapter.data[SOURCES_KEY]!)).toEqual([
      { id: 'webdav', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true },
      { id: 'gist', kind: 'gist', name: 'GitHub Gist', retention: { type: 'overwrite' }, enabled: false },
    ])
    // 凭据逐源写入保管区（调用序列与源顺序一致）
    expect(saveCred).toHaveBeenCalledTimes(2)
    expect(saveCred).toHaveBeenNthCalledWith(1, 'webdav', WEBDAV)
    expect(saveCred).toHaveBeenNthCalledWith(2, 'gist', GIST)
    // 基线平移至 sourceRevs（键=源 id）
    expect(JSON.parse(adapter.data[SOURCE_REVS_KEY]!)).toEqual({ webdav: 'w-hash', gist: 'g-hash' })
    // 四个旧键全删
    expect(adapter.data[CLOUD_CREDS_KEY]).toBeUndefined()
    expect(adapter.data[CLOUD_CRED_KEY]).toBeUndefined()
    expect(adapter.data[CLOUD_REVS_KEY]).toBeUndefined()
    expect(adapter.data[CLOUD_REV_KEY]).toBeUndefined()
  })

  it('②旧单对象 cloudCred 回退（无 cloudCreds）：1 源 enabled:true；无 cloudRevs 时 cloudRev 仅由该源继承', async () => {
    adapter.data[CLOUD_CRED_KEY] = JSON.stringify(WEBDAV)
    adapter.data[CLOUD_REV_KEY] = 'legacy-hash'
    const saveCred = vi.fn().mockResolvedValue(undefined)

    await expect(migrateLegacySources(adapter, { saveCred })).resolves.toBe(1)
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
    await migrateLegacySources(adapter, { saveCred })
    const sources = adapter.data[SOURCES_KEY]
    const revs = adapter.data[SOURCE_REVS_KEY]

    saveCred.mockClear()
    await expect(migrateLegacySources(adapter, { saveCred })).resolves.toBe(0)
    expect(saveCred).not.toHaveBeenCalled()
    expect(adapter.data[SOURCES_KEY]).toBe(sources)
    expect(adapter.data[SOURCE_REVS_KEY]).toBe(revs)
  })

  it('④无旧键：返回 0 且不创建 sources/sourceRevs 键', async () => {
    await expect(migrateLegacySources(adapter, { saveCred: vi.fn() })).resolves.toBe(0)
    expect(SOURCES_KEY in adapter.data).toBe(false)
    expect(SOURCE_REVS_KEY in adapter.data).toBe(false)
  })

  it('⑤坏 JSON 安全默认：cloudCreds/cloudCred 不可解析 → 返回 0 且旧键保留（读不出 = 不删）', async () => {
    adapter.data[CLOUD_CREDS_KEY] = '{not-json'
    adapter.data[CLOUD_CRED_KEY] = JSON.stringify(WEBDAV) // 新键坏时不回退旧键（与旧 loadCreds 口径一致）
    await expect(migrateLegacySources(adapter, { saveCred: vi.fn() })).resolves.toBe(0)
    expect(adapter.data[CLOUD_CREDS_KEY]).toBe('{not-json')
    expect(adapter.data[CLOUD_CRED_KEY]).toBe(JSON.stringify(WEBDAV))

    delete adapter.data[CLOUD_CREDS_KEY]
    adapter.data[CLOUD_CRED_KEY] = '{bad'
    await expect(migrateLegacySources(adapter, { saveCred: vi.fn() })).resolves.toBe(0)
    expect(adapter.data[CLOUD_CRED_KEY]).toBe('{bad')
  })

  it('⑥迁移失败不删旧键（先写新后删旧）：saveCred 抛错 → 异常上抛，旧键原样保留', async () => {
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify([
      { cred: WEBDAV, enabled: true },
      { cred: GIST, enabled: true },
    ])
    adapter.data[CLOUD_REVS_KEY] = JSON.stringify({ webdav: 'w-hash' })
    const saveCred = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('需先启用加密才能保存云凭据'))

    await expect(migrateLegacySources(adapter, { saveCred })).rejects.toThrow('需先启用加密才能保存云凭据')
    // 源列表已先行写入（重跑按 id 去重），但旧键一律不删：数据双在，重跑自愈
    expect(adapter.data[CLOUD_CREDS_KEY]).toBe(JSON.stringify([
      { cred: WEBDAV, enabled: true },
      { cred: GIST, enabled: true },
    ]))
    expect(adapter.data[CLOUD_REVS_KEY]).toBe(JSON.stringify({ webdav: 'w-hash' }))
  })

  it('⑦中断重跑：盘上已有同 id 源时元数据去重不覆盖，凭据/基线重放幂等', async () => {
    // 模拟 ⑥ 中断后用户手动改过源名再重跑：已存在同 id 源的元数据保留
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify([{ cred: WEBDAV, enabled: true }])
    adapter.data[SOURCES_KEY] = JSON.stringify([
      { id: 'webdav', kind: 'webdav', name: '我的 WebDAV', retention: { type: 'keep', n: 5 }, enabled: false },
    ])
    const saveCred = vi.fn().mockResolvedValue(undefined)

    await expect(migrateLegacySources(adapter, { saveCred })).resolves.toBe(1)
    expect(JSON.parse(adapter.data[SOURCES_KEY]!)).toEqual([
      { id: 'webdav', kind: 'webdav', name: '我的 WebDAV', retention: { type: 'keep', n: 5 }, enabled: false },
    ])
    expect(saveCred).toHaveBeenCalledWith('webdav', WEBDAV) // 凭据重放（覆盖写幂等）
    expect(adapter.data[CLOUD_CREDS_KEY]).toBeUndefined() // 本次成功 → 旧键删除
  })

  it('⑧cloudRevs 中不属于迁移源的键不平移（防御：仅当对应源存在）', async () => {
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify([{ cred: WEBDAV, enabled: true }])
    adapter.data[CLOUD_REVS_KEY] = JSON.stringify({ webdav: 'w-hash', gdrive: 'ghost' })
    await migrateLegacySources(adapter, { saveCred: vi.fn() })
    expect(JSON.parse(adapter.data[SOURCE_REVS_KEY]!)).toEqual({ webdav: 'w-hash' })
  })

  it('⑨旧数组内同 backend 重复项 → 整体按 id 去重单源（审查 Minor），凭据只写一次、返回数准确', async () => {
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify([
      { cred: WEBDAV, enabled: true },
      { cred: { ...WEBDAV, password: 'p2' }, enabled: false }, // 同 backend 重复项（首现胜）
      { cred: GIST, enabled: true },
    ])
    const saveCred = vi.fn().mockResolvedValue(undefined)

    await expect(migrateLegacySources(adapter, { saveCred })).resolves.toBe(2) // 去重后实际迁移数
    expect(JSON.parse(adapter.data[SOURCES_KEY]!)).toEqual([
      { id: 'webdav', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true },
      { id: 'gist', kind: 'gist', name: 'GitHub Gist', retention: { type: 'overwrite' }, enabled: true },
    ])
    // 凭据按去重后的源各写一次（首现凭据胜）
    expect(saveCred).toHaveBeenCalledTimes(2)
    expect(saveCred).toHaveBeenCalledWith('webdav', WEBDAV)
    expect(saveCred).toHaveBeenCalledWith('gist', GIST)
  })
})

describe('loadSourcesImpl/saveSourcesImpl（core 包装）', () => {
  it('⑨roundtrip：saveSourcesImpl → loadSourcesImpl 原样还原', async () => {
    const sources = [{ id: 'webdav', kind: 'webdav' as const, name: 'WebDAV', retention: { type: 'overwrite' as const }, enabled: true }]
    await saveSourcesImpl(adapter, sources)
    await expect(loadSourcesImpl(adapter)).resolves.toEqual(sources)
  })

  it('⑩坏 JSON/空盘 → 安全默认 []', async () => {
    await expect(loadSourcesImpl(adapter)).resolves.toEqual([])
    adapter.data[SOURCES_KEY] = '{bad'
    await expect(loadSourcesImpl(adapter)).resolves.toEqual([])
  })
})

describe('hasLegacyCloudKeys（审查 I6：迁移跳过/失败后宿主据此置 UI 提示）', () => {
  it('无旧键 → false；四旧键任一存在 → true；迁移成功（旧键全删）后 → false', async () => {
    await expect(hasLegacyCloudKeys(adapter)).resolves.toBe(false)
    // 任一旧键滞留即 true（覆盖「仅 cloudCred 单对象」「仅 revs 键」等部分滞留形态）
    adapter.data[CLOUD_CRED_KEY] = JSON.stringify(WEBDAV)
    await expect(hasLegacyCloudKeys(adapter)).resolves.toBe(true)
    for (const k of [CLOUD_CREDS_KEY, CLOUD_REVS_KEY, CLOUD_REV_KEY]) adapter.data[k] = 'x'
    await expect(hasLegacyCloudKeys(adapter)).resolves.toBe(true)
    // 模拟迁移成功出口：旧键全删 → false（legacyNote 提示随之消失）
    for (const k of [CLOUD_CREDS_KEY, CLOUD_CRED_KEY, CLOUD_REVS_KEY, CLOUD_REV_KEY]) delete adapter.data[k]
    await expect(hasLegacyCloudKeys(adapter)).resolves.toBe(false)
  })

  it('storage 读取异常按 false（不因瞬态 IO 误报提示）', async () => {
    adapter.get = async () => {
      throw new Error('IO error')
    }
    await expect(hasLegacyCloudKeys(adapter)).resolves.toBe(false)
  })
})

describe('retentionDeletedNote（审查 Minor：deleted=0 无信息量不提示）', () => {
  it('deleted>0 → 「{name} 清理 N 份旧云备份」', () => {
    expect(retentionDeletedNote('WebDAV', 3)).toBe('WebDAV 清理 3 份旧云备份')
  })
  it('deleted=0 → null（宿主不追加清理提示）', () => {
    expect(retentionDeletedNote('WebDAV', 0)).toBeNull()
  })
  it('deleted<0（-1 哨兵=后端不支持远端清理）→ 降级提示', () => {
    expect(retentionDeletedNote('Gist', -1)).toBe('Gist 后端不支持远端清理')
  })
})

describe('conflictBackupName（审查 Minor-1）', () => {
  const d = new Date(2026, 8, 16, 12, 0, 0) // 2026-09-16 12:00:00 本地
  it('带 key：conflict-{key}-{yyyyMMdd-HHmmss}（与 desktop 同构，匹配 READABLE_BACKUP_RE）', () => {
    const name = conflictBackupName('webdav', d)
    expect(name).toBe('conflict-webdav-20260916-120000.totpbackup')
    expect(READABLE_BACKUP_RE.test(name)).toBe(true)
  })
  it('缺省：无段（旧名格式，同样可恢复）', () => {
    expect(conflictBackupName(undefined, d)).toBe('conflict-20260916-120000.totpbackup')
  })
})

describe('formatAutoStatusText（options App.vue formatAutoStatus 抽出，cloudAutoStatus 状态行格式化）', () => {
  // 本地时区构造 + 本地时区格式化，断言与运行环境时区无关
  const AT = new Date(2026, 8, 17, 14, 30).getTime()

  it('ok=true → 「YYYY-MM-DD HH:mm 成功：summary」', () => {
    expect(formatAutoStatusText(JSON.stringify({ at: AT, ok: true, summary: 'webdav: 已上传' }))).toBe('2026-09-17 14:30 成功：webdav: 已上传')
  })
  it('ok=false → 失败：summary', () => {
    expect(formatAutoStatusText(JSON.stringify({ at: AT, ok: false, summary: '网络错误' }))).toBe('2026-09-17 14:30 失败：网络错误')
  })
  it('ok=null → 跳过：summary（写侧 summary 仅存原因，前缀由格式化拼装）', () => {
    expect(formatAutoStatusText(JSON.stringify({ at: AT, ok: null, summary: '未启用云源' }))).toBe('2026-09-17 14:30 跳过：未启用云源')
  })
  it('向后兼容：旧 JSON 无 ok 字段 → 按失败渲染（现状语义不变）', () => {
    expect(formatAutoStatusText(JSON.stringify({ at: AT, summary: '旧数据' }))).toBe('2026-09-17 14:30 失败：旧数据')
  })
  it('缺字段/空 summary/坏 JSON/undefined → null（卡片显示「暂无」）', () => {
    expect(formatAutoStatusText(JSON.stringify({ summary: 'x' }))).toBeNull() // 缺 at
    expect(formatAutoStatusText(JSON.stringify({ at: AT, ok: true, summary: '' }))).toBeNull() // 空 summary
    expect(formatAutoStatusText('{bad json')).toBeNull()
    expect(formatAutoStatusText(undefined)).toBeNull()
  })
})
