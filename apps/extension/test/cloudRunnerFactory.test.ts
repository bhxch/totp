/**
 * cloudRunnerFactory 直接单测（P2a 补全，此前零直接测试）：
 * - revSeal 三态（spec §1.2 静态保护）：加密 → DEK 密文落盘；未启用 → 明文回落；锁定在途 →
 *   seal 抛 'vault locked' 原样上抛（不得明文回落）；unseal 不可解（null）回落原文
 * - run 包装（T4/审查 I2）：onAuthFailure 暂存 → runner resolve 后转 reject + status 挂错误对象
 *   （否则 syncScheduler 凭据失效分类/停轮询永不触发）；无失效时正常 resolve、跨轮复位
 * - loadSources 装配：过滤 local 源与无凭据源；sourceName 缓存每轮刷新、取不到回退 id
 * - 桥接面：saveConflictBackup→addConflictCopy、onMergeConflicts fire-and-forget 失败不扩散、
 *   onConflicts→cloudConflictCount 落盘+badge、onRetentionDeleted→retentionNotes（deleted=0 不追加）、
 *   kdfProfile/persistAdopted/conflictCount/onManualConfirm/onProgress 透传
 *
 * mock 策略：@totp/ui 整模块 mock（createCloudSyncRunner 捕获 deps 供逐成员驱动——runner 本体
 * 由 ui 包测试覆盖，此处验证宿主装配接线；形状完整防 TypeError 假绿）；../src/store 只 mock
 * storageAdapter（内存键值），core 侧 loadSources/saveSources 真实走同一 adapter。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const testScope = vi.hoisted(() => ({
  adapterData: {} as Record<string, string>,
  /** 捕获工厂传入 createCloudSyncRunner 的完整 deps（桥接断言直接驱动各成员） */
  runnerDeps: null as { [k: string]: (...args: never[]) => unknown } | null,
  /** runner.run 的可编程实现（onAuthFailure 由它模拟 runner 轮内上抛） */
  runImpl: null as null | ((mode?: 'auto' | 'manual' | 'pull') => Promise<void>),
}))

vi.mock('../src/store', async () => ({
  storageAdapter: {
    get: vi.fn(async (key: string) => testScope.adapterData[key] ?? null),
    set: vi.fn(async (key: string, value: string) => {
      testScope.adapterData[key] = value
    }),
    delete: vi.fn(async (key: string) => {
      delete testScope.adapterData[key]
    }),
  },
}))

vi.mock('@totp/ui', async () => {
  const fn = (await import('vitest')).vi.fn
  return {
    createCloudSyncRunner: fn((deps: { [k: string]: (...args: never[]) => unknown }) => {
      testScope.runnerDeps = deps
      return {
        run: (mode?: 'auto' | 'manual' | 'pull') => testScope.runImpl!(mode),
      }
    }),
    createCloudBackend: fn((cred: { backend: string }) => ({
      id: cred.backend,
      put: fn(async () => {}),
      get: fn(async () => null),
      delete: fn(async () => {}),
      exists: fn(async () => false),
    })),
    requestMergeConfirm: fn(async (preview: unknown) => ({ preview, ok: true })),
    setSyncProgress: fn(),
  }
})

import { createMemoryStorage, loadDeviceId, loadSyncState, saveSources, saveSyncState } from '@totp/core'
import { createExtensionCloudRunner, revSeal } from '../src/cloudRunnerFactory'
import { CONFLICT_COPIES_KEY, listConflictCopies } from '../src/conflictCopies'
import { createCloudBackend, requestMergeConfirm, setSyncProgress } from '@totp/ui'
import { installChromeShim } from './helpers/chromeShim'

// ext 惰性桥：conflictBadge 的 badge 能力探测读 globalThis.chrome（badge 用例现场注入 shim）
vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())

/** zh 翻译桩（与 ui locale cloudAuto 段逐字一致；同 cloudCredStore.test 口径） */
const t = (key: string, params: Record<string, unknown> = {}): string => {
  const table: Record<string, string> = {
    'cloudAuto.noteSep': '；',
    'cloudAuto.retentionDeleted': '{name} 清理 {count} 份旧云备份',
    'cloudAuto.retentionUnsupported': '{name} 后端不支持远端清理',
  }
  return (table[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]))
}

