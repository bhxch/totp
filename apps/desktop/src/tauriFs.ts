import { exists, mkdir, readTextFile, remove, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import type { StorageAdapter } from '@totp/core'

const file = (key: string) => `${key}.json`

export async function createTauriFs(): Promise<StorageAdapter> {
  // 简报原用 ensureDir，plugin-fs v2 无此导出，mkdir + recursive 为官方等价 API
  await mkdir('', { baseDir: BaseDirectory.AppData, recursive: true })
  return {
    async get(key) {
      if (!(await exists(file(key), { baseDir: BaseDirectory.AppData }))) return null
      return readTextFile(file(key), { baseDir: BaseDirectory.AppData })
    },
    async set(key, value) {
      await writeTextFile(file(key), value, { baseDir: BaseDirectory.AppData })
    },
    async delete(key) {
      if (await exists(file(key), { baseDir: BaseDirectory.AppData })) await remove(file(key), { baseDir: BaseDirectory.AppData })
    },
  }
}
