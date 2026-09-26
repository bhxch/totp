/**
 * options 宿主装配直接单测（R4 改写，不再 mount 整组件——本改写本身即 R4 验收标准）：
 * 平台装配已抽至 src/optionsPlatforms.ts（循 cloudRunnerFactory 先例），宿主装配可脱离
 * App.vue 生命周期直接驱动。覆盖面（对应原 mount 版装配断言）：
 * - createOptionsCloudPlatform（ui host createStoreBackedCloudPlatform + extension 差异注入）：
 *   autoPrefs 通道 normalize/双写、revSeal 共用 cloudSyncState 键（DEK seal/明文回落）、
 *   源模型/保管区 op、persistDownloaded、冲突副本列表、状态文本三态格式化；
 * - createOptionsSecurityPlatform（ui host createSecurityOpsFromStore + ext 差异）：
 *   kdfProfile/passwordChangedAt computed 兜底、lockPrefs 三字段读写与 unsupported、
 *   剪贴板/关窗延迟提交、changePassphrase opts 透传（漏接=档位切换误触发全库轮换）；
 * - createOptionsBackupPlatform：时间戳命名摘要/backupMode 化石恒定名、kdfProfile get/set、
 *   saveTextFile/saveImageFile（Blob 下载恒 true）、文件选择 cancel/lastImportFile 复用/30s 超时；
 * - createOptionsSyncPlatform：canSync/setSyncEnabled 双向（sync-pull 调度 vs markSyncOff）/
 *   readStatus 三态；
 * - createOptionsSchemesApi：load 容错回空表/save 落键；
 * - createFollowScheduler：3min tick 轮询、onAuthFailed 停轮询置位（T4 防风暴）、
 *   popup 形态 intervalMs null 不轮询。
 * App.vue 生命周期编排（onMounted 挂载序列/旧数据迁移提示/badge 对账）不再在本文件覆盖——
 * 装配抽出走本文件直测后，编排行为归真机 E2E（docs/e2e-test.md 惯例）；runner 装配接线
 * （deps 逐成员/run 包装）由 cloudRunnerFactory.test.ts 承载，syncScheduler 本体由
 * syncScheduler.test.ts 承载。
 *
 * mock 策略：../src/store 只 mock storageAdapter（内存键值，真实模块 import 期即建 popup
 * store 单例必须拦下）；extApi 走惰性桥 mock + installChromeShim 逐用例注入；
 * syncEngine/conflictBadge 替身（宿主只断言接线）；core/cloudCredStore/conflictCopies/
 * syncScheduler 走真实实现（纯调度与纯函数），装配断言覆盖「deps 形状正确 + 真实运转」两端。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import type { BackupSource } from '@totp/core'
import type { CloudPlatform, SecurityPlatform } from '@totp/ui'

const testScope = vi.hoisted(() => ({
  /** storageAdapter mock 的内存键值空间（与 core 读写共享，loadSources/saveSources 真实走） */
  adapterData: {} as Record<string, string>,
  markSyncOff: vi.fn(async () => {}),
  setConflictBadge: vi.fn(),
}))

