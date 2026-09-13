import type { StorageAdapter } from './adapter'

export function createMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>()
  return {
    async get(key) { return map.get(key) ?? null },
    async set(key, value) { map.set(key, value) },
    async delete(key) { map.delete(key) },
  }
}
