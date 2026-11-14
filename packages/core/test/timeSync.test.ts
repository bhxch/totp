import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import {
  CLOCK_JUMP_BACKWARD_MS, CLOCK_JUMP_FORWARD_MS, COLD_START_TTL_MS, EMPTY_TIME_SYNC_STATE,
  TIME_SYNC_STATE_KEY, TIME_SYNC_TTL_MS, computeOffsetMs, createAdapterTimeSyncIo,
  clockJumpKind, normalizeTimeSyncState, shouldAutoCalibrate,
  HTTPS_TIME_SOURCE_IDS_CN, HTTPS_TIME_SOURCE_IDS_GLOBAL, NTP_TIME_SOURCE_IDS_CN, NTP_TIME_SOURCE_IDS_GLOBAL,
  httpsTimeSourceIds, ntpTimeSourceIds, normalizeTimeSourceProfile,
  HTTPS_TRUSTED_RTT_MS, isTrustedHttpRtt,
} from '../src/time/timeSync'

const OK: ReturnType<typeof normalizeTimeSyncState> = { ...EMPTY_TIME_SYNC_STATE, offsetMs: 1000, syncedAt: 10_000, sourceId: 'baidu' }

describe('shouldAutoCalibrate（plan24 §3）', () => {
  it('device 模式恒 false', () => {
    expect(shouldAutoCalibrate(null as never, false, 0)).toBe(false) // networkMode 短路在前，state 不参与
    expect(shouldAutoCalibrate(OK, false, 0)).toBe(false)
  })
  it('network 模式：无状态/从未成功且从未尝试 → true', () => {
    expect(shouldAutoCalibrate(EMPTY_TIME_SYNC_STATE, true, 0)).toBe(true)
  })
  it('network 模式：从未成功且退避期内 → false；超 TTL → true', () => {
    const failed = { ...EMPTY_TIME_SYNC_STATE, lastAttemptAt: 1000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(failed, true, 1000 + TIME_SYNC_TTL_MS - 1)).toBe(false)
    expect(shouldAutoCalibrate(failed, true, 1000 + TIME_SYNC_TTL_MS)).toBe(true)
  })
  it('network 模式：已成功按 syncedAt 距离判 TTL；syncedAt 缺失（病态归一）按需重校', () => {
    expect(shouldAutoCalibrate({ ...OK, syncedAt: 1000 }, true, 1000 + TIME_SYNC_TTL_MS - 1)).toBe(false)
    expect(shouldAutoCalibrate({ ...OK, syncedAt: 1000 }, true, 1000 + TIME_SYNC_TTL_MS)).toBe(true)
    expect(shouldAutoCalibrate({ ...OK, syncedAt: null }, true, 0)).toBe(true)
  })
  it('自定义 ttlMs（冷启动收紧 R13）：syncedAt 判据按传入 ttlMs 生效', () => {
    const synced = 10_000
    expect(shouldAutoCalibrate({ ...OK, syncedAt: synced }, true, synced + COLD_START_TTL_MS, COLD_START_TTL_MS)).toBe(true)
    expect(shouldAutoCalibrate({ ...OK, syncedAt: synced }, true, synced + COLD_START_TTL_MS - 1, COLD_START_TTL_MS)).toBe(false)
  })
  it('自定义 ttlMs（冷启动收紧 R13）：退避分支同样按 ttlMs 生效', () => {
    const failed = { ...EMPTY_TIME_SYNC_STATE, lastAttemptAt: 1000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(failed, true, 1000 + COLD_START_TTL_MS - 1, COLD_START_TTL_MS)).toBe(false)
    expect(shouldAutoCalibrate(failed, true, 1000 + COLD_START_TTL_MS, COLD_START_TTL_MS)).toBe(true)
  })
  it('回拨判陈旧（R13b）：deviceNow 早于 syncedAt 恒触发重校（默认 ttl）', () => {
    // syncedAt 是校准时刻的设备钟读数，钟单调前进时 now ≥ syncedAt 恒成立；
    // now < syncedAt ⟹ 钟被回拨 ⟹ 旧 offset 失效（负差值下 >= ttl 比较失真，须单独守卫）
    expect(shouldAutoCalibrate({ ...OK, syncedAt: 10_000 }, true, 10_000 - 3_600_000)).toBe(true) // 回拨 1h
    expect(shouldAutoCalibrate({ ...OK, syncedAt: 10_000 }, true, 10_000 - 1)).toBe(true) // 差 1ms 也算回拨
    expect(shouldAutoCalibrate({ ...OK, syncedAt: 10_000 }, true, 10_000)).toBe(false) // 零差值=刚校准，不判（防自触发成环）
  })
  it('回拨判陈旧（R13b）：退避分支同型——lastAttemptAt 在未来恒触发重试', () => {
    // 退避期以「距上次尝试的时长」为前提；now < lastAttemptAt 时该前提失效，不再按退避压制
    const failed = { ...EMPTY_TIME_SYNC_STATE, lastAttemptAt: 10_000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(failed, true, 10_000 - 3_600_000)).toBe(true) // 回拨 1h
    expect(shouldAutoCalibrate(failed, true, 10_000)).toBe(false) // 零差值仍在退避期内
  })
  it('超龄分支受退避约束（R15-a）：已成功+超龄+上次尝试失败且退避期内 → false', () => {
    // 修复前该分支只看 syncedAt 年龄：「已成功+超龄+校准失败」时每个 tick 都重试，
    // 离线用户形成秒级失败风暴（Task 2 实证，违反 spec §3-⑤）
    const now = 1_000_000_000
    const st = { ...OK, syncedAt: now - 7 * 3_600_000, lastAttemptAt: now - 3_600_000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(st, true, now)).toBe(false) // 超龄但距上次失败仅 1h < 6h：期满再试一次
  })
  it('超龄分支退避期满重试（R15-b）', () => {
    const now = 1_000_000_000
    const st = { ...OK, syncedAt: now - 7 * 3_600_000, lastAttemptAt: now - 7 * 3_600_000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(st, true, now)).toBe(true) // 距上次失败尝试已满 ttl：再试一次
  })
  it('超龄分支回拨组合（R15-c）：退避参照在未来 → 跳过退避判据', () => {
    // lastAttemptAt 在未来 ⟹ 钟被回拨，退避期前提失效，与 R13b 同口径
    const now = 1_000_000_000
    const st = { ...OK, syncedAt: now - 7 * 3_600_000, lastAttemptAt: now + 3_600_000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(st, true, now)).toBe(true)
  })
  it('未超龄不受退避影响（R15-d 回归锚）：有新鲜 offset 时不重校', () => {
    const now = 1_000_000_000
    const st = { ...OK, syncedAt: now - 3_600_000, lastAttemptAt: now - 1_800_000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(st, true, now)).toBe(false) // offset 未超龄：出码继续用旧 offset
  })
  it('回拨+失败组合退避（R17-a）：回拨后已失败一次且退避期内 → false', () => {
    // R13b 的「负差恒判陈旧」在连续失败场景退化为每 tick 风暴：失败会把 lastAttemptAt 写为
    // 回拨后的钟读数，故 since ∈ [0, ttlMs) 表示「回拨后已试过一次并失败」，须退避
    const now = 1_000_000_000
    const st = { ...OK, syncedAt: now + 3_600_000, lastAttemptAt: now - 5 * 60_000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(st, true, now)).toBe(false) // syncedAt 在未来 1h，距上次失败 5min < ttl
  })
  it('回拨后未尝试（R17-b）：lastAttemptAt 也在未来（since<0）→ 首次判定照常重校', () => {
    // lastAttemptAt 是回拨前写下的（也在未来）：退避期前提失效，不压制首次判定
    const now = 1_000_000_000
    const st = { ...OK, syncedAt: now + 3_600_000, lastAttemptAt: now + 1_800_000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(st, true, now)).toBe(true)
  })
  it('回拨后退避期满（R17-c）：lastAttemptAt = 当前钟面−7h → 重校', () => {
    const now = 1_000_000_000
    const st = { ...OK, syncedAt: now + 3_600_000, lastAttemptAt: now - 7 * 3_600_000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(st, true, now)).toBe(true) // 距上次失败已满 ttl：再试一次
  })
})

