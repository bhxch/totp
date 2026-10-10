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
 * App.vue 生命周期编排（onMounted 挂载序列/旧数据迁移提示/badge 对账/卸载停 watcher）由文末
 * 「App.vue 挂载冒烟」薄 mount 用例承载（终审修复回补：R4 改写曾删 8 项编排断言且 E2E 文档
 * 未承接，现以薄 mount 保留单测覆盖——壳组件 stub，只验编排不重复平台语义；NavigationShell
 * 桩保留 props 声明，四 platform 接线另有回归探针（A3：漏传任一 :xxx-platform 时 vue-tsc 无
 * 信号——props 可选，探针从壳收到的 props 取装配产物断言，漏传即红））；runner 装配接线
 * （deps 逐成员/run 包装）由 cloudRunnerFactory.test.ts 承载，syncScheduler 本体由
 * syncScheduler.test.ts 承载。
 *
 * mock 策略：../src/store mock storageAdapter（内存键值，真实模块 import 期即建 popup
 * store 单例必须拦下）并另备 createExtensionStore 工厂替身（仅挂载冒烟消费，直测不经它）；
 * extApi 走惰性桥 mock + installChromeShim 逐用例注入；syncEngine/conflictBadge 替身（宿主只
 * 断言接线）；core/cloudCredStore（迁移两点除外）/conflictCopies/syncScheduler 走真实实现
 * （纯调度与纯函数），装配断言覆盖「deps 形状正确 + 真实运转」两端；cloudRunnerFactory/
 * dekSession/lockEnforcer 替身亦仅挂载冒烟消费（本体各有直测文件）。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { reactive, ref, type Ref } from 'vue'
import type { BackupSource } from '@totp/core'
import type { CloudPlatform, SecurityPlatform } from '@totp/ui'

const testScope = vi.hoisted(() => ({
  /** storageAdapter mock 的内存键值空间（与 core 读写共享，loadSources/saveSources 真实走） */
  adapterData: {} as Record<string, string>,
  markSyncOff: vi.fn(async () => {}),
  setConflictBadge: vi.fn(),
  /** 挂载冒烟替身：createExtensionCloudRunner.run 汇聚点（首拉 pull/自动/手动三通道） */
  runMock: vi.fn(async (_mode?: 'auto' | 'manual' | 'pull') => {}),
  /** 挂载冒烟替身：createIdleLockWatcher 产物（宿主只断言 start/stop 接线） */
  lockWatcher: { start: vi.fn(), stop: vi.fn() },
}))

