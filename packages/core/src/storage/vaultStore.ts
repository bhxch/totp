import type { Vault } from '../model'
import type { StorageAdapter } from './adapter'
import { DEFAULT_KDF_PROFILE, isKdfProfile, type KdfProfile } from '../crypto/kdfProfile'
import type { TagFilterMode } from '../tags/filter'
import { createVault } from '../vault'
import { MATCH_STRATEGIES, MAX_MATCH_PATTERN_LENGTH, MAX_MATCH_RULES, type MatchStrategy } from '../match/engine'

export const VAULT_KEY = 'vault'

// F6 结构校验口径（经写路径逐字段审计）：仅拒绝「任何写路径都产不出、且运行时不容忍」的形状。
// 刻意容忍（渲染层按 INVALID 呈现，属受支持状态，见 useOtpCodes）：secret 空串/非 base32 串、
// hotp 缺 counter、小数 counter、period<1、未知多余字段。收紧项为全部写路径收敛保证的不变量：
// type/algorithm/digits 枚举（steam 恒 5）、matchRules 形态（数量/strategy 白名单/pattern 长度）。
// 诚实边界：结构校验不能认证内容真实性（形状合法的恶意条目是独立信任问题，属同步认证/新鲜性范畴），
// 仅防畸形结构注入、坏 matchRules 落库与解析期拒绝服务。

function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

function reject(): never {
  throw new Error('vault corrupted')
}

function validateMatchRuleShape(r: unknown, at: string): void {
  if (typeof r !== 'object' || r === null) reject()
  const m = r as Record<string, unknown>
  if (typeof m.strategy !== 'string' || !MATCH_STRATEGIES.includes(m.strategy as MatchStrategy)) reject()
  if (typeof m.pattern !== 'string' || m.pattern.length > MAX_MATCH_PATTERN_LENGTH) reject()
}

function validateEntryShape(e: unknown, at: string): void {
  if (typeof e !== 'object' || e === null) reject()
  const o = e as Record<string, unknown>
  if (typeof o.uuid !== 'string') reject()
  if (o.type !== 'totp' && o.type !== 'hotp' && o.type !== 'steam' && o.type !== 'yandex') reject()
  if (typeof o.issuer !== 'string' || typeof o.label !== 'string' || typeof o.secret !== 'string') reject()
  if (o.algorithm !== 'SHA1' && o.algorithm !== 'SHA256' && o.algorithm !== 'SHA512') reject()
  // steam 全路径收敛 digits=5、yandex 全路径收敛 digits=8（toOtpDigits 强制）；totp/hotp 6/7/8
  if (o.digits !== 5 && o.digits !== 6 && o.digits !== 7 && o.digits !== 8) reject()
  if (o.type === 'steam' && o.digits !== 5) reject()
  if (o.type === 'yandex' && o.digits !== 8) reject()
  if (!isFiniteNum(o.period) || o.period <= 0) reject() // toPositiveNumber 收敛为正数；<1 容忍（渲染 INVALID）
  if (o.counter !== undefined && (!isFiniteNum(o.counter) || o.counter < 0)) reject() // 可缺省（hotp 可无 counter）；小数容忍
  if (!Array.isArray(o.tagIds) || o.tagIds.some((t) => typeof t !== 'string')) reject()
  if (!isFiniteNum(o.order) || !isFiniteNum(o.createdAt)) reject()
  if (o.note !== undefined && typeof o.note !== 'string') reject()
  if (o.pinned !== undefined && typeof o.pinned !== 'boolean') reject()
  // yandex PIN 可选；出现时必须是字符串（空串合法）
  if (o.pin !== undefined && typeof o.pin !== 'string') reject()
  if (o.icon !== undefined) {
    if (typeof o.icon !== 'object' || o.icon === null) reject()
    const ic = o.icon as Record<string, unknown>
    if (ic.kind !== 'builtin' && ic.kind !== 'stored' && ic.kind !== 'url') reject()
    if (typeof ic.id !== 'string') reject()
    if (ic.kind === 'url' && typeof ic.url !== 'string') reject()
  }
  if (o.matchRules !== undefined) {
    if (!Array.isArray(o.matchRules)) reject()
    if (o.matchRules.length > MAX_MATCH_RULES) reject()
    o.matchRules.forEach((r, j) => validateMatchRuleShape(r, `${at}.matchRules[${j}]`))
  }
}

/** F6：vault 采用面唯一结构校验（loadVault 与 ui replaceVault 收口共用）。
 *  校验失败抛错（消息统一 'vault corrupted' 语义），调用方必须整记录拒绝、不得部分采纳。 */