/** 宿主 store 替身：仅需工厂消费的成员（锁定态/口令/vault/凭据缓存/settings/冲突面/DEK seal） */
function makeStore(over: Partial<Record<string, unknown>> = {}): Parameters<typeof createExtensionCloudRunner>[0]['store'] {
  return {
    locked: { value: false },
    backupSecret: { value: 'pw' },
    vault: { entries: [{ uuid: 'e1' }], tags: [] },
    credsCache: {
      value: { webdav: { backend: 'webdav', serverUrl: 'https://dav', username: 'u', password: 'p' } },
    },
    settings: { backupKdfProfile: 'fast' },
    conflictCount: { value: 3 },
    replaceAllOp: vi.fn(async () => {}),
    addMergeConflictsOp: vi.fn(async () => {}),
    sealWithDek: vi.fn(async () => null as string | null),
    unsealWithDek: vi.fn(async () => null as string | null),
    ...over,
  } as never
}

const WEBDAV_CRED = { backend: 'webdav' as const, serverUrl: 'https://dav', username: 'u', password: 'p' }

/** 测试内直读的内存 adapter（与 mock 的 storageAdapter 共享同一键值空间） */
function memoryAdapter() {
  return {
    get: async (k: string) => testScope.adapterData[k] ?? null,
    set: async (k: string, v: string) => {
      testScope.adapterData[k] = v
    },
    delete: async (k: string) => {
      delete testScope.adapterData[k]
    },
  }
}

// 测试驱动用动态视图：runner deps 成员签名各异（core/ui/宿主混合形态），
// 逐成员静态声明反而失真——测试内以 any 视图直调并断言接线
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deps(): any {
  return testScope.runnerDeps
}

beforeEach(() => {
  for (const k of Object.keys(testScope.adapterData)) delete testScope.adapterData[k]
  testScope.runImpl = async () => {}
})

describe('revSeal 三态（spec §1.2 静态保护，锁定态拒落明文）', () => {
  it('加密态：sealWithDek 非空 → baseSnapshot 以 DEK 密文落盘（明文子串不落盘），读回一致', async () => {
    const store = makeStore({
      sealWithDek: vi.fn(async (plain: string) => `ENC:${btoa(plain)}`),
      unsealWithDek: vi.fn(async (sealed: string) => atob(sealed.slice(4))),
    })
    const state = { lastKnownRemoteRev: 5, baseSnapshot: 'SECRET-BASE-SNAPSHOT' }
    await saveSyncState(memoryAdapter() as never, 'src', state, revSeal(store))
    const raw = testScope.adapterData['cloudSyncState']!
    expect(raw).toContain('ENC:')
    expect(raw).not.toContain('SECRET-BASE-SNAPSHOT')
    expect(await loadSyncState(memoryAdapter() as never, 'src', revSeal(store))).toEqual(state)
  })

  it('未启用加密（seal 返回 null）→ 明文回落落盘；unseal 返回 null（非密文）→ 回落原文可解析', async () => {
    const store = makeStore() // sealWithDek/unsealWithDek 缺省 resolve null
    const state = { lastKnownRemoteRev: 2, baseSnapshot: 'PLAIN-BASE' }
    await saveSyncState(memoryAdapter() as never, 'src', state, revSeal(store))
    expect(testScope.adapterData['cloudSyncState']!).toContain('PLAIN-BASE') // 明文库明文落盘（与 core 缺省语义对齐）
    expect(await loadSyncState(memoryAdapter() as never, 'src', revSeal(store))).toEqual(state)
  })

  it('锁定在途（sealWithDek 抛 vault locked）→ 整体失败上抛，绝不回落明文落盘', async () => {
    const store = makeStore({
      sealWithDek: vi.fn(async () => {
        throw new Error('vault locked')
      }),
    })
    await expect(
      saveSyncState(memoryAdapter() as never, 'src', { lastKnownRemoteRev: 5, baseSnapshot: 'SECRET' }, revSeal(store)),
    ).rejects.toThrow('vault locked')
    expect(testScope.adapterData['cloudSyncState']).toBeUndefined() // 零明文落盘（按下轮重做处理）
  })
})

