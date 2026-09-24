/** 扩展通用 storage.local 适配器：ext 为 WXT browser 包装（Chrome/Firefox 双 MV3 一致），本适配器
 *  只操作扩展通用的 ext.storage.local，与具体浏览器无绑定（原 MV2 双命名空间时代的 chromeStorage
 *  命名名不副实，文件更名 storage.ts；函数名保留 createChromeStorage 以收窄改动面）。
 *  vault、icons、云凭据等键值统一走此适配器（popup/options 各自建 IconStore 用，见 store.ts） */
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
