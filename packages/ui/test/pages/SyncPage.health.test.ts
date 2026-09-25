import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore } from '../../src/store'
import SyncPage from '../../src/pages/SyncPage.vue'
import BackupCard from '../../src/components/BackupCard.vue'
import { createTestI18n } from '../helpers/i18n'
import type { CloudPlatform } from '../../src/components/cloudPlatform'
import type { SyncPlatform } from '../../src/components/syncPlatform'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@ex.com?secret=JBSWY3DPEHPK3PXP', 1))
  return s
}

/** 同步页消费的最小云平台 fake：loadAutoStatus 逐用例注入 */
function cloudPlatform(over: Partial<CloudPlatform> = {}): CloudPlatform {
  return {
    loadSources: vi.fn(async () => []),
    saveSources: vi.fn(async () => {}),
    saveCred: vi.fn(async () => {}),
    removeCred: vi.fn(async () => {}),
    creds: {},
    readVaultJson: vi.fn(() => ''),
    persistDownloaded: vi.fn(async () => {}),
    loadSourceState: vi.fn(async () => ({ lastKnownRemoteRev: null, baseSnapshot: null })),
    saveSourceState: vi.fn(async () => {}),
    deviceId: vi.fn(async () => 'dev-test'),
    autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
    ...over,
  } as CloudPlatform
}

function syncPlatform(readStatus: ReturnType<typeof vi.fn> = vi.fn(async () => null)): SyncPlatform {
  return {
    syncEnabled: false,
    setSyncEnabled: vi.fn(async () => {}),
    readStatus,
    canSync: true,
  }
}

describe('SyncPage 健康摘要条（两通道采集）', () => {
  it('云通道摘要=loadAutoStatus 文本；浏览器通道=readStatus 状态短文案', async () => {
    const store = await readyStore()
    const cloud = cloudPlatform({ loadAutoStatus: vi.fn(async () => '1 小时前备份成功') })
    const sync = syncPlatform(vi.fn(async () => ({ state: 'ok', at: Date.now() })))
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] },
      props: { store, cloudPlatform: cloud, syncPlatform: sync } })
    await flushPromises()
    const cloudItem = w.find('.health-cloud')
    expect(cloudItem.exists()).toBe(true)
    expect(cloudItem.text()).toContain('云同步')
    expect(cloudItem.text()).toContain('1 小时前备份成功')
    expect(w.find('.health-browser').text()).toContain('正常')
  })

  it('loadAutoStatus 抛错 → 云通道不渲染（null 不渲染语义）', async () => {
    const store = await readyStore()
    const cloud = cloudPlatform({ loadAutoStatus: vi.fn(async () => { throw new Error('boom') }) })
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] }, props: { store, cloudPlatform: cloud } })
    await flushPromises()
    expect(w.find('.health-cloud').exists()).toBe(false)
    expect(w.find('.health-browser').exists()).toBe(false) // 无 syncPlatform 同样不渲染
  })

  it('无 loadAutoStatus 能力的云平台 → 云通道不渲染', async () => {
    const store = await readyStore()
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] }, props: { store, cloudPlatform: cloudPlatform() } })
    await flushPromises()
    expect(w.find('.health-cloud').exists()).toBe(false)
  })

  it('readStatus 抛错 → 浏览器通道显示「出错」', async () => {
    const store = await readyStore()
    const sync = syncPlatform(vi.fn(async () => { throw new Error('storage dead') }))
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] }, props: { store, syncPlatform: sync } })
    await flushPromises()
    expect(w.find('.health-browser').text()).toContain('出错')
  })

  it.each([
    [{ state: 'ok', at: 1 }, '正常'],
    [{ state: 'quota', at: 1 }, '空间已满'],
    [{ state: 'error', at: 1 }, '出错'],
    [{ state: 'conflict', at: 1 }, '已拒同步'],
    [{ state: 'invalid', at: 1 }, '数据无效'],
    [null, '未启用'],
    [{ state: '未知新状态', at: 1 }, '未启用'], // default 分支兜底
  ])('browserStateText 六态映射：%s → %s', async (ret, expected) => {
    const store = await readyStore()
    const sync = syncPlatform(vi.fn(async () => ret))
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] }, props: { store, syncPlatform: sync } })
    await flushPromises()
    expect(w.find('.health-browser').text()).toContain(expected as string)
  })
})

describe('SyncPage 30s 轮询自愈与卸载清理', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('挂载即拉取，30s 后重拉；卸载后不再轮询', async () => {
    const store = await readyStore()
    const readStatus = vi.fn(async () => null)
    const sync = syncPlatform(readStatus)
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] }, props: { store, syncPlatform: sync } })
    await flushPromises()
    const initial = readStatus.mock.calls.length // SyncPage 1 次 + SyncCard 挂载 1 次
    expect(initial).toBeGreaterThanOrEqual(1)
    await vi.advanceTimersByTimeAsync(30_000)
    const after30 = readStatus.mock.calls.length
    expect(after30).toBeGreaterThan(initial) // 两消费方各自轮询推进
    w.unmount()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(readStatus.mock.calls.length).toBe(after30) // 卸载后 clearInterval，无增量
  })
})

describe('SyncPage 备份口令上抛（onRememberSecret）', () => {
  it('BackupCard remember-secret → store.setBackupSecret(pw, true)', async () => {
    const store = await readyStore()
    const spy = vi.spyOn(store, 'setBackupSecret').mockResolvedValue(undefined)
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] },
      props: { store, platform: { createBackup: vi.fn(async () => 'ok') } } })
    await flushPromises()
    w.findComponent(BackupCard).vm.$emit('remember-secret', 'pw-123')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('pw-123', true)
  })

  it('保管区守护失败（未启用加密）→ 仅 console.warn，不打断导出流程', async () => {
    const store = await readyStore() // 未启用加密：setBackupSecret 走守护拒绝
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] },
      props: { store, platform: { createBackup: vi.fn(async () => 'ok') } } })
    await flushPromises()
    w.findComponent(BackupCard).vm.$emit('remember-secret', 'pw-123')
    await flushPromises()
    expect(warn).toHaveBeenCalledWith('[backup] 记住导出口令失败', expect.anything())
    warn.mockRestore()
  })
})
