/**
 * 网络时间校准核心模型（时间源特性，spec §1/§2/§3）：纯函数 + 常量，无 IO、无时钟读取
 * （deviceNowMs 恒由调用方注入）。状态 TimeSyncState 存设备本地键（TIME_SYNC_STATE_KEY），
 * 不进 AppSettings——浏览器同步整体覆盖 settings、云备份只携带 vault，偏移量属设备属性。
 * 校准执行（HTTP 源序 / SNTP 池）属端实现，经 ui timeSource 单例注入。
 */

/** 设备本地时间校准状态（v1） */
export interface TimeSyncState {
  v: 1
  /** 校准偏移毫秒（=网络时间-设备时间，effectiveNow=device+offset）；null=从未成功 */
  offsetMs: number | null
  /** 上次成功校准时刻（设备时钟 ms）；offsetMs 非 null 时有效。
   *  写入方契约：成功时与 lastAttemptAt 写同一 Date.now() 读数并清 lastAttemptFailed——
   *  shouldAutoCalibrate 的回拨见证（失败读数早于 syncedAt ⟹ 钟在校准后被回拨）依赖该契约 */
  syncedAt: number | null
  /** 上次成功校准的来源 id（HTTPS/NTP 源清单内） */
  sourceId: string | null
  /** 上次尝试时刻（设备时钟 ms，成败均记；自动重试退避依据） */
  lastAttemptAt: number | null
  /** 上次尝试失败标记：TTL 内不自动重试，手动「立即同步」不受限。
   *  回拨见证语义见 syncedAt 注释：failed=true 且 lastAttemptAt < syncedAt ⟹ 钟在校准后被回拨 */
  lastAttemptFailed: boolean
  /** 用户首选源 id；null=自动（端内置顺序） */
  preferredSourceId: string | null
}

export const TIME_SYNC_STATE_KEY = 'timeSyncState'
/** 自动重校周期（spec §3）：正常钟漂移每天 1-2s、烂钟可达 30s；6h 把最坏累计压进 TOTP 半窗口 */
export const TIME_SYNC_TTL_MS = 6 * 60 * 60 * 1000
/** 冷启动入口专用（裁定 R13）——上下文全灭期间系统校时无 tick 可观测，收紧判据覆盖该盲区
 *  （冷启动入口以此作 shouldAutoCalibrate 的 ttlMs；每秒 tick 路径保持默认 6h） */
export const COLD_START_TTL_MS = 10 * 60 * 1000
/** 跳变阈值：回退 ≥5s（系统时间被改）；前跳 ≥60s（被外部拉准）。
 *  前跳不做间隔条件（裁定修订）：wallDelta=正常间隔+跳变幅度，双墙钟采样不可分——
 *  休眠恢复的长前跳会多触发一次校准（无害，校准结果恒正确），漏判则 offset 持续错误致出码错；
 *  <60s 的前跳由 TTL（6h）兜底 */
export const CLOCK_JUMP_BACKWARD_MS = 5000
export const CLOCK_JUMP_FORWARD_MS = 60_000

export const EMPTY_TIME_SYNC_STATE: TimeSyncState = {
  v: 1, offsetMs: null, syncedAt: null, sourceId: null,
  lastAttemptAt: null, lastAttemptFailed: false, preferredSourceId: null,
}

/** 宽容归一化：坏 JSON/缺字段/类型非法逐位回默认（与 loadSettings「非法回 DEFAULT」同口径） */
export function normalizeTimeSyncState(raw: unknown): TimeSyncState {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_TIME_SYNC_STATE }
  const p = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return {
    v: 1,
    offsetMs: num(p['offsetMs']),
    syncedAt: num(p['syncedAt']),
    sourceId: str(p['sourceId']),
    lastAttemptAt: num(p['lastAttemptAt']),
    lastAttemptFailed: p['lastAttemptFailed'] === true,
    preferredSourceId: str(p['preferredSourceId']),
  }
}

