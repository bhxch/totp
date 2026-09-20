import { DEFAULT_SETTINGS, loadSettings, type AppSettings, type StorageAdapter } from '@totp/core'
import { describe, expect, it } from 'vitest'

const adapterWith = (v: unknown): StorageAdapter => ({
  get: async (k) => (k === 'settings' ? JSON.stringify(v) : null),
  set: async () => {}, delete: async () => {},
})

describe('settings.locale', () => {
  it('缺省 auto；非法值回退默认', async () => {
    expect((await loadSettings(adapterWith({}))).locale).toBe('auto')
    expect((await loadSettings(adapterWith({ locale: 'fr' }))).locale).toBe('auto')
  })
  it('合法值保留', async () => {
    for (const locale of ['zh', 'en'] as const) {
      expect((await loadSettings(adapterWith({ locale }))).locale).toBe(locale)
    }
  })
  it('DEFAULT_SETTINGS 含 locale=auto', () => {
    expect(DEFAULT_SETTINGS.locale).toBe('auto')
  })
})
