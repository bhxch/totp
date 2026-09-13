import {
  addEntry, addGroup, createVault, loadSettings, loadVault, removeEntry, removeGroup,
  renameGroup, reorderEntries, saveSettings, saveVault, updateEntry,
  type AppSettings, type OtpEntry, type Vault,
} from '@totp/core'
import { reactive, toRaw } from 'vue'
import { createChromeStorage } from './chromeStorage'

const adapter = createChromeStorage()

export const vault = reactive<Vault>(createVault())
export const settings = reactive<AppSettings>({ urlFilterEnabled: true })

let inited = false
let lastSelfWriteAt = 0
let queue: Promise<void> = Promise.resolve()
let saveTimer: ReturnType<typeof setTimeout> | null = null

export async function initStore(): Promise<void> {
  if (inited) return
  const [v, s] = await Promise.all([loadVault(adapter), loadSettings(adapter)])
  replaceVault(v)
  Object.assign(settings, s)
  inited = true
}

function replaceVault(v: Vault): void {
  vault.version = v.version
  vault.updatedAt = v.updatedAt
  vault.entries.splice(0, vault.entries.length, ...v.entries)
  vault.groups.splice(0, vault.groups.length, ...v.groups)
}

export function registerStorageSync(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['vault']) return
    if (Date.now() - lastSelfWriteAt < 500) return
    void loadVault(adapter).then(replaceVault)
  })
}

export async function commit(fn: (v: Vault) => Vault): Promise<void> {
  queue = queue.then(async () => {
    replaceVault(fn(vault))
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      lastSelfWriteAt = Date.now()
      await saveVault(adapter, toRaw(vault) as Vault)
    }, 300)
  })
  return queue
}

export async function commitSettings(): Promise<void> {
  lastSelfWriteAt = Date.now()
  await saveSettings(adapter, toRaw(settings) as AppSettings)
}

export const addEntryOp = (entry: OtpEntry) => commit((v) => addEntry(v, entry))
export const updateEntryOp = (uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>) => commit((v) => updateEntry(v, uuid, patch))
export const removeEntryOp = (uuid: string) => commit((v) => removeEntry(v, uuid))
export const addGroupOp = (name: string) => commit((v) => addGroup(v, name))
export const renameGroupOp = (id: string, name: string) => commit((v) => renameGroup(v, id, name))
export const removeGroupOp = (id: string) => commit((v) => removeGroup(v, id))
export const reorderOp = (uuids: string[]) => commit((v) => reorderEntries(v, uuids))