// 复审 Major-1/2（裁定 R18，方案 B）：回拨见证判陈旧——「上次尝试失败且 lastAttemptAt 早于
// syncedAt」是持久的回拨见证，与 age<0、超龄同权判需重校并共用同一退避判据；首试失败后的
// 恢复延迟由此从 e′+ttl 收敛到恰 ttl。S1–S7 断言组与 task-1-rereview.md §Major-1 一致
// （S7 期望值按裁定改为 true），另补两类受影响格的保护断言。
describe('shouldAutoCalibrate R18 语义（回拨见证判陈旧 + 退避共用）', () => {
  const now = 1_000_000_000, H = 3_600_000
  /** 回拨态：成功校准后钟被回拨、且回拨后已失败过一次（lastAttemptAt 在过去、syncedAt 在未来 1h → 见证成立）；since 相对当前钟面 */
  const back = (since: number) => ({ ...OK, syncedAt: now + H, lastAttemptAt: now - since, lastAttemptFailed: true })
  /** 超龄态：syncedAt 在过去 age 处；since 相对当前钟面 */
  const aged = (since: number, age = 7 * H) => ({ ...OK, syncedAt: now - age, lastAttemptAt: now - since, lastAttemptFailed: true })

  it('S1/S2 显式 COLD_START_TTL_MS：回拨臂与超龄臂的退避窗都按传入 ttl 生效', () => {
    expect(shouldAutoCalibrate(back(COLD_START_TTL_MS - 1), true, now, COLD_START_TTL_MS)).toBe(false)
    expect(shouldAutoCalibrate(back(COLD_START_TTL_MS), true, now, COLD_START_TTL_MS)).toBe(true)
    expect(shouldAutoCalibrate(back(COLD_START_TTL_MS), true, now)).toBe(false) // 对照：默认 6h 下 10min 仍在退避期
    expect(shouldAutoCalibrate(aged(COLD_START_TTL_MS - 1), true, now, COLD_START_TTL_MS)).toBe(false)
    expect(shouldAutoCalibrate(aged(COLD_START_TTL_MS), true, now, COLD_START_TTL_MS)).toBe(true)
    expect(shouldAutoCalibrate(aged(COLD_START_TTL_MS), true, now)).toBe(false) // 对照：默认 6h 判据下虽已超龄（age=7h），但距上次失败 10min 仍在退避期内
  })
  it('S3/S4 精确边界 0 / ttl−1 / ttl（默认 6h）：回拨臂与超龄臂对称', () => {
    for (const st of [back, (s: number) => aged(s, 13 * H)] as const) {
      expect(shouldAutoCalibrate(st(0), true, now)).toBe(false) // since=0：退避期内
      expect(shouldAutoCalibrate(st(TIME_SYNC_TTL_MS - 1), true, now)).toBe(false) // ttl−1
      expect(shouldAutoCalibrate(st(TIME_SYNC_TTL_MS), true, now)).toBe(true) // =ttl：退避期满
    }
  })
  it('S5 生产形态回拨态：成功写入 syncedAt=lastAttemptAt（failed=false）→ 恒判陈旧', () => {
    // 唯一真实写入方每次成功写同一读数：回拨后 failed=false 是生产常态，不得因无失败记录而漏判
    const rolled = { ...OK, syncedAt: now + H, lastAttemptAt: now + H, lastAttemptFailed: false }
    expect(shouldAutoCalibrate(rolled, true, now)).toBe(true)
    expect(shouldAutoCalibrate(rolled, true, now, COLD_START_TTL_MS)).toBe(true)
  })
  it('S6 超龄退避须 lastAttemptFailed：上次尝试成功（failed=false）不退避', () => {
    expect(shouldAutoCalibrate({ ...aged(H), lastAttemptFailed: false }, true, now)).toBe(true)
  })
  it('S7 回拨态 failed=false：age<0 只看负差见证，恒判陈旧（R18 对称化）', () => {
    expect(shouldAutoCalibrate({ ...back(5 * 60_000), lastAttemptFailed: false }, true, now)).toBe(true)
  })
  it('R18 第三类格：0≤age<ttl 且有回拨见证且退避期满 → true（恢复延迟收敛至 ttl）', () => {
    // 场景：成功校准（syncedAt=−1h）后钟被回拨 e′；回拨之后那次失败尝试（6h 前）早于 syncedAt → 持久见证
    // （写入方契约：成功之前的失败已被成功覆写，不构成见证）；since=6h 已满 ttl → 立即重校
    // （修复前该格为 false，错误偏移要多用 e′+ttl）
    const st = { ...OK, syncedAt: now - H, lastAttemptAt: now - 6 * H, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(st, true, now)).toBe(true) // 见证：lastAttemptAt(−6h) < syncedAt(−1h)，since=6h ≥ ttl
    expect(shouldAutoCalibrate(st, true, now, COLD_START_TTL_MS)).toBe(true) // since=6h ≥ 10min 同样期满
  })
  it('R18-Minor2：病态格（offset≠null 且 syncedAt=null）受同一退避约束', () => {
    const sick = { ...OK, syncedAt: null, lastAttemptAt: now - 5 * 60_000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(sick, true, now)).toBe(false) // 退避期内不再每 tick 重试
    expect(shouldAutoCalibrate({ ...sick, lastAttemptAt: now - COLD_START_TTL_MS }, true, now, COLD_START_TTL_MS)).toBe(true) // 期满重试
  })
  it('R18-见证须失败：failed=false 时见证不成立 → 按年龄判定（防御性：写入方契约下此形态不可达）', () => {
    // 写入方契约：成功会把 lastAttemptAt 覆写为 syncedAt 并清失败标记，故「lastAttemptAt<syncedAt
    // 且 failed=false」不会由真实写入方产生；此断言是防御性的——防实现把见证误用在 failed=false 上
    const st = { ...OK, syncedAt: now - H, lastAttemptAt: now - 2 * H, lastAttemptFailed: false }
    expect(shouldAutoCalibrate(st, true, now)).toBe(false) // age=1h 未超龄；见证因 failed=false 不成立
  })
})

