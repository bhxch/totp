import { createVueStore } from '@totp/ui'
import { createChromeStorage } from './chromeStorage'

export const store = createVueStore(createChromeStorage(), {
  registerSync: (cb) =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      cb({ vault: !!changes['vault'], settings: !!changes['settings'] })
    }),
})

export const { vault, settings, initStore, registerStorageSync, commit, commitSettings } = store
export const addEntryOp = store.addEntryOp
export const updateEntryOp = store.updateEntryOp
export const removeEntryOp = store.removeEntryOp
export const addGroupOp = store.addGroupOp
export const renameGroupOp = store.renameGroupOp
export const removeGroupOp = store.removeGroupOp
export const reorderOp = store.reorderOp
