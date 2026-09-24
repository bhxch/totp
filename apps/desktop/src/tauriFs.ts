import { exists, mkdir, readTextFile, remove, rename, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import type { StorageAdapter } from '@totp/core'

const file = (key: string) => `${key}.json`

/**
 * settings.json 读改写合并（纯函数，便于单测）：盘上旧文本 + 前端新文本 → 落盘文本。
 * why：Rust 侧 shortcutToggleMini / devtools / releasePolicy / mcp 四组配置
 * （src-tauri lib.rs 与 mcp_server.rs）与前端 AppSettings 同写 AppData/settings.json，
 * 且 Rust 各写路径均为合并写保留外来键；前端 adapter.set 原为整文件覆盖，
 * 一次 saveSettings 即抹掉全部 Rust 配置。此函数按 { ...盘上对象, ...新值 } 合并——
 * 新值优先、盘上外来键保留。旧文本缺失/损坏（非法 JSON 或根非对象）时回退纯新值
 * （等价旧整文件覆盖行为，不因历史脏文件阻塞保存）。
 */
export function mergeSettingsPreservingForeign(oldText: string | null, newText: string): string {
  let base: Record<string, unknown> = {}
  if (oldText) {
    try {
      const parsed: unknown = JSON.parse(oldText)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>
      }
    } catch {
      // 旧文本损坏：忽略盘上内容，回退纯新值
    }
  }
  const next = JSON.parse(newText) as Record<string, unknown>
  return JSON.stringify({ ...base, ...next })
}

export async function createTauriFs(): Promise<StorageAdapter> {
  // 简报原用 ensureDir，plugin-fs v2 无此导出，mkdir + recursive 为官方等价 API
  await mkdir('', { baseDir: BaseDirectory.AppData, recursive: true })
  return {
    async get(key) {
      if (!(await exists(file(key), { baseDir: BaseDirectory.AppData }))) return null
      return readTextFile(file(key), { baseDir: BaseDirectory.AppData })
    },
    async set(key, value) {
      // settings.json 读改写合并（P0）：Rust 四组配置（shortcutToggleMini/devtools/releasePolicy/mcp）
      // 共写此文件，整文件覆盖会抹掉它们——必须保留外来键，见 mergeSettingsPreservingForeign why 注释
      let payload = value
      if (key === 'settings') {
        let old: string | null = null
        try {
          if (await exists(file(key), { baseDir: BaseDirectory.AppData })) {
            old = await readTextFile(file(key), { baseDir: BaseDirectory.AppData })
          }
        } catch {
          old = null // 读失败按无旧文件处理（回退纯新值）
        }
        payload = mergeSettingsPreservingForeign(old, value)
      }
      // 原子写：先写 .tmp 再 rename 覆盖，避免写一半崩溃导致 vault 损坏
      await writeTextFile(`${file(key)}.tmp`, payload, { baseDir: BaseDirectory.AppData })
      // plugin-fs v2 RenameOptions 仅支持 oldPathBaseDir/newPathBaseDir（无 baseDir）
      await rename(`${file(key)}.tmp`, file(key), { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData })
    },
    async delete(key) {
      if (await exists(file(key), { baseDir: BaseDirectory.AppData })) await remove(file(key), { baseDir: BaseDirectory.AppData })
    },
  }
}
