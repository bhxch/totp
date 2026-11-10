import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import {
  CLOCK_JUMP_BACKWARD_MS, CLOCK_JUMP_FORWARD_MS, COLD_START_TTL_MS, EMPTY_TIME_SYNC_STATE,
  TIME_SYNC_STATE_KEY, TIME_SYNC_TTL_MS, computeOffsetMs, createAdapterTimeSyncIo,
  clockJumpKind, normalizeTimeSyncState, shouldAutoCalibrate, HTTPS_TIME_SOURCE_IDS, NTP_TIME_SOURCE_IDS,
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
  it('HTTPS 七源顺序固定', () => {
    expect([...HTTPS_TIME_SOURCE_IDS]).toEqual(['taobao-api', 'suning-api', 'baidu', 'qq', 'gitee', 'jd', 'cloudflare-trace'])
  })
  it('NTP 七源顺序固定', () => {
    expect([...NTP_TIME_SOURCE_IDS]).toEqual(['aliyun', 'tencent', 'tencent-time1', 'neu', 'cn-pool', 'tuna', 'windows'])
  })
})
