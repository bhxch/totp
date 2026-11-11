/**
 * timeSyncInstall 全测（时间源特性，plan24 终审后 CI coverage 修复）：装配层四接口逐段钉住——
 * - load：storage.local['timeSyncState'] 缺失→null / 坏 JSON→null / 合法→归一化透传；
 * - save：写盘成功与失败（set reject）均不 throw（落盘失败不影响内存态生效，口径同实现注释）；
 * - calibrate：sendMessage 回包 ok:true → 转发 CalibrateResult；ok:false/畸形回包 → throw
 *   「background calibration failed」（出码永不等待网络的失败可见性）；
 * - isNetworkMode：跟随 store.settings.timeSource（响应式 getter，逐次读最新值）。
 * mock 边界：initTimeSync 以 hoisted 替身捕获 deps（状态机本体在 ui timeSource.test.ts）；
 * extApi 经 extApiMock 惰性桥——ext 现读 globalThis.chrome，与 installChromeShim 合用；
 * chromeShim 的 chrome/storage 字段为 loose 形态，预置数据与消息替身经局部断言取用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installChromeShim, type ChromeShim } from './helpers/chromeShim'

const { initTimeSync } = vi.hoisted(() => ({ initTimeSync: vi.fn((deps: unknown) => deps) }))
vi.mock('@totp/ui', () => ({ initTimeSync }))
vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())

import { installExtensionTimeSync } from '../src/timeSyncInstall'
import { TIME_SYNC_STATE_KEY, type TimeSyncState } from '@totp/core'
import type { TimeSyncDeps } from '@totp/ui'

/** chromeShim 的 storage 区为 loose 形态：经局部断言取 local.data 直读直写 */
function localData(shim: ChromeShim): Record<string, unknown> {
  return (shim.chrome as { storage: { local: { data: Record<string, unknown> } } }).storage.local.data
}
/** ext 的 runtime.sendMessage 出口（chromeShim.chrome.runtime 同为 loose 形态） */
function stubSendMessage(shim: ChromeShim, respond: (msg: unknown) => unknown): void {
  const stub = vi.fn(async (msg: unknown) => respond(msg))
  ;(shim.chrome as { runtime: Record<string, unknown> }).runtime.sendMessage = stub
}

const FULL_STATE: TimeSyncState = { v: 1, offsetMs: -730, syncedAt: 1794355229736, sourceId: 'taobao-api', lastAttemptAt: 1794355229736, lastAttemptFailed: false, preferredSourceId: null }

let shim: ChromeShim
let captured: TimeSyncDeps | null = null
const fakeStore = { settings: { timeSource: 'device' } }

function install(): TimeSyncDeps {
  captured = null
  installExtensionTimeSync(fakeStore as unknown as import('@totp/ui').VueStore)
  expect(initTimeSync).toHaveBeenCalledTimes(1)
  return initTimeSync.mock.calls[0]![0] as TimeSyncDeps
}

beforeEach(() => {
  vi.clearAllMocks()
  shim = installChromeShim({ local: {} })
})

describe('timeSyncInstall.load（设备本地键读取）', () => {
  it('缺失 → null', async () => {
    const deps = install()
    await expect(deps.load()).resolves.toBeNull()
  })
  it('坏 JSON → null（宽容归一口径）', async () => {
    localData(shim)[TIME_SYNC_STATE_KEY] = '{oops'
    const deps = install()
    await expect(deps.load()).resolves.toBeNull()
  })
  it('合法 → 归一化透传', async () => {
    localData(shim)[TIME_SYNC_STATE_KEY] = JSON.stringify(FULL_STATE)
    const deps = install()
    await expect(deps.load()).resolves.toMatchObject({ offsetMs: -730, sourceId: 'taobao-api' })
  })
})

describe('timeSyncInstall.save（落盘失败不影响内存态）', () => {
  it('成功写入 JSON 串', async () => {
    const deps = install()
    await deps.save(FULL_STATE)
    expect(JSON.parse(localData(shim)[TIME_SYNC_STATE_KEY] as string)).toEqual(FULL_STATE)
  })
  it('set reject → 静默（不 throw）', async () => {
    const deps = install()
    const local = (shim.chrome as { storage: { local: Record<string, unknown> } }).storage.local
    local.set = async () => { throw new Error('quota') }
    await expect(deps.save(FULL_STATE)).resolves.toBeUndefined()
  })
})

describe('timeSyncInstall.calibrate（background 消息客户端）', () => {
  it('ok:true 回包 → 转发 CalibrateResult；preferred 透传', async () => {
    const deps = install()
    const stub = vi.fn(async (msg: unknown) => ({ ok: true, offsetMs: 12, sourceId: 'jd', msg }))
    ;(shim.chrome as { runtime: Record<string, unknown> }).runtime.sendMessage = stub
    const r = await deps.calibrate('jd')
    expect(r).toEqual({ offsetMs: 12, sourceId: 'jd' })
    expect(stub.mock.calls[0]?.[0]).toEqual({ type: 'time-sync-calibrate', preferred: 'jd' })
  })
  it('ok:false 回包 → throw（失败可见性）', async () => {
    const deps = install()
    ;(shim.chrome as { runtime: Record<string, unknown> }).runtime.sendMessage = vi.fn(async () => ({ ok: false }))
    await expect(deps.calibrate(null)).rejects.toThrow('background calibration failed')
  })
  it('畸形回包（缺 offsetMs/sourceId）→ throw', async () => {
    const deps = install()
    ;(shim.chrome as { runtime: Record<string, unknown> }).runtime.sendMessage = vi.fn(async () => ({ ok: true }))
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
