/**
 * options App.vue 宿主装配测试（P3a，盘点 B4-18/19/21/23/24）：options 页是扩展的宿主编排中枢
 * （独立 store + 四 platform 装配 + 三调度器 + 旧数据迁移 + badge 对账），页面 UI 交互归 ui 包
 * NavigationShell/各卡片职责——本文件聚焦宿主装配与接线语义。
 *
 * 复刻 popupApp.test.ts 模式：store 模块整体 mock（真实模块 import 期即建 chrome 侧单例），
 * 平台薄封装模块（cloudRunnerFactory/dekSession/lockEnforcer/conflictBadge）以替身注入；
 * syncScheduler/core createAutoRunScheduler/loadSourcesImpl 等纯调度与纯函数走真实实现，
 * 装配断言因此覆盖「deps 形状正确 + 调度器真实运转」两端。ui 组件（LockScreen/NavigationShell）stub，
 * NavigationShell 桩保留 props 声明——装配好的四 platform 经 props 取出直测（宿主侧 .vue 无
 * platform 成员的编译期覆盖，漏接无信号，此处即回归探针）。
 */
// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ref } from 'vue'

const { runMock, lockWatcher, setConflictBadge } = vi.hoisted(() => ({
  /** createExtensionCloudRunner 替身的 run：跟随拉取与自动同步两条通道的汇聚点 */
  runMock: vi.fn(async (_mode?: 'auto' | 'manual' | 'pull') => {}),
  lockWatcher: { start: vi.fn(), stop: vi.fn() },
  setConflictBadge: vi.fn(),
}))

vi.mock('../src/store', async () => {
  const { reactive, ref } = await import('vue')
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
  const backupSecret = ref<string | null>(null)
  const credsCache = ref<Record<string, unknown>>({})
  const securitySettings = ref<{ profile?: string; passwordChangedAt?: number } | null>(null)
  const prfSources = ref<Array<{ credentialId: string }>>([])
  const store = {
    settings, vault, locked, hasEncryption, backupSecret, credsCache, securitySettings, prfSources,
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
    addPrfSourceOp: vi.fn(async () => {}),
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
    // 形状完整防 TypeError 假绿：options App 自建 store（windowId='options'，非 popup 单例）——
    // createExtensionStore 工厂替身返回同一 mock store 对象
    createExtensionStore: vi.fn(() => store),
    // popup 单例等其余导出面（本文件未用，保持形状完整；replaceAllOp/sealWithDek 为测试断言通道）
    replaceAllOp: store.replaceAllOp,
    sealWithDek: store.sealWithDek,
    unsealWithDek: store.unsealWithDek,
    storageAdapter: { get: vi.fn(async () => null), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    store,
    settings,
    vault,
    locked,
    hasEncryption,
    backupSecret,
    credsCache,
    initStore: store.initStore,
    registerStorageSync: store.registerStorageSync,
    commitSettings: store.commitSettings,
    unlock: store.unlock,
    lock: store.lock,
    enableEncryption: store.enableEncryption,
    disableEncryption: store.disableEncryption,
    changePassphrase: store.changePassphrase,
    prfSources,
    addPrfSourceOp: store.addPrfSourceOp,
    removePrfSourceOp: store.removePrfSourceOp,
    addEntryOp: vi.fn(async () => ({})),
    updateEntryOp: vi.fn(async () => ({})),
    removeEntryOp: vi.fn(async () => {}),
    addTagOp: vi.fn(async () => 'tag'),
    renameTagOp: vi.fn(async () => {}),
    removeTagOp: vi.fn(async () => {}),
    reorderOp: vi.fn(async () => {}),
  }
})

vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())
vi.mock('../src/syncEngine', () => ({
  // 形状完整（popup/options 宿主 + background 共用模块面）
  pullSyncIfNewer: vi.fn(async () => {}),
  pushSync: vi.fn(async () => {}),
  markSyncOff: vi.fn(async () => {}),
  needsPullBeforePush: () => false,
  SYNC_STATUS_KEY: 'sync:status',
}))
vi.mock('../src/cloudRunnerFactory', () => ({
  createExtensionCloudRunner: vi.fn((deps: unknown) => {
    runnerDeps.current = deps
    return { run: runMock }
  }),
  // 与真实实现同构（store DEK seal，未启用/锁定回退语义由真实 store 单测承载）
  revSeal: (store: { sealWithDek(p: string): Promise<string | null>; unsealWithDek(s: string): Promise<string | null> }) => ({
    seal: async (plain: string) => (await store.sealWithDek(plain)) ?? plain,
    unseal: async (sealed: string) => (await store.unsealWithDek(sealed)) ?? sealed,
  }),
}))
vi.mock('../src/cloudCredStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cloudCredStore')>()),
  // 迁移编排与旧键检测替身（本体已有 cloudCredStore.test.ts 直测；此处断言宿主编排接线）
  migrateLegacySources: vi.fn(async () => 0),
  hasLegacyCloudKeys: vi.fn(async () => false),
}))
vi.mock('../src/dekSession', () => ({
  // 真实实现读写 ext.storage.session——此处宿主只断言「options 独立 store 携带 dekPersist」
  createDekSession: () => ({ get: async () => null, set: async () => {}, clear: async () => {} }),
}))
vi.mock('../src/lockEnforcer', () => ({
  // watcher 内部语义（idle 钳制/降级）由 lockEnforcer.test.ts 直测；宿主只断言 start/stop 接线
  createIdleLockWatcher: vi.fn(() => lockWatcher),
}))
vi.mock('../src/conflictBadge', () => ({ setConflictBadge }))