describe('shouldAutoCalibrate 无偏移路径（R18-Major-1 回归钉）', () => {
  const now = 1_000_000_000
  // 无偏移（offsetMs=null）即需校准：残留的 syncedAt 不得让它被当作「未超龄」而抑制首启
  const noOffset = { ...EMPTY_TIME_SYNC_STATE, syncedAt: now - 5 * 60_000 }
  it('无偏移即需校准：残留 syncedAt 不抑制首启（默认 6h 与冷启动 10min 判据下均立即重校）', () => {
    expect(shouldAutoCalibrate(noOffset, true, now)).toBe(true)
    expect(shouldAutoCalibrate(noOffset, true, now, COLD_START_TTL_MS)).toBe(true)
  })
  it('null 分支三态：从未尝试 → true；退避期内 → false；退避期满 → true', () => {
    expect(shouldAutoCalibrate({ ...EMPTY_TIME_SYNC_STATE }, true, now)).toBe(true) // lastAttemptAt=null：从未尝试
    expect(shouldAutoCalibrate({ ...noOffset, lastAttemptAt: now - 60_000, lastAttemptFailed: true }, true, now)).toBe(false) // since=1min ∈ [0, ttl)
    expect(shouldAutoCalibrate({ ...noOffset, lastAttemptAt: now - 7 * 3_600_000, lastAttemptFailed: true }, true, now)).toBe(true) // since=7h ≥ ttl
  })
})

