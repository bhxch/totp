import { createVueStore } from '@totp/ui'
import { createChromeStorage } from './chromeStorage'

/** 共享 chrome.storage.local 适配器：vault 与 icons 同源（popup/options 各自建 IconStore 用） */
export const storageAdapter = createChromeStorage()

export const store = createVueStore(storageAdapter, {
  registerSync: (cb) =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      cb({ vault: !!changes['vault'], settings: !!changes['settings'] })
    }),
})

export const {
  vault, settings, initStore, registerStorageSync,
  locked, hasEncryption, unlock, lock, enableEncryption, disableEncryption, changePassphrase,
} = store
const { commit: storeCommit, commitSettings: storeCommitSettings } = store

/** 浏览器同步推送调度：commit/commitSettings 成功后 debounce 1s 合并连写为一次推送。
 *  syncEnabled=false 直接短路不发消息；background 收到后还会复核（双保险） */
let syncPushTimer: ReturnType<typeof setTimeout> | undefined
export function scheduleSyncPush(): void {
  if (settings.syncEnabled !== true) return
  if (syncPushTimer !== undefined) clearTimeout(syncPushTimer)
  syncPushTimer = setTimeout(() => {
    syncPushTimer = undefined
    try {
      void chrome.runtime.sendMessage({ type: 'sync-push' }).catch(() => {}) // background 未就绪等场景不打扰
    } catch {
      // 扩展上下文失效（重载中）：忽略
    }
  }, 1000)
}

/** 失败不调度：commit reject（如锁定）时盘上未变更，推送无意义 */
export async function commit(fn: Parameters<typeof storeCommit>[0]): Promise<void> {
  await storeCommit(fn)
  scheduleSyncPush()
}

export async function commitSettings(): Promise<void> {
  await storeCommitSettings()
  scheduleSyncPush()
}

export const addEntryOp = store.addEntryOp
export const updateEntryOp = store.updateEntryOp
export const removeEntryOp = store.removeEntryOp
export const addGroupOp = store.addGroupOp
export const renameGroupOp = store.renameGroupOp
export const removeGroupOp = store.removeGroupOp
export const reorderOp = store.reorderOp
export const replaceAllOp = store.replaceAllOp