vi.mock('../src/store', async () => {
  const { reactive, ref } = await import('vue')
  // 挂载冒烟用宿主 store 替身：App.vue 经 createExtensionStore('options', …) 自建 store，
  // 工厂替身返回同一单例；直测用例不经它（各自 makeStore）。形状完整防 TypeError 假绿。
  const settings = reactive({
    locale: 'zh',
    rememberTagFilter: false,
    lastTagFilterIds: [] as string[],
    tagFilterMode: 'all',
    urlFilterEnabled: false,
    popupCloseDelayMs: 3000,
    clipboardClearEnabled: false,
    themeMode: 'auto',
    themeColor: 'blue',
    syncEnabled: false,
    syncPrefs: { autoFollow: true },
    backupKdfProfile: 'balanced',
    lockOnRestart: true,
    lockIdleMinutes: 0,
    lockOnSystemLock: true,
  })
  const vault = reactive({ entries: [] as unknown[], tags: [] as unknown[] })
  const locked = ref(false)
  const hasEncryption = ref(false)
  const hostStore = {
    settings, vault, locked, hasEncryption,
    backupSecret: ref<string | null>('pw'),
    credsCache: ref({} as Record<string, unknown>),
    securitySettings: ref(null as { profile?: string; passwordChangedAt?: number } | null),
    prfSources: ref([] as Array<{ credentialId: string }>),
    conflictCount: { value: 0 },
    initStore: vi.fn(async () => {}),
    registerStorageSync: vi.fn(),
    commitSettings: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    lock: vi.fn(),
    unlock: vi.fn(async () => {}),
    enableEncryption: vi.fn(async () => {}),
    disableEncryption: vi.fn(async () => {}),
    changePassphrase: vi.fn(async () => {}),
    addPrfSourceOp: vi.fn(async () => ({})),
    removePrfSourceOp: vi.fn(async () => {}),
    replaceAllOp: vi.fn(async () => {}),
    saveSourceCredOp: vi.fn(async () => {}),
    removeSourceCredOp: vi.fn(async () => {}),
    migrateLegacySecrets: vi.fn(async () => {}),
    addMergeConflictsOp: vi.fn(async () => {}),
    saveMergeConflictsOp: vi.fn(async () => {}),
    resolveMergeConflictOp: vi.fn(async () => {}),
    sealWithDek: vi.fn(async () => null as string | null),
    unsealWithDek: vi.fn(async () => null as string | null),
  }
  return {
    createExtensionStore: vi.fn(() => hostStore),
    persistFailed: ref(false),
    storageAdapter: {
      get: vi.fn(async (key: string) => testScope.adapterData[key] ?? null),
      set: vi.fn(async (key: string, value: string) => {
        testScope.adapterData[key] = value
      }),
      delete: vi.fn(async (key: string) => {
        delete testScope.adapterData[key]
      }),
    },
    store: hostStore,
    settings, vault, locked, hasEncryption,
    backupSecret: hostStore.backupSecret,
    credsCache: hostStore.credsCache,
    initStore: hostStore.initStore,
    registerStorageSync: hostStore.registerStorageSync,
    commitSettings: hostStore.commitSettings,
    unlock: hostStore.unlock,
    lock: hostStore.lock,
    enableEncryption: hostStore.enableEncryption,
    disableEncryption: hostStore.disableEncryption,
    changePassphrase: hostStore.changePassphrase,
    prfSources: hostStore.prfSources,
    addPrfSourceOp: hostStore.addPrfSourceOp,
    removePrfSourceOp: hostStore.removePrfSourceOp,
    replaceAllOp: hostStore.replaceAllOp,
    sealWithDek: hostStore.sealWithDek,
    unsealWithDek: hostStore.unsealWithDek,
  }
})

vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())
vi.mock('../src/syncEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/syncEngine')>()), // 展开先例同 cloudRunnerFactory;R16⑪ readSyncStatus 导出复用后出口扩展免疫
  // 形状完整（popup/options 宿主 + background 共用模块面）
  pullSyncIfNewer: vi.fn(async () => {}),
  pushSync: vi.fn(async () => {}),
  markSyncOff: testScope.markSyncOff,
  needsPullBeforePush: () => false,
  SYNC_STATUS_KEY: 'sync:status',
}))
vi.mock('../src/conflictBadge', () => ({ setConflictBadge: testScope.setConflictBadge }))

