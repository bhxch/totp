/**
 * timeSyncPlatform 直测（时间源特性 Task 5）：localStorage 设备本地键 IO（缺失/坏 JSON 回退
 * null、save/load 往返）与 installDesktopTimeSync 装配（calibrate 透传 invoke('time_calibrate')、
 * preferred 转发、isNetworkMode 实时跟随 settings.timeSource、invoke 失败 reject 且记失败标记）。
 * jsdom 提供 localStorage（desktopPrefs.test.ts 同款文件级环境指令）。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_TIME_SYNC_STATE, type TimeSyncState } from '@totp/core'
import { installDesktopTimeSync, timeSyncStorage } from '../src/timeSyncPlatform'

// mock tauri invoke（tauriFs.test.ts mocks/ 同款手法）
const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

function fakeStore(timeSource: 'device' | 'network', locale: 'auto' | 'zh' | 'en' = 'zh') {
  return { settings: { timeSource, locale } } as unknown as import('@totp/ui').VueStore
}

describe('timeSyncStorage（localStorage 本地键，spec §1）', () => {
  beforeEach(() => { localStorage.clear(); invokeMock.mockReset() })

  it('缺失 → null；坏 JSON → null；合法 → 归一化', async () => {
    expect(await timeSyncStorage.load()).toBeNull()
    localStorage.setItem('timeSyncState', '{oops')
    expect(await timeSyncStorage.load()).toBeNull()
    const st: TimeSyncState = { ...EMPTY_TIME_SYNC_STATE, offsetMs: 42, syncedAt: 1, sourceId: 'aliyun' }
    localStorage.setItem('timeSyncState', JSON.stringify(st))
    expect(await timeSyncStorage.load()).toEqual(st)
  })

  it('save/load 往返', async () => {
    const st: TimeSyncState = { ...EMPTY_TIME_SYNC_STATE, offsetMs: -5, syncedAt: 2, sourceId: 'neu' }
    await timeSyncStorage.save(st)
    expect(await timeSyncStorage.load()).toEqual(st)
  })
})

describe('installDesktopTimeSync', () => {
  beforeEach(() => { localStorage.clear(); invokeMock.mockReset() })

  // R5 装配原则：不测自动路径的用例一律 device 模式安装，防 bootstrap 自动校准与手动
  // calibrateNow 抢 syncing（device 下 shouldAutoCalibrate 模式短路，落定后零自动决策）；
  // 手动校准不受模式限制，invoke 透传照常可测
  it('校准走 invoke time_calibrate：preferred 透传 null、回包转 CalibrateResult', async () => {
    invokeMock.mockResolvedValue({ offsetMs: 123, sourceId: 'aliyun' })
    installDesktopTimeSync(fakeStore('device'))
    const ts = (await import('@totp/ui')).timeSource()
    await ts.calibrateNow()
    expect(invokeMock).toHaveBeenCalledWith('time_calibrate', { preferred: null, profile: 'cn' })
    expect(ts.state.value.offsetMs).toBe(123)
    expect(ts.state.value.sourceId).toBe('aliyun')
  })

  it('剖面随界面语言走（2026-11-13 全球链）：locale=en → profile=global', async () => {
    invokeMock.mockResolvedValue({ offsetMs: 10, sourceId: 'time-nist' })
    installDesktopTimeSync(fakeStore('device', 'en'))
    const ts = (await import('@totp/ui')).timeSource()
    await ts.calibrateNow()
    expect(invokeMock).toHaveBeenCalledWith('time_calibrate', { preferred: null, profile: 'global' })
  })

  it('preferred 非 null 透传；isNetworkMode 跟随 settings.timeSource', async () => {
    // R8 修正：offset 用大偏移（1ms 会被下一次 Date.now() 的时钟前进吞掉，flaky），
    // 断言改差值区间
    invokeMock.mockResolvedValue({ offsetMs: 100_000, sourceId: 'neu' })
    const store = fakeStore('device')
    installDesktopTimeSync(store)
    const ts = (await import('@totp/ui')).timeSource()
    await ts.calibrateNow({ preferredSourceId: 'tuna' })
    expect(invokeMock).toHaveBeenCalledWith('time_calibrate', { preferred: 'tuna', profile: 'cn' })
    ;(store.settings as { timeSource: string }).timeSource = 'network'
    const before = Date.now()
    const got = ts.effectiveNowMs()
    expect(got - before).toBeGreaterThanOrEqual(99_000) // network 模式偏移生效
    expect(got - before).toBeLessThan(101_000)
    ;(store.settings as { timeSource: string }).timeSource = 'device'
    expect(Math.abs(ts.effectiveNowMs() - Date.now())).toBeLessThan(50) // device 模式零偏移
  })

  it('invoke 失败：calibrateNow reject（手动 toast 失败），state 记失败', async () => {
    invokeMock.mockRejectedValue(new Error('all sources failed'))
    installDesktopTimeSync(fakeStore('device'))
    const ts = (await import('@totp/ui')).timeSource()
    await expect(ts.calibrateNow()).rejects.toThrow()
    expect(ts.state.value.lastAttemptFailed).toBe(true)
  })
})