import App from '../entrypoints/options/App.vue'
import { createTestI18n } from './helpers/i18n'
import { installChromeShim, type ChromeShim } from './helpers/chromeShim'
import {
  commitSettings, hasEncryption, initStore, locked, registerStorageSync, replaceAllOp,
  settings, storageAdapter, store,
} from '../src/store'
import { hasLegacyCloudKeys, migrateLegacySources } from '../src/cloudCredStore'
import { markSyncOff } from '../src/syncEngine'

/** NavigationShell 桩：保留 props 声明——装配好的四 platform 经 props 取出直测 */
const NavStub = {
  name: 'NavigationShellStub',
  props: ['store', 'platform', 'securityPlatform', 'syncPlatform', 'cloudPlatform', 'cloudAuthFailed', 'icons', 'schemesApi'],
  emits: ['copy'],
  // copy 按钮触发宿主 copyToClipboard（独立函数不在 platform 上）
  template: "<div data-test=\"shell\"><button data-test=\"shell-copy\" @click.stop=\"$emit('copy')\">c</button></div>",
}
/** LockScreen 桩：click 即 emit unlocked（解锁回调补跑迁移的触发通道） */
const LockScreenStub = {
  name: 'LockScreenStub',
  props: ['store'],
  emits: ['unlocked'],
  template: '<button data-test="lock-stub" @click="$emit(\'unlocked\')">lock</button>',
}

const runnerDeps: { current: unknown } = { current: null }
const lockedRef = locked as unknown as Ref<boolean>
// 真实导出为 ComputedRef（只读类型）；mock 模块内是可写 ref，测试经断言直写（popupApp 同款）
const hasEncryptionRef = hasEncryption as unknown as Ref<boolean>

let shim: ChromeShim
let wrapper: VueWrapper | null = null
/** storageAdapter.get 对各键的应答（模拟盘上 local 区内容；未命中返回 null） */
let extraLocal: Record<string, string> = {}

async function mountOptions(local: Record<string, string> = {}): Promise<VueWrapper> {
  // 逐用例单实例：先卸载上一个 App——各实例共享 mock settings（reactive），多实例共存时
  // autoFollow 切换会让泄漏实例的 followScheduler 在 fake timers 下重建 interval 交叉触发拉取
  if (wrapper) {
    wrapper.unmount()
    await flushPromises()
  }
  shim?.restore()
  shim = installChromeShim()
  extraLocal = local
  vi.mocked(storageAdapter.get).mockImplementation(
    async (key: string) => (extraLocal as Record<string, string | undefined>)[key] ?? null,
  )
  wrapper = mount(App, {
    global: { plugins: [createTestI18n()], stubs: { LockScreen: LockScreenStub, NavigationShell: NavStub } },
  })
  await flushPromises()
  return wrapper
}

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

beforeEach(() => {
  vi.clearAllMocks()
  lockedRef.value = false
  hasEncryptionRef.value = false
  settings.syncPrefs.autoFollow = true
  // 迁移替身默认值（个别用例 mockResolvedValue/MockRejectedValue 覆盖后在此统一复位）
  vi.mocked(migrateLegacySources).mockResolvedValue(0)
  vi.mocked(hasLegacyCloudKeys).mockResolvedValue(false)
})