/** 自动校准决策（纯函数）：network 模式下，从未成功（无偏移）/ 回拨见证 / 负差（回拨）/
 *  TTL 超龄 / 病态归一判陈旧（需重校），且全部陈旧分类共用同一退避判据——上次尝试失败且
 *  now−lastAttemptAt ∈ [0, ttlMs) 时退避（裁定 R15/R17/R18，spec §3-⑤）。ttlMs 默认
 *  TIME_SYNC_TTL_MS（6h），冷启动入口传 COLD_START_TTL_MS 收紧（裁定 R13）。手动校准
 *  （立即同步）不走此函数，恒允许。
 *  回拨见证（裁定 R18，方案 B）：lastAttemptFailed 且 lastAttemptAt < syncedAt ⟹ 失败发生在
 *  syncedAt（=成功校准的钟读数）之前——该推断依赖写入方契约（成功覆写 lastAttemptAt=syncedAt
 *  并清失败标记，见 TimeSyncState 字段注释），故此形态只可能是成功之后钟被回拨 ⟹ 旧 offset
 *  失效，判陈旧；退避仍适用——回拨后写下的 lastAttemptAt 是有效退避参照，期满即重校，恢复
 *  延迟恰 ttlMs（取代 R17 实测上界 e′+ttlMs）。「退避期前提失效」仅指负差（lastAttemptAt 在
 *  未来，R13b）的情形。零差值不算回拨；无偏移（offsetMs=null）即需校准、不受见证影响，仅受
 *  失败退避约束；病态归一（offset≠null 且 syncedAt=null）同样受退避约束（R18 前为每 tick 风暴）。 */
export function shouldAutoCalibrate(state: TimeSyncState, networkMode: boolean, deviceNowMs: number, ttlMs: number = TIME_SYNC_TTL_MS): boolean {
  if (!networkMode) return false
  const backoff = state.lastAttemptFailed && state.lastAttemptAt !== null
    && deviceNowMs - state.lastAttemptAt >= 0 && deviceNowMs - state.lastAttemptAt < ttlMs
  if (state.offsetMs === null || state.syncedAt === null) return !backoff // 从未成功（无偏移，含首次开启）或病态归一（有偏移无时刻）：按需重校，受失败退避约束
  const age = deviceNowMs - state.syncedAt
  const rolledBack = age < 0 || (state.lastAttemptFailed && state.lastAttemptAt !== null && state.lastAttemptAt < state.syncedAt)
  if (rolledBack || age >= ttlMs) return !backoff
  return false
}

export type ClockJumpKind = 'none' | 'backward' | 'forward'

/** 跳变检测（纯函数；裁定修订：无间隔条件）：回退 ≥5s 判 backward（系统时间被改，无论间隔都真实）；
 *  前跳 ≥60s 判 forward（被外部拉准）。wallDelta=正常间隔+跳变幅度，双墙钟采样不可分，
 *  原「间隔 ≤5s」条件不可观测故删除；休眠恢复长前跳误判=多一次校准（无害），宁误判不漏判 */
export function clockJumpKind(prevMs: number, nowMs: number): ClockJumpKind {
  const delta = nowMs - prevMs
  if (delta < 0) return -delta >= CLOCK_JUMP_BACKWARD_MS ? 'backward' : 'none'
  return delta >= CLOCK_JUMP_FORWARD_MS ? 'forward' : 'none'
}

/** NTP 经典中点公式：offset = server - (t0+t1)/2（秒级源 + RTT 补偿，TOTP 30s 窗口足够） */
export function computeOffsetMs(serverEpochMs: number, requestAtMs: number, responseAtMs: number): number {
  return Math.round(serverEpochMs - (requestAtMs + responseAtMs) / 2)
}

/** HTTPS 源「可采信 RTT 上限」（毫秒；与 Rust 侧 HTTPS_TRUSTED_RTT_MS 一致）：
 *  HTTP JSON/Date 头的时间戳在**响应构建时**生成，而中点公式假设服务端时刻落在请求/响应
 *  中点——origin 排队数秒再出响应时该假设失效（2026-11-13 实测：timeapi.io 与 cf-204 在
 *  RTT≈8.1s 时偏置 +3.9~4.1s，RTT≈0.2s 时偏置仅 +3~11ms）。残差偏置 ≤ RTT/2，故
 *  RTT 超过上限的应答不采信（源兜底下一源），把误差压回秒级截断的地板（±500ms）。
 *  SNTP 不受此限（协议自带精确时戳与 RTT 补偿），桌面端主路径不受影响 */
export const HTTPS_TRUSTED_RTT_MS = 800

/** RTT 是否在可采信范围内（纯函数，端侧共用口径；≤ 上限即采信） */
export function isTrustedHttpRtt(rttMs: number): boolean {
  return Number.isFinite(rttMs) && rttMs >= 0 && rttMs <= HTTPS_TRUSTED_RTT_MS
}

