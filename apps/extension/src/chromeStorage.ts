import type { StorageAdapter } from '@totp/core'
import { ext } from './extApi'

export function createChromeStorage(): StorageAdapter {
  return {
    async get(key) {
      if (!ext) return null
      const o = await ext.storage.local.get(key)
      return (o[key] as string | undefined) ?? null
    },
    async set(key, value) {
      if (!ext) return
      await ext.storage.local.set({ [key]: value })
    },
    async delete(key) {
      if (!ext) return
      await ext.storage.local.remove(key)
    },
  }
}
