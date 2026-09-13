import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import { loadSettings, saveSettings, DEFAULT_SETTINGS, SETTINGS_KEY } from '../src/storage/vaultStore'

describe('settingsStore', () => {
  it('缺省返回默认设置', async () => {
    expect(await loadSettings(createMemoryStorage())).toEqual(DEFAULT_SETTINGS)
  })
  it('save/load 往返', async () => {
    const s = createMemoryStorage()
    await saveSettings(s, { urlFilterEnabled: false })
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: false })
  })
  it('损坏 JSON 回退默认值', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, '{oops')
    expect(await loadSettings(s)).toEqual(DEFAULT_SETTINGS)
  })
  it('未知字段被丢弃（只保留已知键）', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ urlFilterEnabled: true, hacked: 1 }))
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: true })
  })
})
