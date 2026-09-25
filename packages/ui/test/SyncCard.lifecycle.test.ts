import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SyncCard from '../src/components/SyncCard.vue'
import { createTestI18n } from './helpers/i18n'
import type { SyncPlatform } from '../src/components/syncPlatform'

type MockPlatform = SyncPlatform & { readStatus: Mock; setSyncEnabled: Mock }

function mkPlatform(over: Partial<SyncPlatform> = {}): MockPlatform {
  return {
    syncEnabled: false,
    setSyncEnabled: vi.fn(async () => {}),
    readStatus: vi.fn(async () => null),
    canSync: true,
    ...over,
  } as unknown as MockPlatform
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SyncCard 状态机补全（invalid/off/readStatus 异常）', () => {
  it('invalid 态：显示拒绝非法远端数据文案（错误色）', async () => {
    const platform = mkPlatform({ readStatus: vi.fn(async () => ({ state: 'invalid', at: Date.now() })) })
    const w = mount(SyncCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await flushPromises()
    expect(w.find('.status.sync-invalid').exists()).toBe(true)
    expect(w.text()).toContain('远端同步数据无效')
  })

  it('off 态：显示「未启用」（弱化呈现）', async () => {
    const platform = mkPlatform({ readStatus: vi.fn(async () => ({ state: 'off', at: Date.now() })) })
    const w = mount(SyncCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await flushPromises()
    expect(w.find('.status.sync-off').exists()).toBe(true)
    expect(w.text()).toContain('未启用')
  })

  it('readStatus 抛错：按 error 态呈现「同步出错」（下次轮询自愈）', async () => {
    const platform = mkPlatform({ readStatus: vi.fn(async () => { throw new Error('storage dead') }) })
    const w = mount(SyncCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await flushPromises()
    expect(w.find('.status.sync-error').exists()).toBe(true)
    expect(w.text()).toContain('同步出错')
  })

  it('canSync=false：开关禁用并显示「当前环境不支持浏览器同步」', () => {
    const platform = mkPlatform({ canSync: false })
    const w = mount(SyncCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    expect((w.find('.sync-toggle input').element as HTMLInputElement).disabled).toBe(true)
    expect(w.find('.hint').text()).toBe('当前环境不支持浏览器同步')
  })

  it('onToggle 失败：err 通道展示原始错误且 busy 复位（开关可再操作）', async () => {
    const platform = mkPlatform({ setSyncEnabled: vi.fn(async () => { throw new Error('quota exceeded') }) })
    const w = mount(SyncCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await w.find('.sync-toggle input').setValue(true)
    await flushPromises()
    expect(w.find('div[role="alert"]').text()).toBe('quota exceeded')
    // busy 复位：刷新按钮可再次触发 readStatus
    const before = platform.readStatus.mock.calls.length
    await w.find('button.refresh').trigger('click')
    await flushPromises()
    expect(platform.readStatus.mock.calls.length).toBeGreaterThan(before)
  })

  it('刷新按钮手动触发 readStatus', async () => {
    const platform = mkPlatform()
    const w = mount(SyncCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await flushPromises()
    const before = platform.readStatus.mock.calls.length
    await w.find('button.refresh').trigger('click')
    await flushPromises()
    expect(platform.readStatus.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('SyncCard 30s 轮询与卸载清理', () => {
  it('挂载即读取；30s 后轮询推进；卸载后 clearInterval 不再拉取', async () => {
    const platform = mkPlatform()
    const w = mount(SyncCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await flushPromises()
    expect(platform.readStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(platform.readStatus).toHaveBeenCalledTimes(2)
    w.unmount()
    await vi.advanceTimersByTimeAsync(90_000)
    expect(platform.readStatus).toHaveBeenCalledTimes(2)
  })

  it('platform null：整卡不渲染且不建轮询', () => {
    const w = mount(SyncCard, { global: { plugins: [createTestI18n()] }, props: { platform: null } })
    expect(w.find('section.card').exists()).toBe(false)
  })
})
