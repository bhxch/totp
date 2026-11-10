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
  /** 上次成功校准时刻（设备时钟 ms）；offsetMs 非 null 时有效 */
  syncedAt: number | null
  /** 上次成功校准的来源 id（HTTPS/NTP 源清单内） */
  sourceId: string | null
  /** 上次尝试时刻（设备时钟 ms，成败均记；自动重试退避依据） */
  lastAttemptAt: number | null
  /** 上次尝试失败标记：TTL 内不自动重试，手动「立即同步」不受限 */
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

/** 自动校准决策（纯函数）：network 模式下，回拨见证 / 负差（回拨）/ TTL 超龄 / 病态归一判陈旧
 *  （需重校），且全部陈旧分类共用同一退避判据——上次尝试失败且 now−lastAttemptAt ∈ [0, ttlMs)
 *  时退避（裁定 R15/R17/R18，spec §3-⑤）。ttlMs 默认 TIME_SYNC_TTL_MS（6h，既有运行期语义不变），
 *  冷启动入口传 COLD_START_TTL_MS 收紧（裁定 R13）。手动校准（立即同步）不走此函数，恒允许。
 *  回拨见证（裁定 R18，方案 B）：lastAttemptFailed 且 lastAttemptAt < syncedAt ⟹ 失败发生在
 *  syncedAt（=成功校准的钟读数）之前 ⟹ 钟在校准后被回拨，旧 offset 与退避期前提双双失效——
 *  与 age<0（回拨的负差见证，R13b）、age ≥ ttlMs（超龄，R15）同权判陈旧。R17 的「负差恒判
 *  陈旧」只闭合无界段，首试失败后的恢复延迟实测为 e′+ttlMs（e′=回拨量被追平前的负差时长，
 *  默认 tick 路径趋近 2×ttl）；按见证判陈旧后恢复延迟恰为 ttlMs。零差值不算回拨；
 *  病态格（offset≠null 且 syncedAt=null）R18 起同样受退避约束（修复前为每 tick 风暴）。 */
export function shouldAutoCalibrate(state: TimeSyncState, networkMode: boolean, deviceNowMs: number, ttlMs: number = TIME_SYNC_TTL_MS): boolean {
  if (!networkMode) return false
  const backoff = state.lastAttemptFailed && state.lastAttemptAt !== null
    && deviceNowMs - state.lastAttemptAt >= 0 && deviceNowMs - state.lastAttemptAt < ttlMs
  if (state.syncedAt === null) return !backoff // 病态归一（有偏移无时刻）：按需重校，R18 起受退避约束
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

/** HTTPS 时间源 id（扩展端；顺序=内置优先级，2026-11-10 家庭宽带实测）：
 *  毫秒 API 在前（动态生成免疫 CDN 缓存，淘宝 HEAD Date 滞后 43s 已剔除该形态） */
export const HTTPS_TIME_SOURCE_IDS = ['taobao-api', 'suning-api', 'baidu', 'qq', 'gitee', 'jd', 'cloudflare-trace'] as const
export type HttpsTimeSourceId = (typeof HTTPS_TIME_SOURCE_IDS)[number]
/** SNTP 源 id（桌面端；顺序=内置优先级；preferred 用户置顶仍全池兜底） */
export const NTP_TIME_SOURCE_IDS = ['aliyun', 'tencent', 'tencent-time1', 'neu', 'cn-pool', 'tuna', 'windows'] as const
export type NtpTimeSourceId = (typeof NTP_TIME_SOURCE_IDS)[number]

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