export function validateVaultObject(v: unknown): asserts v is Vault {
  if (typeof v !== 'object' || v === null) reject()
  const o = v as Record<string, unknown>
  if (o.version !== 2) reject() // v1 旧盘本就被拒（spec 裁定零迁移硬失败）
  if (!Array.isArray(o.entries) || !Array.isArray(o.tags)) reject()
  if (!isFiniteNum(o.updatedAt)) reject()
  if (o.rev !== undefined && (!isFiniteNum(o.rev) || o.rev < 0)) reject()
  o.tags.forEach((t, i) => {
    if (typeof t !== 'object' || t === null) reject()
    const tag = t as Record<string, unknown>
    if (typeof tag.id !== 'string' || typeof tag.name !== 'string') reject()
  })
  o.entries.forEach((e, i) => validateEntryShape(e, `entries[${i}]`))
}

export async function loadVault(adapter: StorageAdapter): Promise<Vault> {
  const raw = await adapter.get(VAULT_KEY)
  if (raw === null) return createVault()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('vault corrupted')
  }
  try {
    validateVaultObject(parsed)
  } catch {
    throw new Error('vault corrupted')
  }
  return parsed
}

export async function saveVault(adapter: StorageAdapter, vault: Vault): Promise<void> {
  await adapter.set(VAULT_KEY, JSON.stringify(vault))
}

export const SETTINGS_KEY = 'settings'

export type ThemeMode = 'light' | 'dark' | 'auto'

/** 云同步跟随偏好（跨端同步 T3）：autoFollow=解锁时自动拉取云端更新（与备份/云自动通道
 *  的 cloudAutoPrefs 键相互独立）。缺省 true——跟随拉取是默认行为，显式关闭才退回手动 */
export interface SyncPrefs {
  autoFollow: boolean
}

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
  /** tag 过滤模式：any=命中任一（并集）/ all=需命中全部选中（交集）；偏好，始终持久化（spec §3） */
  tagFilterMode: TagFilterMode
  /** 「记住标签筛选」开关：开则 popup 与管理页读写同一份 lastTagFilterIds */
  rememberTagFilter: boolean
  /** 选中 tag 集合持久化载体；仅 rememberTagFilter 开启时读写（关闭不清除已存值） */
  lastTagFilterIds: string[]
  /** 界面语言：auto=跟随浏览器语言（非 en 即 zh）；zh 源语言兼回退（spec §1） */
  locale: 'auto' | 'zh' | 'en'
  /** 纯黑对比度档（spec §5）：amoled=暗色表面覆盖为 #000 系（OLED 省电+对比），仅影响表面色 */
  themeContrast: 'standard' | 'amoled'
  /** 云同步跟随偏好（跨端同步 T3） */
  syncPrefs: SyncPrefs
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
  tagFilterMode: 'any', rememberTagFilter: false, lastTagFilterIds: [],
  locale: 'auto',
  themeContrast: 'standard',
  syncPrefs: { autoFollow: true },
}

/** syncPrefs 归一化（跨端同步 T3）：整体非对象或缺字段逐位回默认；autoFollow 仅认显式
 *  false（缺失/非法 → true），与 loadSettings 既有「boolean 校验回 DEFAULT」口径一致——
 *  本字段的 DEFAULT 恰为 true，故语义为「仅显式 false 生效」 */
function normalizeSyncPrefs(v: unknown): SyncPrefs {
  const p = (v ?? {}) as Partial<SyncPrefs>
  return { autoFollow: p.autoFollow === false ? false : true }
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
      tagFilterMode: merged.tagFilterMode === 'any' || merged.tagFilterMode === 'all' ? merged.tagFilterMode : DEFAULT_SETTINGS.tagFilterMode,
      rememberTagFilter: typeof merged.rememberTagFilter === 'boolean' ? (merged.rememberTagFilter as boolean) : DEFAULT_SETTINGS.rememberTagFilter,
      lastTagFilterIds: Array.isArray(merged.lastTagFilterIds) && merged.lastTagFilterIds.every((x) => typeof x === 'string') ? (merged.lastTagFilterIds as string[]) : DEFAULT_SETTINGS.lastTagFilterIds,
      locale: merged.locale === 'zh' || merged.locale === 'en' || merged.locale === 'auto' ? merged.locale : DEFAULT_SETTINGS.locale,
      themeContrast: merged.themeContrast === 'amoled' ? merged.themeContrast : 'standard',
      syncPrefs: normalizeSyncPrefs(merged.syncPrefs),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(adapter: StorageAdapter, settings: AppSettings): Promise<void> {
  await adapter.set(SETTINGS_KEY, JSON.stringify(settings))
}