// ---- 挂载冒烟专用替身（直测不经这些模块面；本体语义各有直测文件，宿主只断言编排接线）----
vi.mock('../src/cloudRunnerFactory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cloudRunnerFactory')>()), // 其余导出保持真实（revSeal 死再导出已删）
  createExtensionCloudRunner: vi.fn(() => ({ run: testScope.runMock })),
}))
vi.mock('../src/cloudCredStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cloudCredStore')>()),
  // 迁移编排与旧键检测替身（本体 cloudCredStore.test.ts 直测；此处断言宿主编排接线）
  migrateLegacySources: vi.fn(async () => 0),
  hasLegacyCloudKeys: vi.fn(async () => false),
}))
vi.mock('../src/dekSession', () => ({
  // 真实实现读写 ext.storage.session——宿主只断言 options 独立 store 携带 dekPersist（工厂吞参）
  createDekSession: () => ({ get: async () => null, set: async () => {}, clear: async () => {} }),
}))
vi.mock('../src/lockEnforcer', () => ({
  // watcher 内部语义（idle 钳制/降级）由 lockEnforcer.test.ts 直测；宿主只断言 start/stop 接线
  createIdleLockWatcher: vi.fn(() => testScope.lockWatcher),
}))

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
    const name = await platform.saveConflictBackup!('s1', new Uint8Array([1]))
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

  it('saveBackupFile：Blob 下载通道恒 true（plan23 §4）', async () => {
    stubBlobUrl()
    const { platform } = makePlatform()
    const calls0 = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    await expect(platform.saveBackupFile!('vault-20261010-090000.totpbackup', new TextEncoder().encode('{"envelope":1}'))).resolves.toBe(true)
    expect((URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls0 + 1)
    const blob = (URL.createObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as Blob
    expect(blob.type).toBe('application/octet-stream')
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

  it('F5 clipboardNote：Firefox 形态（无 offscreen）注入降级哨兵；Chromium 形态不注入', () => {
    // 默认 shim 无 offscreen（Firefox 形态）：SecurityCard 依此切换 clipboardHintFirefox 降级说明键
    const sec = createOptionsSecurityPlatform(makeStore() as never)
    expect((sec as SecurityPlatform).clipboardNote).toBe('firefox')

    // Chromium 对照：offscreen 能力在 → 无哨兵（30s 清空承诺可用，用默认说明键）
    shim.restore()
    shim = installChromeShim({ offscreen: {} })
    const chromium = createOptionsSecurityPlatform(makeStore() as never)
    expect((chromium as SecurityPlatform).clipboardNote).toBeUndefined()
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

// ============================================================
// App.vue 挂载冒烟（终审修复回补：R4 改写删去的 8 项编排断言在此以薄 mount 承接——壳组件
// stub、平台装配/调度器本体语义由上方直测与各自测试文件承载，此处只验生命周期编排）。
// 沿基线 mount 版同款 mock 拓扑：store 工厂替身 + cloudRunnerFactory/lockEnforcer/dekSession
// 替身 + cloudCredStore 迁移两点替身；core createAutoRunScheduler 与 createFollowScheduler
// 走真实（调度器 start 经 runMock 侧证）。
// ============================================================
import App from '../entrypoints/options/App.vue'
import { createTestI18n } from './helpers/i18n'
import { initStore, locked, registerStorageSync, settings, store as hostStore } from '../src/store'
import { hasLegacyCloudKeys, migrateLegacySources } from '../src/cloudCredStore'

/** NavigationShell 桩：保留 props 声明——装配好的四 platform 经 props 取出直测（基线同款：
 *  App.vue 漏传任一 :xxx-platform 时 vue-tsc 无信号（props 可选），此处即回归探针） */
const NavStub = {
  name: 'NavigationShellStub',
  props: ['store', 'platform', 'securityPlatform', 'syncPlatform', 'cloudPlatform', 'cloudAuthFailed', 'icons', 'schemesApi'],
  template: '<div data-test="shell" />',
}
/** LockScreen 桩：click 即 emit unlocked（解锁回调补跑迁移的触发通道） */
const LockScreenStub = {
  name: 'LockScreenStub',
  emits: ['unlocked'],
  template: '<button data-test="lock-stub" @click="$emit(\'unlocked\')">lock</button>',
}

/** 从挂载结果取出壳实际收到的平台 props（探针断言通道，基线同款） */
function shellOf(w: VueWrapper): {
  platform: unknown
  securityPlatform: any
  syncPlatform: any
  cloudPlatform: any
  schemesApi: unknown
  cloudAuthFailed: boolean
} {
  const stub = w.findComponent(NavStub)
  if (!stub.exists()) throw new Error('shellOf: NavStub not found; html=' + w.html().slice(0, 400))
  return {
    platform: stub.props('platform'),
    securityPlatform: stub.props('securityPlatform'),
    syncPlatform: stub.props('syncPlatform'),
    cloudPlatform: stub.props('cloudPlatform'),
    schemesApi: stub.props('schemesApi'),
    cloudAuthFailed: stub.props('cloudAuthFailed'),
  }
}

// 真实导出为 Ref/ComputedRef（类型只读口径）；mock 模块内是可写 ref，测试经断言直写（基线同款）
const lockedRef = locked as unknown as Ref<boolean>

describe('App.vue 挂载冒烟（编排覆盖回补）', () => {
  let wrapper: VueWrapper | null = null

  /** 逐用例单实例：先卸载上一个 App（共享 mock settings，多实例共存会交叉触发调度器） */
  async function mountApp(local: Record<string, string> = {}): Promise<VueWrapper> {
    if (wrapper) {
      wrapper.unmount()
      wrapper = null
      await flushPromises()
    }
    Object.assign(testScope.adapterData, local)
    wrapper = mount(App, {
      global: { plugins: [createTestI18n()], stubs: { LockScreen: LockScreenStub, NavigationShell: NavStub } },
    })
    await flushPromises()
    return wrapper
  }

  beforeEach(() => {
    lockedRef.value = false
    settings.syncPrefs.autoFollow = true
    vi.mocked(initStore).mockReset().mockResolvedValue(undefined)
    vi.mocked(registerStorageSync).mockReset()
    testScope.runMock.mockReset()
    testScope.lockWatcher.start.mockReset()
    testScope.lockWatcher.stop.mockReset()
    // 迁移替身默认值（mockReset 清调用历史+实现，防用例间累计计数；本体语义另有直测文件）
    vi.mocked(migrateLegacySources).mockReset().mockResolvedValue(0)
    vi.mocked(hasLegacyCloudKeys).mockReset().mockResolvedValue(false)
  })

  afterEach(async () => {
    wrapper?.unmount()
    wrapper = null
    await flushPromises()
  })

  it('挂载序列：initStore→registerStorageSync→迁移→lockWatcher.start；首拉 run("pull")；badge 真值对账', async () => {
    const order: string[] = []
    vi.mocked(initStore).mockImplementation(async () => { order.push('initStore') })
    vi.mocked(registerStorageSync).mockImplementation(() => { order.push('registerStorageSync') })
    vi.mocked(migrateLegacySources).mockImplementation(async () => { order.push('migrateLegacySources'); return 0 })
    testScope.lockWatcher.start.mockImplementation(() => { order.push('lockWatcher.start') })

    await mountApp({ cloudConflictCount: '"3"' })

    // 主干序列（autoRunScheduler/followScheduler.start 为真实对象，经下方 runMock 侧证）
    expect(order).toEqual(['initStore', 'registerStorageSync', 'migrateLegacySources', 'lockWatcher.start'])
    // 打开即首拉一次（gate 开：解锁 + autoFollow），pull-only 只读形态
    expect(testScope.runMock).toHaveBeenCalledTimes(1)
    expect(testScope.runMock).toHaveBeenCalledWith('pull')
    // T11 badge 初始对账：cloudConflictCount 持久计数真值恢复「!」标记
    expect(testScope.setConflictBadge).toHaveBeenCalledWith(3)
  })

  it('badge 坏值对账 0：非法 JSON（catch 路径）与非有限数值（NaN 路径）均清空', async () => {
    await mountApp({ cloudConflictCount: '{bad json' })
    expect(testScope.setConflictBadge).toHaveBeenCalledWith(0)

    await mountApp({ cloudConflictCount: '"oops"' }) // JSON.parse 成功、Number() → NaN
    expect(testScope.setConflictBadge).toHaveBeenLastCalledWith(0)
  })

  it('initStore 失败：loadError 横幅，不注册存储、不迁移、不启动调度器、不对账 badge', async () => {
    vi.mocked(initStore).mockRejectedValueOnce(new Error('vault corrupted'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = await mountApp()

    expect(w.find('.error').exists()).toBe(true)
    expect(w.find('.error').text()).toContain('本地数据读取失败')
    expect(w.find('.error').text()).toContain('vault corrupted')
    expect(registerStorageSync).not.toHaveBeenCalled()
    expect(migrateLegacySources).not.toHaveBeenCalled()
    expect(testScope.lockWatcher.start).not.toHaveBeenCalled()
    expect(testScope.runMock).not.toHaveBeenCalled()
    expect(testScope.setConflictBadge).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('卸载：lockWatcher 停止；卸载后解锁翻转不再触发拉取（零网络承诺保持）', async () => {
    lockedRef.value = true
    await mountApp()
    expect(testScope.lockWatcher.start).toHaveBeenCalledTimes(1)
    expect(testScope.lockWatcher.stop).not.toHaveBeenCalled()

    wrapper!.unmount()
    wrapper = null
    expect(testScope.lockWatcher.stop).toHaveBeenCalledTimes(1)

    // 跟随调度的解锁边沿 watch 随组件卸载失效：锁定翻转不再有网络动作
    lockedRef.value = false
    await flushPromises()
    expect(testScope.runMock).not.toHaveBeenCalled()
  })

  it('迁移 N>0：migrateNote 提示展示；旧键已清（hasLegacy false）→ 无 legacyNote', async () => {
    vi.mocked(migrateLegacySources).mockResolvedValue(2)
    const w = await mountApp()
    expect(w.find('.migrate-note').text()).toContain('2')
    expect(w.findAll('.migrate-note')).toHaveLength(1)
  })

  it('迁移跳过/失败且旧键仍在：legacyNote 提示（审查 I6：未启用加密必须有用户可见出口）', async () => {
    vi.mocked(migrateLegacySources).mockRejectedValue(new Error('vault locked'))
    vi.mocked(hasLegacyCloudKeys).mockResolvedValue(true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = await mountApp()

    expect(w.findAll('.migrate-note')).toHaveLength(1)
    expect(w.find('.migrate-note').text()).toContain('检测到旧版云同步配置')
    warnSpy.mockRestore()
  })

  it('迁移失败但旧键已清（hasLegacy false）：两类提示均不出现', async () => {
    vi.mocked(migrateLegacySources).mockRejectedValue(new Error('boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = await mountApp()
    expect(w.findAll('.migrate-note')).toHaveLength(0)
    warnSpy.mockRestore()
  })

  it('锁定态：迁移跳过 + LockScreen 渲染；解锁回调补跑迁移（幂等）', async () => {
    lockedRef.value = true
    const w = await mountApp()
    expect(w.find('[data-test="lock-stub"]').exists()).toBe(true)
    expect(w.find('[data-test="shell"]').exists()).toBe(false)
    expect(migrateLegacySources).not.toHaveBeenCalled() // 锁定态 runLegacyMigrations 短路

    lockedRef.value = false
    await w.find('[data-test="lock-stub"]').trigger('click') // unlocked 事件（DOM 重渲前触发）
    await flushPromises()
    expect(migrateLegacySources).toHaveBeenCalledTimes(1) // 解锁后补跑
    expect(w.find('[data-test="shell"]').exists()).toBe(true)
  })

  it('四 platform 经 props 接入壳（A3 回归探针：App.vue 漏传任一 :xxx-platform 即红）', async () => {
    const w = await mountApp()
    const shell = shellOf(w)
    // syncPlatform：真实装配成员（shim 有 storage.sync 区 → canSync true）
    expect(shell.syncPlatform).toMatchObject({ canSync: true })
    // securityPlatform：ext 差异注入在位（默认 shim 无 offscreen = Firefox 形态 → F5 降级哨兵）
    expect(shell.securityPlatform).toMatchObject({
      clipboardNote: 'firefox',
      lockPrefs: { unsupported: ['lockOnRestart'] },
    })
    // cloudPlatform（host 装配 + ext 差异）/ backupPlatform（platform prop）/ schemesApi：装配产物非空壳
    expect(typeof shell.cloudPlatform.loadSourceState).toBe('function')
    expect(typeof (shell.platform as { createBackup: unknown }).createBackup).toBe('function')
    expect(shell.schemesApi).toBeTruthy()
  })
})