vi.mock('../src/store', () => ({
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

vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())
vi.mock('../src/syncEngine', () => ({
  // 形状完整（popup/options 宿主 + background 共用模块面）
  pullSyncIfNewer: vi.fn(async () => {}),
  pushSync: vi.fn(async () => {}),
  markSyncOff: testScope.markSyncOff,
  needsPullBeforePush: () => false,
  SYNC_STATUS_KEY: 'sync:status',
}))
vi.mock('../src/conflictBadge', () => ({ setConflictBadge: testScope.setConflictBadge }))

import { installChromeShim, type ChromeShim } from './helpers/chromeShim'
import {
  createCloudAutoPrefsChannel, createFollowScheduler, createOptionsBackupPlatform, createOptionsCloudPlatform,
  createOptionsSchemesApi, createOptionsSecurityPlatform, createOptionsSyncPlatform, scheduleClipboardClear,
} from '../src/optionsPlatforms'
import { storageAdapter } from '../src/store'
import { markSyncOff } from '../src/syncEngine'
import { CONFLICT_COPIES_KEY } from '../src/conflictCopies'

/** zh 翻译桩（options.* / cloudAuto.* 段与 ui locales/zh 逐字一致；同 cloudRunnerFactory.test 口径） */
const t = (key: string, params: Record<string, unknown> = {}): string => {
  const table: Record<string, string> = {
    'options.exported': '已导出备份文件 {name}',
    'options.exportedOverwrite': '已覆盖导出备份文件 {name}',
    'cloudAuto.statusOk': '成功',
    'cloudAuto.statusFailed': '失败',
    'cloudAuto.statusSkipped': '跳过',
    'cloudAuto.statusSep': '：',
  }
  return (table[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(params[k]))
}

/** 宿主 store 替身：optionsPlatforms 各工厂消费的成员（settings 为 reactive，读写断言直查） */
function makeStore(over: Record<string, unknown> = {}) {
  const settings = reactive({
    locale: 'zh',
    rememberTagFilter: false,
    lastTagFilterIds: [] as string[],
    tagFilterMode: 'all',
    urlFilterEnabled: false,
    popupCloseDelayMs: 3000,
    clipboardClearEnabled: false,
    syncEnabled: false,
    syncPrefs: { autoFollow: true },
    backupKdfProfile: 'balanced',
    lockOnRestart: true,
    lockIdleMinutes: 0,
    lockOnSystemLock: true,
  })
  const store = {
    settings,
    vault: reactive({ entries: [] as unknown[], tags: [] as unknown[] }),
    locked: ref(false),
    hasEncryption: ref(false),
    backupSecret: ref('pw'),
    credsCache: ref({} as Record<string, unknown>),
    securitySettings: ref(null as { profile?: string; passwordChangedAt?: number } | null),
    prfSources: ref([] as Array<{ credentialId: string }>),
    conflictCount: { value: 0 },
    commitSettings: vi.fn(async () => {}),
    enableEncryption: vi.fn(async () => {}),
    disableEncryption: vi.fn(async () => {}),
    changePassphrase: vi.fn(async () => {}),
    replaceAllOp: vi.fn(async () => {}),
    saveSourceCredOp: vi.fn(async () => {}),
    removeSourceCredOp: vi.fn(async () => {}),
    lock: vi.fn(),
    addMergeConflictsOp: vi.fn(async () => {}),
    sealWithDek: vi.fn(async () => null as string | null),
    unsealWithDek: vi.fn(async () => null as string | null),
  }
  return Object.assign(store, over)
}

const src = (over: Partial<BackupSource> = {}): BackupSource => ({
  id: 's1', kind: 'webdav', name: '家里 WebDAV', retention: { type: 'overwrite' }, enabled: true, role: 'primary', ...over,
})
const cred = { kind: 'webdav', user: 'u' }

/** jsdom 未实现 URL.createObjectURL/revokeObjectURL——Blob 下载通道（downloadBlob）stub */
function stubBlobUrl(): void {
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock');
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
}

let shim: ChromeShim

beforeEach(() => {
  for (const k of Object.keys(testScope.adapterData)) delete testScope.adapterData[k]
  vi.mocked(storageAdapter.get).mockClear()
  vi.mocked(storageAdapter.set).mockClear()
  testScope.markSyncOff.mockClear()
  testScope.setConflictBadge.mockClear()
  shim = installChromeShim()
})

afterEach(async () => {
  vi.useRealTimers()
  shim.restore()
  localStorage.clear()
  await flushPromises()
})

describe('createOptionsCloudPlatform（host 装配 + extension 差异注入）', () => {
  function makePlatform(storeOverrides: Record<string, unknown> = {}) {
    const store = makeStore(storeOverrides)
    const autoPrefs = createCloudAutoPrefsChannel(storageAdapter)
    const platform = createOptionsCloudPlatform({ store: store as never, t, autoPrefs })
    return { platform, store, autoPrefs }
  }

  it('autoPrefs 通道 normalize：间隔<15 回退 60、缺失位 false；合法值原样（refresh 后同步可见）', async () => {
    const { platform, autoPrefs } = makePlatform()
    testScope.adapterData['cloudAutoPrefs'] = '{"onChange":true,"onInterval":true,"intervalMinutes":10}'
    await autoPrefs.refresh()
    expect(platform.autoPrefs.get()).toEqual({ onChange: true, onInterval: true, intervalMinutes: 60 })

    testScope.adapterData['cloudAutoPrefs'] = '{"onChange":true}'
    await autoPrefs.refresh()
    expect(platform.autoPrefs.get()).toEqual({ onChange: true, onInterval: false, intervalMinutes: 60 })

    testScope.adapterData['cloudAutoPrefs'] = '{"onChange":false,"onInterval":true,"intervalMinutes":30}'
    await autoPrefs.refresh()
    expect(platform.autoPrefs.get()).toEqual({ onChange: false, onInterval: true, intervalMinutes: 30 })
  })

  it('autoPrefs.set：先更缓存（同步可见）再异步落盘', async () => {
    const { platform } = makePlatform()
    const prefs = { onChange: false, onInterval: true, intervalMinutes: 45 }
    await platform.autoPrefs.set(prefs)
    expect(platform.autoPrefs.get()).toEqual(prefs)
    expect(storageAdapter.set).toHaveBeenCalledWith('cloudAutoPrefs', JSON.stringify(prefs))
  })

  it('revSeal 共用 cloudSyncState 键：saveSourceState 经 store DEK seal（未启用→明文回落）', async () => {
    const { platform, store } = makePlatform()

    await platform.loadSourceState('s1')
    expect(storageAdapter.get).toHaveBeenCalledWith('cloudSyncState')

    await platform.saveSourceState('s1', { lastKnownRemoteRev: 2, baseSnapshot: 'SNAP' })
    expect(store.sealWithDek).toHaveBeenCalledWith(expect.stringContaining('SNAP')) // seal 侧绑定 store
    expect(testScope.adapterData['cloudSyncState']).toContain('SNAP') // sealWithDek null（未启用加密）→ 明文回落
  })

  it('loadSources/saveSources 走 storageAdapter（backupSources 键）；saveCred/removeCred 走保管区 op', async () => {
    const { platform, store } = makePlatform()

    await expect(platform.loadSources()).resolves.toEqual([])
    await platform.saveSources([src()])
    expect(storageAdapter.set).toHaveBeenCalledWith('backupSources', expect.stringContaining('s1'))

    await platform.saveCred('s1', cred as never)
    expect(store.saveSourceCredOp).toHaveBeenCalledWith('s1', cred)
    await platform.removeCred('s1')
    expect(store.removeSourceCredOp).toHaveBeenCalledWith('s1')
  })

  it('persistDownloaded → replaceAllOp 整体替换', async () => {
    const { platform, store } = makePlatform()
    await platform.persistDownloaded('{"entries":[],"tags":[]}')
    expect(store.replaceAllOp).toHaveBeenCalledWith({ entries: [], tags: [] })
  })

  it('saveConflictBackup/listConflictCopies 走 conflictCopies 列表；loadAutoStatus 三态格式化', async () => {
    testScope.adapterData['cloudAutoStatus'] = JSON.stringify({ at: 1, ok: true, summary: '同步完成' })
    const { platform } = makePlatform()

    // 副本入列表（storage.local conflictCopies 键，限 5 滚动删——本体 conflictCopies.test.ts 已测）
    const name = await platform.saveConflictBackup!(new Uint8Array([1]), 's1')
    expect(name).toMatch(/^conflict-s1-\d{8}-\d{6}\.totpbackup$/)
    expect(testScope.adapterData[CONFLICT_COPIES_KEY]).toContain('s1')
    const list = await platform.listConflictCopies!()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: name! })

    // loadAutoStatus：cloudAutoStatus 键原文 → 展示时三态格式化（ok=true 文案 + 摘要）
    const text = await platform.loadAutoStatus!()
    expect(text).toContain('同步完成')
    expect(text).toContain('成功')
  })

  it('onManualSynced 注入：装配后平台成员携带恢复闭环回调', () => {
    const onManualSynced = vi.fn()
    const store = makeStore()
    const platform = createOptionsCloudPlatform({ store: store as never, t, autoPrefs: createCloudAutoPrefsChannel(storageAdapter), onManualSynced })
    expect((platform as CloudPlatform).onManualSynced).toBe(onManualSynced)
  })
})

describe('createOptionsSecurityPlatform（host security ops + ext 差异）', () => {
  function makeSecurity() {
    const store = makeStore()
    const sec = createOptionsSecurityPlatform(store as never)
    return { sec, store }
  }

  it('kdfProfile/passwordChangedAt computed（securitySettings null 兜底 balanced/null）；闭包绑 store', async () => {
    const { sec, store } = makeSecurity()

    expect(sec.security!.kdfProfile.value).toBe('balanced')
    expect(sec.security!.passwordChangedAt.value).toBeNull()

    store.securitySettings.value = { profile: 'paranoid', passwordChangedAt: 123 }
    await Promise.resolve()
    expect(sec.security!.kdfProfile.value).toBe('paranoid')
    expect(sec.security!.passwordChangedAt.value).toBe(123)

    // security 闭包绑定 store：改密透传（漏接=档位切换误触发全库轮换）
    await sec.security!.changePassphrase('new-pw', { rotateDek: true })
    expect(store.changePassphrase).toHaveBeenCalledWith('new-pw', { rotateDek: true })
  })

  it('lockPrefs 三字段读写 + unsupported=[lockOnRestart]（ext 无效控件隐藏）；剪贴板/关窗延迟提交', async () => {
    const { sec, store } = makeSecurity()

    expect((sec as SecurityPlatform).lockPrefs!.get()).toEqual({ lockOnRestart: true, lockIdleMinutes: 0, lockOnSystemLock: true })
    expect((sec as SecurityPlatform).lockPrefs!.unsupported).toEqual(['lockOnRestart'])

    await (sec as SecurityPlatform).lockPrefs!.set({ lockOnRestart: true, lockIdleMinutes: 30, lockOnSystemLock: true })
    expect(store.settings.lockIdleMinutes).toBe(30)

    await sec.setClipboardClear(true)
    expect(store.settings.clipboardClearEnabled).toBe(true)

    await sec.setPopupCloseDelay!(5000)
    expect(store.settings.popupCloseDelayMs).toBe(5000)
    expect(store.commitSettings).toHaveBeenCalled()
  })
})

describe('createOptionsBackupPlatform（Blob 下载 + 文件选择 + 化石命名）', () => {
  function makeBackup() {
    const store = makeStore()
    const platform = createOptionsBackupPlatform(store as never, t)
    return { platform, store }
  }

  afterEach(() => {
    localStorage.removeItem('backupMode')
    localStorage.removeItem('backupKeepN')
  })

  it('createBackup 按时间戳命名出摘要；backupMode 化石 overwrite 恒定名', async () => {
    stubBlobUrl()
    const { platform } = makeBackup()

    const summary = await platform.createBackup('{"entries":[],"tags":[]}', 'pw')
    expect(summary).toContain('已导出备份文件')
    expect(summary).toContain('.totpbackup')

    // 【只读兼容化石】localStorage backupMode='overwrite' → 固定名 vault-backup.totpbackup
    localStorage.setItem('backupMode', 'overwrite')
    const { platform: platform2 } = makeBackup()
    const summary2 = await platform2.createBackup('{"entries":[],"tags":[]}', 'pw')
    expect(summary2).toContain('vault-backup.totpbackup')
    expect(summary2).toContain('已覆盖导出')
  })

  it('kdfProfile 档位 get/set；saveTextFile/saveImageFile 走 Blob 下载恒 true', async () => {
    stubBlobUrl()
    const { platform, store } = makeBackup()

    expect(platform.backupKdfProfile!.get()).toBe('balanced')
    await platform.backupKdfProfile!.set('paranoid')
    expect(store.settings.backupKdfProfile).toBe('paranoid')

    await expect(platform.saveTextFile!('codes.txt', 'otpauth://x')).resolves.toBe(true)
    await expect(platform.saveImageFile!('qr.png', 'data:image/png;base64,AAAA')).resolves.toBe(true)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('文件选择取消（input cancel 事件）→ null；readImportFile 缓存 lastImportFile 供字节入口复用', async () => {
    const { platform } = makeBackup()

    // 恢复通道取消：pickFile 挂到 body 的 input 派发 cancel
    const restoreP = platform.restoreFromPicker!('pw')
    const restoreInput = document.body.querySelector('input[type="file"]') as HTMLInputElement
    expect(restoreInput).toBeTruthy()
    restoreInput.dispatchEvent(new Event('cancel'))
    await expect(restoreP).resolves.toBeNull()

    // 导入文本：change 事件 + files 注入 → {text,name}；字节入口复用缓存文件不二次弹窗
    const textP = platform.readImportFile!()
    const importInput = Array.from(document.body.querySelectorAll('input[type="file"]')).at(-1) as HTMLInputElement
    const bytes = new TextEncoder().encode('{"a":1}')
    const stubFile = {
      name: 'data.json',
      text: async () => '{"a":1}',
      arrayBuffer: async () => bytes.buffer,
    }
    Object.defineProperty(importInput, 'files', { value: [stubFile], configurable: true })
    importInput.dispatchEvent(new Event('change'))
    await expect(textP).resolves.toEqual({ text: '{"a":1}', name: 'data.json' })

    const inputsBefore = document.body.querySelectorAll('input[type="file"]').length
    await expect(platform.readImportFileBytes!()).resolves.toEqual({
      bytes: new Uint8Array(bytes.buffer),
      name: 'data.json',
    })
    expect(document.body.querySelectorAll('input[type="file"]').length).toBe(inputsBefore) // 复用缓存未补弹
  })

  it('restoreFromPicker 旧内核无 cancel 事件 → 30s 超时 reject「文件选择超时」', async () => {
    const { platform } = makeBackup()
    vi.useFakeTimers()
    const pending = platform.restoreFromPicker!('pw')
    const assertion = expect(pending).rejects.toThrow('文件选择超时')
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })
})

describe('createOptionsSyncPlatform', () => {
  function makeSync() {
    const store = makeStore()
    const sync = createOptionsSyncPlatform(store as never)
    return { sync, store }
  }

  it('canSync=!!ext.storage.sync（shim 有 sync 区 → true）', () => {
    const { sync } = makeSync()
    expect(sync.canSync).toBe(true)
  })

  it('setSyncEnabled(true)：commitSettings 持久化 + 主动调度一次 sync-pull（缺这次新设备永不应用远端）', async () => {
    const { sync, store } = makeSync()
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    await sync.setSyncEnabled(true)

    expect(store.settings.syncEnabled).toBe(true)
    expect(store.commitSettings).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({ type: 'sync-pull' })
  })

  it('setSyncEnabled(false)：markSyncOff 直写 off（免 background 往返），不发 sync-pull', async () => {
    const { sync, store } = makeSync()
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    await sync.setSyncEnabled(false)

    expect(store.settings.syncEnabled).toBe(false)
    expect(store.commitSettings).toHaveBeenCalledTimes(1)
    expect(markSyncOff).toHaveBeenCalledTimes(1)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('readStatus：sync:status 形状合法→{state,at}；非对象/字段形状不符/读取失败→null', async () => {
    const { sync } = makeSync()

    shim.local.data['sync:status'] = { state: 'ok', at: 123 }
    await expect(sync.readStatus()).resolves.toEqual({ state: 'ok', at: 123 })

    shim.local.data['sync:status'] = 'garbage'
    await expect(sync.readStatus()).resolves.toBeNull()

    shim.local.data['sync:status'] = { state: 1, at: 'x' }
    await expect(sync.readStatus()).resolves.toBeNull()

    // readStatus 直查 ext.storage.local（shim），非 storageAdapter——在 shim local.get 上注入失败
    const localGetSpy = vi.spyOn(shim.local, 'get').mockRejectedValueOnce(new Error('context invalidated'))
    await expect(sync.readStatus()).resolves.toBeNull()
    localGetSpy.mockRestore()
  })
})

describe('createOptionsSchemesApi', () => {
  it('load 空表/坏 JSON 容错回 []、save 落 SCHEMES_KEY', async () => {
    const schemes = createOptionsSchemesApi()

    await expect(schemes.load()).resolves.toEqual([]) // 缺键 → 空表
    await schemes.save([{ id: 's', name: 'n', mapping: {}, createdAt: 1 } as never])
    expect(storageAdapter.set).toHaveBeenCalledWith('importSchemes', expect.stringContaining('"id":"s"'))

    testScope.adapterData['importSchemes'] = '{bad json'
    await expect(schemes.load()).resolves.toEqual([]) // 坏 JSON → 空表
  })
})

describe('createFollowScheduler（popup/options 跟随拉取装配）', () => {
  function makeScheduler(opts: { intervalMs(): number | null; onAuthFailed?(): void }, storeOverrides: Record<string, unknown> = {}) {
    const store = makeStore(storeOverrides)
    const runPull = vi.fn(async () => {})
    const scheduler = createFollowScheduler(store as never, { runPull: () => runPull(), ...opts })
    return { scheduler, runPull, store }
  }

  it('options 形态 intervalMs=autoFollow?180s：轮询按 3min tick 触发 pull', async () => {
    vi.useFakeTimers()
    const { scheduler, runPull } = makeScheduler({ intervalMs: () => 180_000 })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(180_000)
    expect(runPull).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(runPull).toHaveBeenCalledTimes(2)
  })

  it('popup 形态 intervalMs=null 不轮询；stop() 停止（popup 卸载即停）', async () => {
    vi.useFakeTimers()
    const { scheduler, runPull } = makeScheduler({ intervalMs: () => null })
    scheduler.start()

    await vi.advanceTimersByTimeAsync(3 * 180_000)
    expect(runPull).not.toHaveBeenCalled()

    scheduler.stop()
  })

  it('onAuthFailed 停轮询：tick 拉取 401 → 通知置位，后续 tick 不再拉取（T4 防风暴）', async () => {
    vi.useFakeTimers()
    const onAuthFailed = vi.fn()
    const { scheduler, runPull } = makeScheduler({ intervalMs: () => 180_000, onAuthFailed })

    scheduler.start()
    await vi.advanceTimersByTimeAsync(180_000) // tick 1 成功
    expect(runPull).toHaveBeenCalledTimes(1)

    // 自此刻起拉取一律凭据失效：下一个 tick 触发停轮询
    runPull.mockRejectedValue(Object.assign(new Error('云端请求失败'), { status: 401 }))
    await vi.advanceTimersByTimeAsync(180_000) // tick 2：401 → authFailed + 停轮询
    expect(onAuthFailed).toHaveBeenCalledTimes(1)
    expect(scheduler.authFailed()).toBe(true)
    const calls = runPull.mock.calls.length

    await vi.advanceTimersByTimeAsync(3 * 180_000) // 已停轮询：不再触发
    expect(runPull.mock.calls.length).toBe(calls)
  })

  it('gate：锁定态/autoFollow 关闭时 syncNow 静默跳过（锁定零网络承诺）', async () => {
    const { scheduler, runPull, store } = makeScheduler({ intervalMs: () => null })
    scheduler.start()

    store.locked.value = true
    await scheduler.syncNow()
    expect(runPull).not.toHaveBeenCalled()

    store.locked.value = false
    store.settings.syncPrefs.autoFollow = false
    await scheduler.syncNow()
    expect(runPull).not.toHaveBeenCalled()

    store.settings.syncPrefs.autoFollow = true
    await scheduler.syncNow()
    expect(runPull).toHaveBeenCalledTimes(1)
  })
})

describe('scheduleClipboardClear（popup/options 逐字共用）', () => {
  it('三重门控齐备（开关开 + offscreen 可用）发 schedule-clipboard-clear；否则静默', async () => {
    const store = makeStore()
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    scheduleClipboardClear(store.settings) // 开关关：不发
    expect(sendSpy).not.toHaveBeenCalled()

    store.settings.clipboardClearEnabled = true
    shim.chrome.offscreen = {} // offscreen 能力注入
    scheduleClipboardClear(store.settings)
    expect(sendSpy).toHaveBeenCalledWith({ type: 'schedule-clipboard-clear', delayMs: 30_000 })
  })
})
