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
  /** 复制后 30s 自动清空剪贴板 */
  clipboardClearEnabled: boolean
  /** popup「已复制」反馈后的自动关闭延迟（毫秒） */
  popupCloseDelayMs: number
  /** 浏览器同步（chrome.storage 分片同步）总开关：默认关闭，需用户显式开启 */
  syncEnabled: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  urlFilterEnabled: true,
  blurHideEnabled: false,
  clipboardClearEnabled: true,
  popupCloseDelayMs: 2000,
  syncEnabled: false,
}

export async function loadSettings(adapter: StorageAdapter): Promise<AppSettings> {
  const raw = await adapter.get(SETTINGS_KEY)
  if (raw === null) return { ...DEFAULT_SETTINGS }
  try {
    // M4：合并 DEFAULT_SETTINGS 兜底 — 新增 settings 字段时无需同步更新此处的逐字段默认值，
    // 仅需保证类型安全（typeof 校验），类型不匹配字段自动回退到 DEFAULT。
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...parsed }
    return {
      urlFilterEnabled: typeof merged.urlFilterEnabled === 'boolean' ? (merged.urlFilterEnabled as boolean) : DEFAULT_SETTINGS.urlFilterEnabled,
      blurHideEnabled: typeof merged.blurHideEnabled === 'boolean' ? (merged.blurHideEnabled as boolean) : DEFAULT_SETTINGS.blurHideEnabled,
      clipboardClearEnabled: typeof merged.clipboardClearEnabled === 'boolean' ? (merged.clipboardClearEnabled as boolean) : DEFAULT_SETTINGS.clipboardClearEnabled,
      popupCloseDelayMs: typeof merged.popupCloseDelayMs === 'number' ? (merged.popupCloseDelayMs as number) : DEFAULT_SETTINGS.popupCloseDelayMs,
      syncEnabled: typeof merged.syncEnabled === 'boolean' ? (merged.syncEnabled as boolean) : DEFAULT_SETTINGS.syncEnabled,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(adapter: StorageAdapter, settings: AppSettings): Promise<void> {
  await adapter.set(SETTINGS_KEY, JSON.stringify(settings))
}