// 裁定修订：wallDelta=正常间隔+跳变幅度，双墙钟采样不可分，故前跳不做间隔条件（无 maxGap 参数）；
// 休眠恢复的长前跳会多触发一次校准（无害），漏判外部拉准则 offset 持续错误——宁误判不漏判
describe('clockJumpKind（跳变检测；裁定修订：无间隔条件）', () => {
  it('回退 ≥5s 判 backward；小幅回退不判', () => {
    expect(clockJumpKind(1_000_000, 1_000_000 - 10_000)).toBe('backward') // 回退 10s：系统时间被改
    expect(clockJumpKind(1_000_000, 1_000_000 - 4000)).toBe('none') // 回退 4s：低于 5s 阈值
    // 阈值边界（brief 原用例保留，不涉及 maxGap）：恰 5s 判、差 1ms 不判
    expect(clockJumpKind(10_000, 10_000 - CLOCK_JUMP_BACKWARD_MS)).toBe('backward')
    expect(clockJumpKind(10_000, 10_000 - CLOCK_JUMP_BACKWARD_MS + 1)).toBe('none')
  })
  it('前跳 ≥60s 判 forward（被外部拉准）；<60s 不判（TTL 兜底）', () => {
    expect(clockJumpKind(0, CLOCK_JUMP_FORWARD_MS)).toBe('forward') // 恰 60_000ms
    expect(clockJumpKind(0, CLOCK_JUMP_FORWARD_MS - 1)).toBe('none') // 59_999ms
  })
  it('正常 tick（+1s）不判', () => {
    expect(clockJumpKind(0, 1000)).toBe('none')
  })
})

