import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import { loadSettings, saveSettings, DEFAULT_SETTINGS, SETTINGS_KEY } from '../src/storage/vaultStore'

describe('settingsStore', () => {
  it('缺省返回默认设置', async () => {
    expect(await loadSettings(createMemoryStorage())).toEqual(DEFAULT_SETTINGS)
  })
  it('save/load 往返', async () => {
    const s = createMemoryStorage()
    await saveSettings(s, { urlFilterEnabled: false, blurHideEnabled: false, clipboardClearEnabled: false, popupCloseDelayMs: 5000, syncEnabled: true })
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: false, blurHideEnabled: false, clipboardClearEnabled: false, popupCloseDelayMs: 5000, syncEnabled: true })
  })
  it('损坏 JSON 回退默认值', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, '{oops')
    expect(await loadSettings(s)).toEqual(DEFAULT_SETTINGS)
  })
  it('未知字段被丢弃（只保留已知键）', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ urlFilterEnabled: true, hacked: 1 }))
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: true, blurHideEnabled: false, clipboardClearEnabled: true, popupCloseDelayMs: 2000, syncEnabled: false })
  })
  it('类型非法的值回退默认', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ urlFilterEnabled: 'false' }))
    expect(await loadSettings(s)).toEqual(DEFAULT_SETTINGS)
  })
  it('blurHideEnabled 缺省 false；非法类型回退 false', async () => {
    const s = createMemoryStorage()
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: true, blurHideEnabled: false, clipboardClearEnabled: true, popupCloseDelayMs: 2000, syncEnabled: false })
    await s.set(SETTINGS_KEY, JSON.stringify({ blurHideEnabled: 'yes' }))
    expect((await loadSettings(s)).blurHideEnabled).toBe(false)
  })
  it('clipboardClearEnabled 缺省 true；非法类型回退 true', async () => {
    const s = createMemoryStorage()
    expect((await loadSettings(s)).clipboardClearEnabled).toBe(true)
    await s.set(SETTINGS_KEY, JSON.stringify({ clipboardClearEnabled: 'no' }))
    expect((await loadSettings(s)).clipboardClearEnabled).toBe(true)
  })
  it('popupCloseDelayMs 缺省 2000；非法类型回退 2000', async () => {
    const s = createMemoryStorage()
    expect((await loadSettings(s)).popupCloseDelayMs).toBe(2000)
    await s.set(SETTINGS_KEY, JSON.stringify({ popupCloseDelayMs: '2000' }))
    expect((await loadSettings(s)).popupCloseDelayMs).toBe(2000)
  })
  it('syncEnabled 缺省 false；非法类型回退 false', async () => {
    const s = createMemoryStorage()
    expect((await loadSettings(s)).syncEnabled).toBe(false)
    await s.set(SETTINGS_KEY, JSON.stringify({ syncEnabled: 'yes' }))
    expect((await loadSettings(s)).syncEnabled).toBe(false)
  })
})