describe('createExtensionCloudRunner 装配（deps 逐成员接线）', () => {
  it('runner 构造：锁态/口令/vault 快照/kdfProfile/conflictCount 均取自注入 store', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = makeStore()
    createExtensionCloudRunner({ store, t })
    expect(deps().isLocked()).toBe(false)
    expect(deps().getSecret()).toBe('pw')
    expect(JSON.parse(deps().getVaultJson() as never as string)).toEqual(store.vault)
    expect(deps().kdfProfile()).toBe('fast') // store.settings.backupKdfProfile 透传
    expect(deps().conflictCount()).toBe(3)
    // onError 桥：runner 全程意外抛错时 console.warn 留痕
    deps().onError('意外错误')
    expect(warnSpy).toHaveBeenCalledWith('[cloudAutoSync]', '意外错误')
    warnSpy.mockRestore()
  })

  it('loadSources：过滤 local 源与无凭据源，只装配「启用云源×凭据」对；sourceName 缓存刷新与回退 id', async () => {
    createExtensionCloudRunner({ store: makeStore(), t })
    await saveSources(memoryAdapter() as never, [
      { id: 'webdav', kind: 'webdav', name: '我的网盘', retention: { type: 'overwrite' }, enabled: true, role: 'primary' },
      { id: 'gist', kind: 'gist', name: 'Gist 备份', retention: { type: 'overwrite' }, enabled: true, role: 'replica' },
      { id: 'local', kind: 'local', name: '本地目录', retention: { type: 'overwrite' }, enabled: true, role: 'replica' },
    ] as never)
    const pairs = await (deps().loadSources as () => Promise<Array<{ source: { id: string } }>>)()
    // local 源归本地备份卡（extension 无）；gist 无凭据（credsCache 缺席）→ 跳过不阻塞
    expect(pairs.map((p) => p.source.id)).toEqual(['webdav'])
    // sourceName：loadSources 装配时刷新缓存 → 显示名；缓存外 id 回退原值
    expect(deps().sourceName('webdav')).toBe('我的网盘')
    expect(deps().sourceName('ghost')).toBe('ghost')
    // 每轮刷新：改名后 loadSources 再次装配 → 新显示名生效
    await saveSources(memoryAdapter() as never, [
      { id: 'webdav', kind: 'webdav', name: '改名网盘', retention: { type: 'overwrite' }, enabled: true, role: 'primary' },
    ] as never)
    await (deps().loadSources as () => Promise<unknown[]> )()
    expect(deps().sourceName('webdav')).toBe('改名网盘')
  })

  it('loadSyncState/saveSyncState 桥接 storageAdapter + revSeal（未启用加密=明文往返）；deviceId 持久化', async () => {
    createExtensionCloudRunner({ store: makeStore(), t })
    await (deps().saveSyncState as (id: string, st: unknown) => Promise<void>)('src', { lastKnownRemoteRev: 4, baseSnapshot: '{"v":2}' })
    expect(await (deps().loadSyncState as (id: string) => Promise<unknown>)('src')).toEqual({ lastKnownRemoteRev: 4, baseSnapshot: '{"v":2}' })
    // bag 为 JSON 对象（明文形态，键 cloudSyncState），内嵌快照串经转义存储
    expect(testScope.adapterData['cloudSyncState']).toContain('"lastKnownRemoteRev":4')
    expect(testScope.adapterData['cloudSyncState']).toContain('baseSnapshot')
    // deviceId：经 core loadDeviceId 持久（二次同值）
    const d1 = await (deps().deviceId as () => Promise<string>)()
    expect(d1).toMatch(/^[0-9a-f-]{36}$/)
    expect(await loadDeviceId(memoryAdapter() as never)).toBe(d1)
  })

  it('内容门基线（cloudContentHash）与 makeBackend/persistAdopted 透传', async () => {
    const store = makeStore()
    createExtensionCloudRunner({ store, t })
    expect(await (deps().loadContentHash as () => Promise<string | null>)()).toBeNull()
    await (deps().saveContentHash as (h: string | null) => Promise<void>)('abc123')
    expect(testScope.adapterData['cloudContentHash']).toBe('abc123')
    await (deps().saveContentHash as (h: string | null) => Promise<void>)(null)
    expect(testScope.adapterData['cloudContentHash']).toBeUndefined() // null=删除（强制下轮重试）
    // makeBackend → ui createCloudBackend(cred)
    deps().makeBackend(WEBDAV_CRED as never)
    expect(createCloudBackend).toHaveBeenCalledWith(WEBDAV_CRED)
    // persistAdopted → store.replaceAllOp(JSON.parse(json))
    await (deps().persistAdopted as (json: string) => Promise<void>)('{"entries":[{"uuid":"r1"}]}')
    expect(store.replaceAllOp).toHaveBeenCalledWith({ entries: [{ uuid: 'r1' }] })
  })

  it('saveConflictBackup → addConflictCopy（storage.local 列表），返回副本名', async () => {
    createExtensionCloudRunner({ store: makeStore(), t })
    const name = await (deps().saveConflictBackup as (k: string, b: Uint8Array) => Promise<string>)('webdav', new TextEncoder().encode('ENVELOPE'))
    expect(name).toMatch(/^conflict-webdav-\d{8}-\d{6}\.totpbackup$/)
    const list = await listConflictCopies(memoryAdapter() as never)
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe(name)
    expect(testScope.adapterData[CONFLICT_COPIES_KEY]).toBeDefined()
  })

  it('onMergeConflicts fire-and-forget：入库 reject 不扩散（console.warn 留痕，不抛出）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = makeStore({ addMergeConflictsOp: vi.fn(async () => { throw new Error('锁定态入库失败') }) })
      createExtensionCloudRunner({ store, t })
      expect(() => deps().onMergeConflicts([{ entryId: 'e1' }] as never)).not.toThrow()
      await new Promise((r) => setTimeout(r, 0))
      expect(store.addMergeConflictsOp).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('onConflicts → cloudConflictCount 落盘 + action badge「!」/0 清空（存在性守卫经 chromeShim）', async () => {
    const shim = installChromeShim()
    try {
      createExtensionCloudRunner({ store: makeStore(), t })
      deps().onConflicts(2)
      await new Promise((r) => setTimeout(r, 0))
      expect(testScope.adapterData['cloudConflictCount']).toBe('2')
      expect(shim.setBadgeText).toHaveBeenCalledWith({ text: '!' })
      deps().onConflicts(0)
      await new Promise((r) => setTimeout(r, 0))
      expect(shim.setBadgeText).toHaveBeenLastCalledWith({ text: '' })
    } finally {
      shim.restore()
    }
  })

  it('onRetentionDeleted → retentionNotes 并入 recordStatus summary（deleted=0 不追加，不跨轮残留）', async () => {
    createExtensionCloudRunner({ store: makeStore(), t })
    deps().onRetentionDeleted('我的网盘', 3)
    deps().onRetentionDeleted('Gist', -1)
    deps().onRetentionDeleted('无信息量', 0) // deleted=0 → null 不追加
    deps().recordStatus(true, 'webdav: 已上传')
    await new Promise((r) => setTimeout(r, 0))
    const record = JSON.parse(testScope.adapterData['cloudAutoStatus']!) as { ok: boolean; summary: string }
    expect(record.ok).toBe(true)
    expect(record.summary).toBe('webdav: 已上传；我的网盘 清理 3 份旧云备份；Gist 后端不支持远端清理')
    // 清空后不跨轮残留：下一轮 recordStatus 不再拼接旧 notes
    deps().recordStatus(true, '第二轮')
    await new Promise((r) => setTimeout(r, 0))
    const second = JSON.parse(testScope.adapterData['cloudAutoStatus']!) as { summary: string }
    expect(second.summary).toBe('第二轮')
  })

  it('onManualConfirm/onProgress 桥接 cloudSyncBridge（requestMergeConfirm/setSyncProgress 透传）', async () => {
    createExtensionCloudRunner({ store: makeStore(), t })
    const preview = { conflicts: [], mergeDegraded: false, sourceName: '我的网盘' }
    const ok = await (deps().onManualConfirm as (p: typeof preview) => Promise<{ ok: boolean }>)(preview)
    expect(ok.ok).toBe(true)
    expect(requestMergeConfirm).toHaveBeenCalledWith(preview)
    deps().onProgress(1, 2)
    expect(setSyncProgress).toHaveBeenCalledWith(1, 2)
  })
})

