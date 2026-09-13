import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import { loadSettings, saveSettings, DEFAULT_SETTINGS, SETTINGS_KEY } from '../src/storage/vaultStore'

describe('settingsStore', () => {
  it('缺省返回默认设置', async () => {
    expect(await loadSettings(createMemoryStorage())).toEqual(DEFAULT_SETTINGS)
  })
  it('save/load 往返', async () => {
    const s = createMemoryStorage()
    await saveSettings(s, { urlFilterEnabled: false, blurHideEnabled: false })
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: false, blurHideEnabled: false })
  })
  it('损坏 JSON 回退默认值', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, '{oops')
    expect(await loadSettings(s)).toEqual(DEFAULT_SETTINGS)
  })
  it('未知字段被丢弃（只保留已知键）', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ urlFilterEnabled: true, hacked: 1 }))
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: true, blurHideEnabled: false })
  })
  it('类型非法的值回退默认', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ urlFilterEnabled: 'false' }))
    expect(await loadSettings(s)).toEqual(DEFAULT_SETTINGS)
  })
  it('blurHideEnabled 缺省 false；非法类型回退 false', async () => {
    const s = createMemoryStorage()
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: true, blurHideEnabled: false })
    await s.set(SETTINGS_KEY, JSON.stringify({ blurHideEnabled: 'yes' }))
    expect((await loadSettings(s)).blurHideEnabled).toBe(false)
  })
})
