import { exists, mkdir, readTextFile, remove, rename, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
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
      // 原子写：先写 .tmp 再 rename 覆盖，避免写一半崩溃导致 vault 损坏
      await writeTextFile(`${file(key)}.tmp`, value, { baseDir: BaseDirectory.AppData })
      // plugin-fs v2 RenameOptions 仅支持 oldPathBaseDir/newPathBaseDir（无 baseDir）
      await rename(`${file(key)}.tmp`, file(key), { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData })
    },
    async delete(key) {
      if (await exists(file(key), { baseDir: BaseDirectory.AppData })) await remove(file(key), { baseDir: BaseDirectory.AppData })
    },
  }
}
