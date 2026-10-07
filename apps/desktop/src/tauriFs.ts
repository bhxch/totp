import { exists, mkdir, readTextFile, remove, rename, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import type { StorageAdapter } from '@totp/core'

/**
 * R4-C1：存储键 → 盘上文件名安全映射（encodeURIComponent 可逆编码）。
 * why：存储键不是文件名安全的——iconStore per-icon 键前缀 `icon:` 与 URL 缓存前缀
 * `urlcache:` 都含冒号，Windows 下 `icon:xxx.json` 会写成 0 字节基文件 `icon` 的 NTFS ADS
 * 流（且 Node 层对含冒号路径 rename 报 EINVAL）；zip 内不可信文件名产出的 id 还可能带
 * `\ / * ? " < > |` 等字符，直接拼接会写到不存在的子目录。encodeURIComponent 一处修复
 * 同时覆盖 `icon:` 与既有 `urlcache:` 前缀键；纯字母数字键（settings/icons/vault 等）
 * 编码后不变，`settings.json` 等既有文件名不受影响。
 */
const file = (key: string) => `${encodeURIComponent(key)}.json`
/** 旧布局原名（未编码）文件名：仅当与映射名不同（键含特殊字符）时参与存量兼容查找 */
const legacyFile = (key: string) => `${key}.json`

/** exists 容错包装：仅用于旧原名文件查找——含冒号等路径在部分运行时 exists 即抛错，
 *  按无旧文件处理回退，不放大故障。映射名主路径的 exists 抛错保持向上传播（宿主兜底可见）。 */
async function legacyExists(name: string): Promise<boolean> {
  try {
    return await exists(name, { baseDir: BaseDirectory.AppData })
  } catch {
    return false
  }
}

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
      const mapped = file(key)
      if (!(await exists(mapped, { baseDir: BaseDirectory.AppData }))) {
        // R4-C1 存量兼容：映射名未命中且键含特殊字符（映射名≠原名）时回退查旧原名文件
        // （升级前版本写的 `urlcache:<id>.json` 等）；命中即读取并顺带迁移为映射名
        const legacy = legacyFile(key)
        if (legacy === mapped || !(await legacyExists(legacy))) return null
        let text: string
        try {
          text = await readTextFile(legacy, { baseDir: BaseDirectory.AppData })
        } catch {
          return null // 旧文件读失败（如部分运行时对含冒号路径 EINVAL）：按无数据处理，不放大为启动失败
        }
        try {
          // 迁移 = 复用原子写落映射名 → 删旧名；删旧失败无害（get 恒优先映射名，仅留冗余文件）
          await writeTextFile(`${mapped}.tmp`, text, { baseDir: BaseDirectory.AppData })
          await rename(`${mapped}.tmp`, mapped, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData })
          await remove(legacy, { baseDir: BaseDirectory.AppData }).catch(() => {})
        } catch (e) {
          console.warn(`[tauriFs] 存量文件迁移为映射名失败（旧文件保留待下次重试）: ${legacy}`, e)
        }
        return text
      }
      return readTextFile(mapped, { baseDir: BaseDirectory.AppData })
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
      const mapped = file(key)
      if (await exists(mapped, { baseDir: BaseDirectory.AppData })) await remove(mapped, { baseDir: BaseDirectory.AppData })
      // 存量兼容：键含特殊字符时旧原名文件一并清理——否则 get 回退查找会把已删除的值读回来
      const legacy = legacyFile(key)
      if (legacy !== mapped && (await legacyExists(legacy))) await remove(legacy, { baseDir: BaseDirectory.AppData })
    },
  }
}