describe('computeOffsetMs（Review Focus 2）', () => {
  it('中点公式：offset = server - (t0+t1)/2', () => {
    expect(computeOffsetMs(100_000, 1000, 2000)).toBe(98_500) // 100000-1500
    expect(computeOffsetMs(100_000, 1000, 3000)).toBe(98_000)
  })
  it('非整除中点按 Math.round', () => expect(computeOffsetMs(100_001, 1000, 2001)).toBe(98_501))
})

describe('normalizeTimeSyncState', () => {
  it('非对象/坏字段逐位回默认', () => {
    expect(normalizeTimeSyncState(null)).toEqual(EMPTY_TIME_SYNC_STATE)
    expect(normalizeTimeSyncState('x')).toEqual(EMPTY_TIME_SYNC_STATE)
    expect(normalizeTimeSyncState({ offsetMs: 'x', sourceId: 1, lastAttemptFailed: 'yes', preferredSourceId: 'qq' }))
      .toEqual({ ...EMPTY_TIME_SYNC_STATE, preferredSourceId: 'qq' })
    expect(normalizeTimeSyncState({ offsetMs: NaN })).toEqual(EMPTY_TIME_SYNC_STATE) // 非有限数拒绝
  })
  it('合法字段透传', () => {
    expect(normalizeTimeSyncState({ ...OK, lastAttemptAt: 9, lastAttemptFailed: true })).toEqual({ ...OK, lastAttemptAt: 9, lastAttemptFailed: true })
  })
})

describe('createAdapterTimeSyncIo', () => {
  it('load：缺失→null；坏 JSON→null；合法→归一化', async () => {
    const s = createMemoryStorage()
    const io = createAdapterTimeSyncIo(s)
    expect(await io.load()).toBeNull()
    await s.set(TIME_SYNC_STATE_KEY, '{oops')
    expect(await io.load()).toBeNull()
    await s.set(TIME_SYNC_STATE_KEY, JSON.stringify(OK))
    expect(await io.load()).toEqual(OK)
  })
  it('save/load 往返', async () => {
    const s = createMemoryStorage()
    const io = createAdapterTimeSyncIo(s)
    await io.save(OK)
    expect(await io.load()).toEqual(OK)
  })
})

