/**
 * timeSyncInstall 全测（时间源特性，plan24 终审后 CI coverage 修复）：装配层四接口逐段钉住——
 * - load：storage.local['timeSyncState'] 缺失→null / 坏 JSON→null / 合法→归一化透传；
 * - save：写盘成功与失败（set reject）均不 throw（落盘失败不影响内存态生效，口径同实现注释）；
 * - calibrate：sendMessage 回包 ok:true → 转发 CalibrateResult；ok:false/畸形回包 → throw
 *   「background calibration failed」（出码永不等待网络的失败可见性）；
 * - isNetworkMode：跟随 store.settings.timeSource（响应式 getter，逐次读最新值）。
 * mock 边界：initTimeSync 以 hoisted 替身捕获 deps（状态机本体在 ui timeSource.test.ts）；
 * extApi 经 extApiMock 惰性桥——ext 现读 globalThis.chrome，与 installChromeShim 合用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChromeShim, type ChromeShim } from './helpers/chromeShim'
import { stubDefineBackground } from './helpers/defineBackground'

const { initTimeSync } = vi.hoisted(() => ({ initTimeSync: vi.fn() }))
vi.mock('@totp/ui', () => ({ initTimeSync }))
vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())

import { installExtensionTimeSync } from '../src/timeSyncInstall'
import { TIME_SYNC_STATE_KEY, type TimeSyncDeps } from '@totp/core'

type Deps = TimeSyncDeps & { calibrate(preferred: string | null): Promise<{ offsetMs: number; sourceId: string }> }
let shim: ChromeShim
let captured: Deps | null = null
const fakeStore = { settings: { timeSource: 'device' } }

function install(): Deps {
  captured = null
  installExtensionTimeSync(fakeStore as unknown as import('@totp/ui').VueStore)
  expect(initTimeSync).toHaveBeenCalledTimes(1)
  return initTimeSync.mock.calls[0]![0] as Deps
}

beforeEach(() => {
  vi.clearAllMocks()
  shim = installChromeShim({ local: {} })
  stubDefineBackground(() => {})
})

describe('timeSyncInstall.load（设备本地键读取）', () => {
  it('缺失 → null', async () => {
    const deps = install()
    await expect(deps.load()).resolves.toBeNull()
  })
  it('坏 JSON → null（宽容归一口径）', async () => {
    shim.chrome.storage.local.data[TIME_SYNC_STATE_KEY] = '{oops'
    const deps = install()
    await expect(deps.load()).resolves.toBeNull()
  })
  it('合法 → 归一化透传', async () => {
    const raw = { v: 1, offsetMs: -730, syncedAt: 1794355229736, sourceId: 'taobao-api', lastAttemptAt: 1794355229736, lastAttemptFailed: false, preferredSourceId: null }
    shim.chrome.storage.local.data[TIME_SYNC_STATE_KEY] = JSON.stringify(raw)
    const deps = install()
    await expect(deps.load()).resolves.toMatchObject({ offsetMs: -730, sourceId: 'taobao-api' })
  })
})

describe('timeSyncInstall.save（落盘失败不影响内存态）', () => {
  it('成功写入 JSON 串', async () => {
    const deps = install()
    const st = { v: 1 as const, offsetMs: 5, syncedAt: 1, sourceId: 'neu', lastAttemptAt: 1, lastAttemptFailed: false, preferredSourceId: null }
    await deps.save(st)
    expect(JSON.parse(shim.chrome.storage.local.data[TIME_SYNC_STATE_KEY] as string)).toEqual(st)
  })
  it('set reject → 静默（不 throw）', async () => {
    const deps = install()
    vi.spyOn(shim.chrome.storage.local, 'set').mockRejectedValueOnce(new Error('quota'))
    const st = { v: 1 as const, offsetMs: 5, syncedAt: 1, sourceId: 'neu', lastAttemptAt: 1, lastAttemptFailed: false, preferredSourceId: null }
    await expect(deps.save(st)).resolves.toBeUndefined()
  })
})

describe('timeSyncInstall.calibrate（background 消息客户端）', () => {
  it('ok:true 回包 → 转发 CalibrateResult；preferred 透传', async () => {
    const deps = install()
    vi.spyOn(shim.chrome.runtime, 'sendMessage').mockResolvedValueOnce({ ok: true, offsetMs: 12, sourceId: 'jd' })
    await expect(deps.calibrate('jd')).resolves.toEqual({ offsetMs: 12, sourceId: 'jd' })
    expect(shim.chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'time-sync-calibrate', preferred: 'jd' })
  })
  it('ok:false 回包 → throw（失败可见性）', async () => {
    const deps = install()
    vi.spyOn(shim.chrome.runtime, 'sendMessage').mockResolvedValueOnce({ ok: false })
    await expect(deps.calibrate(null)).rejects.toThrow('background calibration failed')
  })
  it('畸形回包（缺 offsetMs/sourceId）→ throw', async () => {
    const deps = install()
    vi.spyOn(shim.chrome.runtime, 'sendMessage').mockResolvedValueOnce({ ok: true })
    await expect(deps.calibrate(null)).rejects.toThrow('background calibration failed')
  })
})

describe('timeSyncInstall.isNetworkMode（跟随 settings）', () => {
  it('逐次读 store.settings.timeSource 最新值', () => {
    const deps = install()
    expect(deps.isNetworkMode()).toBe(false)
    ;(fakeStore.settings as { timeSource: string }).timeSource = 'network'
    expect(deps.isNetworkMode()).toBe(true)
    ;(fakeStore.settings as { timeSource: string }).timeSource = 'device'
    expect(deps.isNetworkMode()).toBe(false)
  })
})
