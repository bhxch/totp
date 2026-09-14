import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import SyncCard from '../src/components/SyncCard.vue'

function mkPlatform(status: { state: string; at: number } | null = null, over: Record<string, unknown> = {}) {
  return {
    syncEnabled: false,
    setSyncEnabled: vi.fn().mockResolvedValue(undefined),
    readStatus: vi.fn().mockResolvedValue(status),
    canSync: true,
    ...over,
  }
}

describe('SyncCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('开关切换调用 setSyncEnabled', async () => {
    const platform = mkPlatform()
    const w = mount(SyncCard, { props: { platform } })
    await w.find('input.sync-toggle').setValue(true)
    expect(platform.setSyncEnabled).toHaveBeenCalledWith(true)
    await w.find('input.sync-toggle').setValue(false)
    expect(platform.setSyncEnabled).toHaveBeenCalledWith(false)
  })

  it('状态 ok：绿色显示上次同步时间', async () => {
    const platform = mkPlatform({ state: 'ok', at: new Date('2026-09-14T12:34:56').getTime() })
    const w = mount(SyncCard, { props: { platform } })
    await vi.waitFor(() => expect(w.text()).toContain('上次同步'))
    expect(w.find('.status.sync-ok').exists()).toBe(true)
    expect(w.text()).toContain('12:34:56')
  })

  it('状态 quota：黄色提示建议关闭同步', async () => {
    const platform = mkPlatform({ state: 'quota', at: Date.now() })
    const w = mount(SyncCard, { props: { platform } })
    await vi.waitFor(() => expect(w.text()).toContain('同步空间已满'))
    expect(w.find('.status.sync-quota').exists()).toBe(true)
    expect(w.text()).toContain('建议配置云备份后关闭浏览器同步')
  })

  it('开关开启且未启用加密：状态条区域显示明文同步警示；label 不承诺加密分片', async () => {
    const platform = mkPlatform(null, { syncEnabled: true, hasEncryption: ref(false) })
    const w = mount(SyncCard, { props: { platform } })
    expect(w.find('.warn').exists()).toBe(true)
    expect(w.text()).toContain('当前未启用本地加密，条目将以明文同步至浏览器账号云端')
    expect(w.text()).toContain('建议先在安全设置中启用加密')
    expect(w.text()).not.toContain('数据加密分片同步')
  })

  it('开关开启且已启用加密：不显示明文同步警示', () => {
    const platform = mkPlatform(null, { syncEnabled: true, hasEncryption: ref(true) })
    const w = mount(SyncCard, { props: { platform } })
    expect(w.find('.warn').exists()).toBe(false)
  })

  it('开关关闭（即使未加密）或 hasEncryption 未提供：不显示明文同步警示', () => {
    const off = mount(SyncCard, { props: { platform: mkPlatform(null, { syncEnabled: false, hasEncryption: ref(false) }) } })
    expect(off.find('.warn').exists()).toBe(false)
    const unknown = mount(SyncCard, { props: { platform: mkPlatform(null, { syncEnabled: true }) } })
    expect(unknown.find('.warn').exists()).toBe(false)
  })
})
