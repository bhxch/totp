import type { Vault } from '../model'
import type { StorageAdapter } from './adapter'
import { createVault } from '../vault'

export const VAULT_KEY = 'vault'

export async function loadVault(adapter: StorageAdapter): Promise<Vault> {
  const raw = await adapter.get(VAULT_KEY)
  if (raw === null) return createVault()
  try {
    return JSON.parse(raw) as Vault
  } catch {
    throw new Error('vault corrupted')
  }
}

export async function saveVault(adapter: StorageAdapter, vault: Vault): Promise<void> {
  await adapter.set(VAULT_KEY, JSON.stringify(vault))
}

export const SETTINGS_KEY = 'settings'

export interface AppSettings {
  urlFilterEnabled: boolean
  blurHideEnabled: boolean
}

export const DEFAULT_SETTINGS: AppSettings = { urlFilterEnabled: true, blurHideEnabled: false }

export async function loadSettings(adapter: StorageAdapter): Promise<AppSettings> {
  const raw = await adapter.get(SETTINGS_KEY)
  if (raw === null) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return {
      urlFilterEnabled: typeof parsed.urlFilterEnabled === 'boolean' ? parsed.urlFilterEnabled : DEFAULT_SETTINGS.urlFilterEnabled,
      blurHideEnabled: typeof parsed.blurHideEnabled === 'boolean' ? parsed.blurHideEnabled : DEFAULT_SETTINGS.blurHideEnabled,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(adapter: StorageAdapter, settings: AppSettings): Promise<void> {
  await adapter.set(SETTINGS_KEY, JSON.stringify(settings))
}