describe('run 包装（T4 凭据失效 → resolve 后转 reject）', () => {
  it('onAuthFailure 暂存：runner resolve 后 run 转 reject，status 挂错误对象（结构化判定优先）', async () => {
    const runner = createExtensionCloudRunner({ store: makeStore(), t })
    testScope.runImpl = async () => {
      deps().onAuthFailure('Google Drive 请求失败（HTTP 401）', 401)
    }
    const err = await runner.run('auto').then(() => null, (e: unknown) => e)
    expect((err as Error).message).toBe('Google Drive 请求失败（HTTP 401）')
    expect((err as Error & { status?: number }).status).toBe(401)
  })

  it('无 status 的凭据失效消息 → reject 不挂 status（调度器消息兜底分类）', async () => {
    const runner = createExtensionCloudRunner({ store: makeStore(), t })
    testScope.runImpl = async () => {
      deps().onAuthFailure('WebDAV 请求失败（HTTP 403）')
    }
    const err = await runner.run('pull').then(() => null, (e: unknown) => e)
    expect((err as Error).message).toContain('403')
    expect((err as Error & { status?: number }).status).toBeUndefined()
  })

  it('无凭据失效 → 正常 resolve；失效跨轮复位（上一轮失败不毒化下一轮）', async () => {
    const runner = createExtensionCloudRunner({ store: makeStore(), t })
    let fail = true
    testScope.runImpl = async () => {
      if (fail) deps().onAuthFailure('S3 请求失败（HTTP 401）', 401)
    }
    await expect(runner.run('auto')).rejects.toThrow('S3 请求失败')
    fail = false
    await expect(runner.run('auto')).resolves.toBeUndefined() // 复位：不再误抛
  })
})
