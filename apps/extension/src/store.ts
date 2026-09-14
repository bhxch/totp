import { createVueStore, type VueStore } from '@totp/ui'
import { createChromeStorage } from './chromeStorage'

/** 共享 chrome.storage.local 适配器：vault 与 icons 同源（popup/options 各自建 IconStore 用） */
export const storageAdapter = createChromeStorage()

/** 浏览器同步推送调度：syncEnabled=false 短路不发消息，否则立即 sendMessage。
 *  不在页面端 debounce——popup 发完即可能失焦销毁，1s 合并窗口由 background 承接（SW 收到消息后合并） */
function scheduleSyncPush(s: VueStore): void {
  if (s.settings.syncEnabled !== true) return
  try {
    void chrome.runtime.sendMessage({ type: 'sync-push' }).catch(() => {}) // background 未就绪等场景不打扰
  } catch {
    // 扩展上下文失效（重载中）：忽略
  }
}

/** 扩展创建独立 store 的工厂：spec §7 末尾要求窗口独立解锁，popup/options 各持各的 locked/dek；
 *  windowId 决定闭包内的 Map 索引——同进程多 store 实例互不泄漏 */
export function createExtensionStore(windowId: string): VueStore {
  const s = createVueStore(storageAdapter, {
    windowId,
    registerSync: (cb) =>
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return
        cb({ vault: !!changes['vault'], settings: !!changes['settings'] })
      }),
    onCommitted: () => scheduleSyncPush(s),
  })
  return s
}

/** 失败不调度：commit reject（如锁定）时盘上未变更，推送无意义 */
export async function commit(fn: Parameters<NonNullable<ReturnType<typeof createVueStore>['commit']>>[0]): Promise<void> {
  if (!store) throw new Error('store not initialized')
  await store.commit(fn)
  scheduleSyncPush(store)
}

export async function commitSettings(): Promise<void> {
  if (!store) throw new Error('store not initialized')
  await store.commitSettings()
  scheduleSyncPush(store)
}

// ---------- popup 单例 ----------
/** popup 入口独立 store（windowId='popup'）：与 options 隔离，spec §7 末尾窗口独立解锁 */
export const store = createExtensionStore('popup')

export const {
  vault, initStore, registerStorageSync,
  locked, hasEncryption, unlock, lock, enableEncryption, disableEncryption, changePassphrase,
  prfSources, addPrfSourceOp, removePrfSourceOp, settings,
} = store
export const { commit: storeCommit, commitSettings: storeCommitSettings } = store

export const addEntryOp = store.addEntryOp
export const updateEntryOp = store.updateEntryOp
export const removeEntryOp = store.removeEntryOp
export const addGroupOp = store.addGroupOp
export const renameGroupOp = store.renameGroupOp
export const removeGroupOp = store.removeGroupOp
export const reorderOp = store.reorderOp
export const replaceAllOp = store.replaceAllOp