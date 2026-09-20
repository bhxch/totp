import { DEFAULT_SETTINGS, loadSettings, type StorageAdapter } from '@totp/core'
import { describe, expect, it } from 'vitest'

const adapterWith = (v: unknown): StorageAdapter => ({
  get: async (k) => (k === 'settings' ? JSON.stringify(v) : null), set: async () => {}, delete: async () => {},
})

describe('settings.themeContrast', () => {
  it('缺省 standard；非法值回退', async () => {
    expect(DEFAULT_SETTINGS.themeContrast).toBe('standard')
    expect((await loadSettings(adapterWith({ themeContrast: 'high' }))).themeContrast).toBe('standard')
    expect((await loadSettings(adapterWith({ themeContrast: 'amoled' }))).themeContrast).toBe('amoled')
  })
})