/** 时间源链剖面（2026-11-13 全球源补齐）：'cn'=大陆链（2026-11-10 实测源序，原样保留），
 *  'global'=国际链（全球适用源序）。剖面由**界面语言**决定（ui timeSourceProfileFor：
 *  显式 zh→cn、显式 en→global、auto 按浏览器语言 zh*→cn 其余→global），
 *  端实现（扩展 background / 桌面 Rust）按剖面取对应链，非本链的 preferred id 忽略走内置序 */
export type TimeSourceProfile = 'cn' | 'global'

/** 宽容归一（消息/命令入参口径）：非 'global' 一律 'cn'（未知值回默认链，不放宽成国际链） */
export function normalizeTimeSourceProfile(raw: unknown): TimeSourceProfile {
  return raw === 'global' ? 'global' : 'cn'
}

/** HTTPS 时间源 id（扩展端；顺序=内置优先级，2026-11-10 家庭宽带实测）：
 *  毫秒 API 在前（动态生成免疫 CDN 缓存，淘宝 HEAD Date 滞后 43s 已剔除该形态） */
export const HTTPS_TIME_SOURCE_IDS_CN = ['taobao-api', 'suning-api', 'baidu', 'qq', 'gitee', 'jd', 'cloudflare-trace'] as const
/** HTTPS 时间源 id（国际链；2026-11-13 实测）：毫秒 API（timeapi.io 动态生成、亚秒精度）在前，
 *  trace 文本（Cloudflare anycast、秒级）次之，Date 头源（204/microsoft，无缓存设计）兜底 */
export const HTTPS_TIME_SOURCE_IDS_GLOBAL = ['timeapi', 'cloudflare-trace', 'cloudflare-204', 'microsoft'] as const
export type HttpsTimeSourceId = (typeof HTTPS_TIME_SOURCE_IDS_CN)[number] | (typeof HTTPS_TIME_SOURCE_IDS_GLOBAL)[number]
/** SNTP 源 id（桌面端；顺序=内置优先级；preferred 用户置顶仍全池兜底） */
export const NTP_TIME_SOURCE_IDS_CN = ['aliyun', 'tencent', 'tencent-time1', 'neu', 'cn-pool', 'tuna', 'windows'] as const
/** SNTP 源 id（国际链；2026-11-13 实测可达且互相一致 ±15ms）：
 *  Cloudflare anycast / 全球池 / NIST / Apple / 日本 NICT / 区域池 / Ubuntu */
export const NTP_TIME_SOURCE_IDS_GLOBAL = [
  'time-cloudflare', 'pool', 'time-nist', 'time-apple', 'nict', 'europe-pool', 'asia-pool', 'ubuntu',
] as const
export type NtpTimeSourceId = (typeof NTP_TIME_SOURCE_IDS_CN)[number] | (typeof NTP_TIME_SOURCE_IDS_GLOBAL)[number]

/** 按剖面取 HTTPS 源序（扩展端内置链；preferred 用户置顶仍全链兜底） */
export function httpsTimeSourceIds(profile: TimeSourceProfile): readonly string[] {
  return profile === 'global' ? HTTPS_TIME_SOURCE_IDS_GLOBAL : HTTPS_TIME_SOURCE_IDS_CN
}

/** 按剖面取 SNTP 源序（桌面端池；preferred 用户置顶仍全池兜底） */
export function ntpTimeSourceIds(profile: TimeSourceProfile): readonly string[] {
  return profile === 'global' ? NTP_TIME_SOURCE_IDS_GLOBAL : NTP_TIME_SOURCE_IDS_CN
}

/** 基于 StorageAdapter 的设备本地键读写（扩展端宿主用；桌面用 localStorage 手写包装） */
export function createAdapterTimeSyncIo(adapter: import('../storage/adapter').StorageAdapter): {
  load(): Promise<TimeSyncState | null>
  save(state: TimeSyncState): Promise<void>
} {
  return {
    async load(): Promise<TimeSyncState | null> {
      const raw = await adapter.get(TIME_SYNC_STATE_KEY)
      if (raw === null) return null
      try {
        return normalizeTimeSyncState(JSON.parse(raw))
      } catch {
        return null
      }
    },
    async save(state: TimeSyncState): Promise<void> {
      await adapter.set(TIME_SYNC_STATE_KEY, JSON.stringify(state))
    },
  }
}
