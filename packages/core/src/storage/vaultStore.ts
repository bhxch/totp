import type { Vault } from '../model'
import type { StorageAdapter } from './adapter'
import { DEFAULT_KDF_PROFILE, isKdfProfile, type KdfProfile } from '../crypto/kdfProfile'
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

export type ThemeMode = 'light' | 'dark' | 'auto'

export interface AppSettings {
  urlFilterEnabled: boolean
  blurHideEnabled: boolean
  /** 复制后 30s 自动清空剪贴板 */
  clipboardClearEnabled: boolean
  /** popup「已复制」反馈后的自动关闭延迟（毫秒） */
  popupCloseDelayMs: number
  /** 浏览器同步（chrome.storage 分片同步）总开关：默认关闭，需用户显式开启 */
  syncEnabled: boolean
  /** 主题模式:auto=跟随系统(prefers-color-scheme) */
  themeMode: ThemeMode
  /** 主题种子色 id(packages/ui theme/palettes.json 定义);core 仅做格式校验 */
  themeColor: string
  /** 锁定策略（设计 §1）：「重启后保持锁定」开关。勘误（审查 Minor）：当前两端重启均天然锁定——
   *  desktop 的 DEK 仅内存级、extension 的 DEK 存宿主会话存储（浏览器退出必清），重启即锁由 DEK
   *  生命周期决定而非本开关；false 的「浏览器会话内保持解锁」暂无实现支撑，字段仅持久化保留
   *  （extension 已声明不支持并在 UI 隐藏该控件） */
  lockOnRestart: boolean
  /** 空闲超时锁定分钟数；0=禁用 */
  lockIdleMinutes: number
  /** 系统锁屏即锁定（desktop=Tauri 事件；extension=chrome.idle 'locked'） */
  lockOnSystemLock: boolean
  /** 备份加密强度档位（plan16 §2：本地备份与云上传 envelope 按此档位生成；与本地库档位 securityStore 各自独立） */
  backupKdfProfile: KdfProfile
}

export const DEFAULT_SETTINGS: AppSettings = {
  urlFilterEnabled: true,
  blurHideEnabled: false,
  clipboardClearEnabled: true,
  popupCloseDelayMs: 2000,
  syncEnabled: false,
  themeMode: 'auto',
  themeColor: 'blue',
  lockOnRestart: true,
  lockIdleMinutes: 0,
  lockOnSystemLock: true,
  backupKdfProfile: DEFAULT_KDF_PROFILE,
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
      themeMode: merged.themeMode === 'light' || merged.themeMode === 'dark' || merged.themeMode === 'auto' ? merged.themeMode : DEFAULT_SETTINGS.themeMode,
      themeColor: typeof merged.themeColor === 'string' && merged.themeColor.length > 0 && merged.themeColor.length <= 32 ? merged.themeColor : DEFAULT_SETTINGS.themeColor,
      lockOnRestart: typeof merged.lockOnRestart === 'boolean' ? (merged.lockOnRestart as boolean) : DEFAULT_SETTINGS.lockOnRestart,
      lockIdleMinutes: typeof merged.lockIdleMinutes === 'number' && Number.isInteger(merged.lockIdleMinutes) && merged.lockIdleMinutes >= 0 ? (merged.lockIdleMinutes as number) : DEFAULT_SETTINGS.lockIdleMinutes,
      lockOnSystemLock: typeof merged.lockOnSystemLock === 'boolean' ? (merged.lockOnSystemLock as boolean) : DEFAULT_SETTINGS.lockOnSystemLock,
      backupKdfProfile: isKdfProfile(merged.backupKdfProfile) ? merged.backupKdfProfile : DEFAULT_SETTINGS.backupKdfProfile,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(adapter: StorageAdapter, settings: AppSettings): Promise<void> {
  await adapter.set(SETTINGS_KEY, JSON.stringify(settings))
}
