import {
  DEFAULT_SETTINGS, addEntry, addGroup, loadSettings, loadVault, removeEntry, removeGroup,
  renameGroup, reorderEntries, saveSettings, saveVault, updateEntry,
  type AppSettings, type OtpEntry, type StorageAdapter, type Vault,
} from '@totp/core'
import { reactive, toRaw } from 'vue'

export function createVueStore(
  adapter: StorageAdapter,
  opts: { registerSync?: (cb: (payload: { vault?: boolean; settings?: boolean }) => void) => void } = {},
) {
  const vault = reactive<Vault>({ version: 1, entries: [], groups: [], updatedAt: 0 })
  const settings = reactive<AppSettings>({ ...DEFAULT_SETTINGS })
  let inited = false
  const lastSelfWrite = { vault: 0, settings: 0 }
  let queue: Promise<void> = Promise.resolve()

  function replaceVault(v: Vault): void {
    vault.version = v.version
    vault.updatedAt = v.updatedAt
    vault.entries.splice(0, vault.entries.length, ...v.entries)
    vault.groups.splice(0, vault.groups.length, ...v.groups)
  }

  async function initStore(): Promise<void> {
    if (inited) return
    const [v, s] = await Promise.all([loadVault(adapter), loadSettings(adapter)])
    replaceVault(v)
    Object.assign(settings, s)
    inited = true
  }

  async function commit(fn: (v: Vault) => Vault): Promise<void> {
    queue = queue.then(async () => {
      replaceVault(fn(vault))
      try {
        lastSelfWrite.vault = Date.now()
        await saveVault(adapter, toRaw(vault) as Vault)
      } catch (e) {
        console.error('[store] saveVault failed:', e)
      }
    })
    return queue
  }

  async function commitSettings(): Promise<void> {
    queue = queue.then(async () => {
      try {
        lastSelfWrite.settings = Date.now()
        await saveSettings(adapter, toRaw(settings) as AppSettings)
      } catch (e) {
        console.error('[store] saveSettings failed:', e)
      }
    })
    return queue
  }

  function registerStorageSync(): void {
    opts.registerSync?.((payload) => {
      if (payload.vault && Date.now() - lastSelfWrite.vault >= 500) {
        loadVault(adapter).then(replaceVault).catch(() => {})
      }
      if (payload.settings && Date.now() - lastSelfWrite.settings >= 500) {
        loadSettings(adapter).then((s) => Object.assign(settings, s)).catch(() => {})
      }
    })
  }

  return {
    vault, settings, initStore, registerStorageSync, commit, commitSettings,
    addEntryOp: (entry: OtpEntry) => commit((v) => addEntry(v, entry)),
    updateEntryOp: (uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>) => commit((v) => updateEntry(v, uuid, patch)),
    removeEntryOp: (uuid: string) => commit((v) => removeEntry(v, uuid)),
    addGroupOp: (name: string) => commit((v) => addGroup(v, name)),
    renameGroupOp: (id: string, name: string) => commit((v) => renameGroup(v, id, name)),
    removeGroupOp: (id: string) => commit((v) => removeGroup(v, id)),
    reorderOp: (uuids: string[]) => commit((v) => reorderEntries(v, uuids)),
    // 整体替换（恢复备份/导入）：replaceVault 用 splice 逐项拷入，保证响应式与深拷贝语义
    replaceAllOp: (v: Vault) => commit(() => v),
  }
}

export type VueStore = ReturnType<typeof createVueStore>
