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
  vault, settings, initStore, registerStorageSync, commit, commitSettings,
  locked, hasEncryption, unlock, lock, enableEncryption, disableEncryption, changePassphrase,
} = store
export const addEntryOp = store.addEntryOp
export const updateEntryOp = store.updateEntryOp
export const removeEntryOp = store.removeEntryOp
export const addGroupOp = store.addGroupOp
export const renameGroupOp = store.renameGroupOp
export const removeGroupOp = store.removeGroupOp
export const reorderOp = store.reorderOp
export const replaceAllOp = store.replaceAllOp