describe('源 id 清单（spec §2，实测序）', () => {
  it('HTTPS 大陆链顺序固定', () => {
    expect([...HTTPS_TIME_SOURCE_IDS_CN]).toEqual(['taobao-api', 'suning-api', 'baidu', 'qq', 'gitee', 'jd', 'cloudflare-trace'])
  })
  it('NTP 大陆链顺序固定', () => {
    expect([...NTP_TIME_SOURCE_IDS_CN]).toEqual(['aliyun', 'tencent', 'tencent-time1', 'neu', 'cn-pool', 'tuna', 'windows'])
  })
  it('HTTPS 国际链顺序固定', () => {
    expect([...HTTPS_TIME_SOURCE_IDS_GLOBAL]).toEqual(['timeapi', 'cloudflare-trace', 'cloudflare-204', 'microsoft'])
  })
  it('NTP 国际链顺序固定', () => {
    expect([...NTP_TIME_SOURCE_IDS_GLOBAL]).toEqual([
      'time-cloudflare', 'pool', 'time-nist', 'time-apple', 'nict', 'europe-pool', 'asia-pool', 'ubuntu',
    ])
  })
  it('两链 id 交集仅 cloudflare-trace（同 id 同语义：同 URL 同解析形态）', () => {
    const cn = new Set<string>([...HTTPS_TIME_SOURCE_IDS_CN, ...NTP_TIME_SOURCE_IDS_CN])
    const shared = [...HTTPS_TIME_SOURCE_IDS_GLOBAL, ...NTP_TIME_SOURCE_IDS_GLOBAL].filter((id) => cn.has(id))
    expect(shared).toEqual(['cloudflare-trace'])
  })
})

describe('HTTPS 源 RTT 护栏（2026-11-13 实测：慢应答的 timestamp 偏置可达秒级）', () => {
  it('isTrustedHttpRtt：≤800ms 采信；超限/负值/非有限值拒绝', () => {
    expect(isTrustedHttpRtt(0)).toBe(true)
    expect(isTrustedHttpRtt(197)).toBe(true)
    expect(isTrustedHttpRtt(HTTPS_TRUSTED_RTT_MS)).toBe(true)
    expect(isTrustedHttpRtt(HTTPS_TRUSTED_RTT_MS + 1)).toBe(false)
    expect(isTrustedHttpRtt(8_100)).toBe(false)
    expect(isTrustedHttpRtt(-1)).toBe(false)
    expect(isTrustedHttpRtt(Number.NaN)).toBe(false)
    expect(isTrustedHttpRtt(Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('源链剖面（2026-11-13 全球链）', () => {  it('normalizeTimeSourceProfile：仅 global 归国际链，其余（含非法值）回大陆链', () => {
    expect(normalizeTimeSourceProfile('global')).toBe('global')
    expect(normalizeTimeSourceProfile('cn')).toBe('cn')
    expect(normalizeTimeSourceProfile(undefined)).toBe('cn')
    expect(normalizeTimeSourceProfile('GLOBAL')).toBe('cn')
    expect(normalizeTimeSourceProfile(42)).toBe('cn')
  })
  it('httpsTimeSourceIds/ntpTimeSourceIds 按剖面取对应链', () => {
    expect(httpsTimeSourceIds('cn')).toEqual(HTTPS_TIME_SOURCE_IDS_CN)
    expect(httpsTimeSourceIds('global')).toEqual(HTTPS_TIME_SOURCE_IDS_GLOBAL)
    expect(ntpTimeSourceIds('cn')).toEqual(NTP_TIME_SOURCE_IDS_CN)
    expect(ntpTimeSourceIds('global')).toEqual(NTP_TIME_SOURCE_IDS_GLOBAL)
  })
})