afterEach(async () => {
  vi.useRealTimers()
  wrapper?.unmount()
  wrapper = null
  shim?.restore()
  await flushPromises()
})

describe('挂载序列与 badge 对账（B4-18）', () => {
  it('initStore→registerStorageSync→迁移→三调度器 start→首拉 syncNow→badge 真值对账，序列正确', async () => {
    const order: string[] = []
    vi.mocked(initStore).mockImplementation(async () => { order.push('initStore') })
    vi.mocked(registerStorageSync).mockImplementation(() => { order.push('registerStorageSync') })
    vi.mocked(migrateLegacySources).mockImplementation(async () => { order.push('migrateLegacySources'); return 0 })
    lockWatcher.start.mockImplementation(() => { order.push('lockWatcher.start') })

    await mountOptions({ cloudConflictCount: '"3"' })

    // 挂载序列主干（scheduler.start/followScheduler.start 为真实对象不可 spy，经下方 runMock 侧证）
    expect(order).toEqual(['initStore', 'registerStorageSync', 'migrateLegacySources', 'lockWatcher.start'])
    // 首拉一次（gate 开：解锁 + autoFollow）：run('pull') pull-only 只读形态
    expect(runMock).toHaveBeenCalledTimes(1)
    expect(runMock).toHaveBeenCalledWith('pull')
    // badge 对账：cloudConflictCount 持久计数真值恢复「!」标记
    expect(setConflictBadge).toHaveBeenCalledWith(3)
  })

  it('badge 坏值对账 0：非法 JSON（catch 路径）与非有限数值（NaN 路径）均清空', async () => {
    await mountOptions({ cloudConflictCount: '{bad json' })
    expect(setConflictBadge).toHaveBeenCalledWith(0)

    await mountOptions({ cloudConflictCount: '"oops"' }) // JSON.parse 成功、Number() → NaN
    expect(setConflictBadge).toHaveBeenLastCalledWith(0)
  })

  it('initStore 失败：loadError 横幅，不注册存储、不迁移、不启动调度器、不对账 badge', async () => {
    vi.mocked(initStore).mockRejectedValueOnce(new Error('vault corrupted'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = await mountOptions()

    expect(w.find('.error').exists()).toBe(true)
    expect(w.find('.error').text()).toContain('本地数据读取失败')
    expect(w.find('.error').text()).toContain('vault corrupted')
    expect(registerStorageSync).not.toHaveBeenCalled()
    expect(migrateLegacySources).not.toHaveBeenCalled()
    expect(lockWatcher.start).not.toHaveBeenCalled()
    expect(runMock).not.toHaveBeenCalled()
    expect(setConflictBadge).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('卸载：lockWatcher 停止；卸载后解锁翻转不再触发拉取（零网络承诺保持）', async () => {
    lockedRef.value = true
    await mountOptions()
    expect(lockWatcher.start).toHaveBeenCalledTimes(1)
    expect(lockWatcher.stop).not.toHaveBeenCalled()

    wrapper!.unmount()
    expect(lockWatcher.stop).toHaveBeenCalledTimes(1)

    // 边界注记：宿主 onUnlocked 回调体未返回 watch 反注册函数（unregister 恒 undefined），且
    // followScheduler.start() 在 onMounted 异步链中调用——watcher 不绑定组件 effect scope，
    // 存在对象级泄漏（随页面上下文关闭回收）。但 pre-flush watcher 在组件卸载后回调被 Vue
    // 调度器跳过，锁定翻转零网络（现状锚定；宿主补 return watch 停止函数后语义不变，更卫生）
    runMock.mockClear()
    lockedRef.value = false
    await flushPromises()
    expect(runMock).not.toHaveBeenCalled()
  })
})

describe('旧数据迁移编排（B4-19）', () => {
  it('迁移 N>0：migrateNote 提示展示；旧键已清（hasLegacy false）→ 无 legacyNote', async () => {
    vi.mocked(migrateLegacySources).mockResolvedValue(2)
    const w = await mountOptions()
    expect(w.find('.migrate-note').text()).toContain('2')
    expect(w.findAll('.migrate-note')).toHaveLength(1)
  })

  it('迁移跳过/失败且旧键仍在：legacyNote 提示（I6：未启用加密 saveCred 走不通必须有出口）', async () => {
    vi.mocked(migrateLegacySources).mockRejectedValue(new Error('vault locked'))
    vi.mocked(hasLegacyCloudKeys).mockResolvedValue(true)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = await mountOptions()

    expect(w.findAll('.migrate-note')).toHaveLength(1)
    expect(w.find('.migrate-note').text()).toContain('检测到旧版云同步配置')
    warnSpy.mockRestore()
  })

  it('迁移失败但旧键已清（hasLegacy false）：两类提示均不出现', async () => {
    vi.mocked(migrateLegacySources).mockRejectedValue(new Error('boom'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = await mountOptions()
    expect(w.findAll('.migrate-note')).toHaveLength(0)
    warnSpy.mockRestore()
  })

  it('锁定态：迁移跳过 + LockScreen 渲染；解锁回调补跑迁移（幂等）', async () => {
    lockedRef.value = true
    const w = await mountOptions()
    expect(w.find('[data-test="lock-stub"]').exists()).toBe(true)
    expect(w.find('[data-test="shell"]').exists()).toBe(false)
    expect(migrateLegacySources).not.toHaveBeenCalled() // 锁定态 runLegacyMigrations 短路

    lockedRef.value = false
    await w.find('[data-test="lock-stub"]').trigger('click') // unlocked 事件
    await flushPromises()
    expect(migrateLegacySources).toHaveBeenCalledTimes(1) // 解锁后补跑
    expect(w.find('[data-test="shell"]').exists()).toBe(true)
  })
})

describe('syncPlatform 接线（B4-21）', () => {
  it('canSync=!!ext.storage.sync（shim 有 sync 区 → true）', async () => {
    const w = await mountOptions()
    expect(shellOf(w).syncPlatform.canSync).toBe(true)
  })

  it('setSyncEnabled(true)：commitSettings 持久化 + 主动调度一次 sync-pull（缺这次新设备永不应用远端）', async () => {
    const w = await mountOptions()
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    await shellOf(w).syncPlatform.setSyncEnabled(true)

    expect(settings.syncEnabled).toBe(true)
    expect(commitSettings).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({ type: 'sync-pull' })
  })

  it('setSyncEnabled(false)：markSyncOff 直写 off（免 background 往返），不发 sync-pull', async () => {
    const w = await mountOptions()
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    await shellOf(w).syncPlatform.setSyncEnabled(false)

    expect(settings.syncEnabled).toBe(false)
    expect(commitSettings).toHaveBeenCalledTimes(1)
    expect(markSyncOff).toHaveBeenCalledTimes(1)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('readStatus：sync:status 形状合法→{state,at}；非对象/字段形状不符/读取失败→null', async () => {
    const w = await mountOptions()
    const sync = shellOf(w).syncPlatform

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

describe('cloudPlatform 关键成员（B4-23）', () => {
  it('autoPrefs normalize：间隔<15 回退 60、缺失位 false；合法值原样', async () => {
    const w = await mountOptions({ cloudAutoPrefs: '{"onChange":true,"onInterval":true,"intervalMinutes":10}' })
    expect(shellOf(w).cloudPlatform.autoPrefs.get()).toEqual({ onChange: true, onInterval: true, intervalMinutes: 60 })

    const w2 = await mountOptions({ cloudAutoPrefs: '{"onChange":true}' })
    expect(shellOf(w2).cloudPlatform.autoPrefs.get()).toEqual({ onChange: true, onInterval: false, intervalMinutes: 60 })

    const w3 = await mountOptions({ cloudAutoPrefs: '{"onChange":false,"onInterval":true,"intervalMinutes":30}' })
    expect(shellOf(w3).cloudPlatform.autoPrefs.get()).toEqual({ onChange: false, onInterval: true, intervalMinutes: 30 })
  })

  it('autoPrefs.set：先更缓存（同步可见）再异步落盘', async () => {
    const w = await mountOptions()
    const prefs = { onChange: false, onInterval: true, intervalMinutes: 45 }
    await shellOf(w).cloudPlatform.autoPrefs.set(prefs)
    expect(shellOf(w).cloudPlatform.autoPrefs.get()).toEqual(prefs)
    expect(storageAdapter.set).toHaveBeenCalledWith('cloudAutoPrefs', JSON.stringify(prefs))
  })

  it('凭据失效闭环（T4/I1）：首拉 401 → cloudAuthFailed 镜像置位；onManualSynced → resume 复位', async () => {
    runMock.mockRejectedValueOnce(Object.assign(new Error('云端请求失败'), { status: 401 }))
    const w = await mountOptions()
    await flushPromises()
    expect(shellOf(w).cloudAuthFailed).toBe(true) // onAuthFailed 镜像到宿主 ref

    runMock.mockResolvedValue(undefined)
    shellOf(w).cloudPlatform.onManualSynced()
    await flushPromises()
    expect(shellOf(w).cloudAuthFailed).toBe(false) // resume() 复位 authFailed 并镜像
  })

  it('revSeal 共用 cloudSyncState 键：saveSourceState 经 store DEK seal（未启用→明文回落）', async () => {
    const w = await mountOptions()
    const cloud = shellOf(w).cloudPlatform

    await cloud.loadSourceState('s1')
    expect(storageAdapter.get).toHaveBeenCalledWith('cloudSyncState')

    await cloud.saveSourceState('s1', { lastKnownRemoteRev: 2, baseSnapshot: 'SNAP' })
    expect(store.sealWithDek).toHaveBeenCalledWith(expect.stringContaining('SNAP')) // seal 侧绑定 store
    const call = vi.mocked(storageAdapter.set).mock.calls.find((c) => c[0] === 'cloudSyncState')
    expect(call![1]).toContain('SNAP') // sealWithDek null（未启用加密）→ 明文回落
  })

  it('loadSources/saveSources 走 storageAdapter（backupSources 键）；saveCred/removeCred 走保管区 op', async () => {
    const w = await mountOptions()
    const cloud = shellOf(w).cloudPlatform

    await expect(cloud.loadSources()).resolves.toEqual([])
    await cloud.saveSources([{
      id: 's1', kind: 'webdav', name: '家里 WebDAV', retention: { type: 'overwrite' }, enabled: true, role: 'primary',
    }])
    expect(storageAdapter.set).toHaveBeenCalledWith('backupSources', expect.stringContaining('s1'))

    await cloud.saveCred('s1', { kind: 'webdav', user: 'u' })
    expect(store.saveSourceCredOp).toHaveBeenCalledWith('s1', { kind: 'webdav', user: 'u' })
    await cloud.removeCred('s1')
    expect(store.removeSourceCredOp).toHaveBeenCalledWith('s1')
  })

  it('persistDownloaded → replaceAllOp 整体替换', async () => {
    const w = await mountOptions()
    await shellOf(w).cloudPlatform.persistDownloaded('{"entries":[],"tags":[]}')
    expect(replaceAllOp).toHaveBeenCalledWith({ entries: [], tags: [] })
  })
})

describe('调度器装配（B4-24）', () => {
  it('followScheduler intervalMs=autoFollow?180s：轮询按 3min tick 触发 pull', async () => {
    vi.useFakeTimers()
    await mountOptions()
    expect(runMock).toHaveBeenCalledTimes(1) // 首拉

    await vi.advanceTimersByTimeAsync(180_000)
    expect(runMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(runMock).toHaveBeenCalledTimes(3)
  })

  it('watch(autoFollow) 重建（M4）：关闭即停轮询（intervalMs null），重开按新间隔重建', async () => {
    vi.useFakeTimers()
    await mountOptions()
    expect(runMock).toHaveBeenCalledTimes(1)

    settings.syncPrefs.autoFollow = false
    await flushPromises() // watch flush：stop+start（intervalMs=null 不再轮询）
    await vi.advanceTimersByTimeAsync(360_000)
    expect(runMock).toHaveBeenCalledTimes(1)

    settings.syncPrefs.autoFollow = true
    await flushPromises()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(runMock).toHaveBeenCalledTimes(2)
  })

  it('onAuthFailed 停轮询：tick 拉取 401 → authFailed 镜像置位，后续 tick 不再拉取（防风暴）', async () => {
    vi.useFakeTimers()
    await mountOptions()
    expect(runMock).toHaveBeenCalledTimes(1) // 首拉成功

    await vi.advanceTimersByTimeAsync(180_000) // tick 1 成功
    expect(runMock).toHaveBeenCalledTimes(2)

    // 自此刻起拉取一律凭据失效：下一个 tick 触发停轮询
    runMock.mockRejectedValue(Object.assign(new Error('云端请求失败'), { status: 401 }))
    await vi.advanceTimersByTimeAsync(180_000) // tick 2：401 → authFailed + 停轮询
    expect(shellOf(wrapper!).cloudAuthFailed).toBe(true)
    const calls = runMock.mock.calls.length

    await vi.advanceTimersByTimeAsync(3 * 180_000) // 已停轮询：不再触发
    expect(runMock.mock.calls.length).toBe(calls)
  })

  it('存活期自动同步 interval 通道：onInterval 开启时按 intervalMinutes 周期 run()（双开关过滤放行）', async () => {
    vi.useFakeTimers()
    await mountOptions({ cloudAutoPrefs: '{"onChange":false,"onInterval":true,"intervalMinutes":15}' })
    expect(runMock).toHaveBeenCalledTimes(1) // 首拉（followScheduler）

    await vi.advanceTimersByTimeAsync(15 * 60_000)
    // interval reason 过 guard（onInterval=true）→ cloudSync.run() 无 mode（推拉全量通道）
    expect(runMock.mock.calls.some((c) => c.length === 0)).toBe(true)
  })
})

describe('securityPlatform / backupPlatform / schemesApi / 壳层复制（B4-20/22 装配接线）', () => {
  /** URL.createObjectURL/revokeObjectURL jsdom 未实现——Blob 下载通道（downloadEnvelope/saveTextFile/saveImageFile）stub */
  function stubBlobUrl(): void {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock');
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
  }

  afterEach(() => {
    localStorage.removeItem('backupMode')
    localStorage.removeItem('backupKeepN')
  })

  it('securityPlatform：kdfProfile/passwordChangedAt computed、lockPrefs 三字段读写与 unsupported、剪贴板/关窗延迟提交', async () => {
    const w = await mountOptions()
    const sec = shellOf(w).securityPlatform

    // securitySettings null → profile 兜底 balanced / passwordChangedAt null
    expect(sec.security.kdfProfile.value).toBe('balanced')
    expect(sec.security.passwordChangedAt.value).toBeNull()
    expect(sec.clipboardClearEnabled.value).toBe(false)
    expect(sec.popupCloseDelayMs.value).toBe(3000)

    expect(sec.lockPrefs.get()).toEqual({ lockOnRestart: true, lockIdleMinutes: 0, lockOnSystemLock: true })
    expect(sec.lockPrefs.unsupported).toEqual(['lockOnRestart']) // ext 无效控件隐藏

    await sec.lockPrefs.set({ lockIdleMinutes: 30 })
    expect(settings.lockIdleMinutes).toBe(30)
    await sec.setClipboardClear(true)
    expect(settings.clipboardClearEnabled).toBe(true)
    await sec.setPopupCloseDelay(5000)
    expect(settings.popupCloseDelayMs).toBe(5000)
    expect(commitSettings).toHaveBeenCalled()

    // security 闭包绑定 store：改密透传（漏接=档位切换误触发全库轮换）
    await sec.security.changePassphrase('new-pw', { rotateDek: true })
    expect(store.changePassphrase).toHaveBeenCalledWith('new-pw', { rotateDek: true })
  })

  it('backupPlatform：createBackup 按时间戳命名出摘要；backupMode 化石 overwrite 恒定名', async () => {
    stubBlobUrl()
    const w = await mountOptions()
    const platform = shellOf(w).platform as { createBackup(v: string, p: string): Promise<string> }

    const summary = await platform.createBackup('{"entries":[],"tags":[]}', 'pw')
    expect(summary).toContain('已导出备份文件')
    expect(summary).toContain('.totpbackup')

    // 【只读兼容化石】localStorage backupMode='overwrite' → 固定名 vault-backup.totpbackup
    localStorage.setItem('backupMode', 'overwrite')
    const w2 = await mountOptions()
    const platform2 = shellOf(w2).platform as { createBackup(v: string, p: string): Promise<string> }
    const summary2 = await platform2.createBackup('{"entries":[],"tags":[]}', 'pw')
    expect(summary2).toContain('vault-backup.totpbackup')
    expect(summary2).toContain('覆盖')
  })

  it('backupPlatform：kdfProfile 档位 get/set；saveTextFile/saveImageFile 走 Blob 下载恒 true', async () => {
    stubBlobUrl()
    const w = await mountOptions()
    const platform = shellOf(w).platform as Record<string, any>

    expect(platform.backupKdfProfile.get()).toBe('balanced')
    await platform.backupKdfProfile.set('heavy')
    expect(settings.backupKdfProfile).toBe('heavy')

    await expect(platform.saveTextFile('codes.txt', 'otpauth://x')).resolves.toBe(true)
    await expect(platform.saveImageFile('qr.png', 'data:image/png;base64,AAAA')).resolves.toBe(true)
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2)
  })

  it('backupPlatform：文件选择取消（input cancel 事件）→ null；readImportFile 缓存 lastImportFile 供字节入口复用（F4）', async () => {
    const w = await mountOptions()
    const platform = shellOf(w).platform as Record<string, any>

    // 恢复通道取消：pickFile 挂到 body 的 input 派发 cancel
    const restoreP = (platform as { restoreFromPicker(p: string): Promise<unknown> }).restoreFromPicker('pw')
    const restoreInput = document.body.querySelector('input[type="file"]') as HTMLInputElement
    expect(restoreInput).toBeTruthy()
    restoreInput.dispatchEvent(new Event('cancel'))
    await expect(restoreP).resolves.toBeNull()

    // 导入文本：change 事件 + files 注入 → {text,name}；字节入口复用缓存文件不二次弹窗
    const textP = platform.readImportFile()
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
    await expect(platform.readImportFileBytes()).resolves.toEqual({
      bytes: new Uint8Array(bytes.buffer),
      name: 'data.json',
    })
    expect(document.body.querySelectorAll('input[type="file"]').length).toBe(inputsBefore) // 复用缓存未补弹
  })

  it('backupPlatform：restoreFromPicker 旧内核无 cancel 事件 → 30s 超时 reject「文件选择超时」', async () => {
    const w = await mountOptions()
    const platform = shellOf(w).platform as { restoreFromPicker(p: string): Promise<unknown> }
    vi.useFakeTimers()
    const pending = platform.restoreFromPicker('pw')
    const assertion = expect(pending).rejects.toThrow('文件选择超时')
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })

  it('schemesApi：load 空表/坏 JSON 容错回 []、save 落 SCHEMES_KEY', async () => {
    const w = await mountOptions()
    const schemes = shellOf(w).schemesApi as { load(): Promise<unknown[]>; save(list: unknown[]): Promise<void> }

    await expect(schemes.load()).resolves.toEqual([]) // 缺键 → 空表
    await schemes.save([{ id: 's' }])
    expect(storageAdapter.set).toHaveBeenCalledWith('importSchemes', JSON.stringify([{ id: 's' }]))

    const w2 = await mountOptions({ importSchemes: '{bad json' })
    const schemes2 = shellOf(w2).schemesApi as { load(): Promise<unknown[]> }
    await expect(schemes2.load()).resolves.toEqual([]) // 坏 JSON → 空表
  })

  it('壳层复制 copyToClipboard：写剪贴板 + 三重门控齐备时发 schedule-clipboard-clear', async () => {
    settings.clipboardClearEnabled = true
    const w = await mountOptions()
    shim.chrome.offscreen = {} // mountOptions 重装 shim，offscreen 注入须在其后
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    })
    await w.find('[data-test="shell-copy"]').trigger('click')
    await flushPromises()

    expect(sendSpy).toHaveBeenCalledWith({ type: 'schedule-clipboard-clear', delayMs: 30_000 })
    settings.clipboardClearEnabled = false
  })

  it('cloudPlatform：saveConflictBackup/listConflictCopies 走 conflictCopies 列表、loadAutoStatus 三态格式化', async () => {
    const w = await mountOptions({ cloudAutoStatus: JSON.stringify({ at: 1, ok: true, summary: '同步完成' }) })
    const cloud = shellOf(w).cloudPlatform as Record<string, any>

    // 副本入列表（storage.local conflictCopies 键，限 5 滚动删——本体 conflictCopies.test.ts 已测）
    await cloud.saveConflictBackup(new Uint8Array([1]), 's1')
    expect(storageAdapter.set).toHaveBeenCalledWith('conflictCopies', expect.stringContaining('s1'))
    await expect(cloud.listConflictCopies()).resolves.toEqual([]) // get mock 返回 null → 空表

    // loadAutoStatus：cloudAutoStatus 键原文 → 记录时三态格式化（ok=true 文案 + 摘要）
    const text = (await cloud.loadAutoStatus()) as string
    expect(text).toContain('同步完成')
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })
})
