import type { StorageAdapter } from '@totp/core'

export function createChromeStorage(): StorageAdapter {
  return {
    async get(key) {
      const o = await chrome.storage.local.get(key)
      return (o[key] as string | undefined) ?? null
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value })
    },
    async delete(key) {
      await chrome.storage.local.remove(key)
    },
  }
}
