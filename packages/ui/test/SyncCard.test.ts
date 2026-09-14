import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SyncCard from '../src/components/SyncCard.vue'

function mkPlatform(status: { state: string; at: number } | null = null) {
  return {
    syncEnabled: false,
    setSyncEnabled: vi.fn().mockResolvedValue(undefined),
    readStatus: vi.fn().mockResolvedValue(status),
    canSync: true,
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
})
