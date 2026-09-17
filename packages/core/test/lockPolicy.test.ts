import { describe, expect, it } from 'vitest'
import { shouldLockNow } from '../src/security/lockPolicy'

const NOW = 1_000_000_000

describe('锁定判定 shouldLockNow（设计 §1 锁定策略）', () => {
  it('空闲超时：now-last >= N 分钟触发', () => {
    expect(shouldLockNow({ idleMinutes: 5, lastActivityAt: NOW - 5 * 60_000, now: NOW })).toBe(true)
    expect(shouldLockNow({ idleMinutes: 5, lastActivityAt: NOW - 4 * 60_000, now: NOW })).toBe(false)
  })
  it('恰好等于阈值触发（>= 语义，边界含）', () => {
    expect(shouldLockNow({ idleMinutes: 1, lastActivityAt: NOW - 60_000, now: NOW })).toBe(true)
    expect(shouldLockNow({ idleMinutes: 1, lastActivityAt: NOW - 60_001, now: NOW })).toBe(true)
    expect(shouldLockNow({ idleMinutes: 1, lastActivityAt: NOW - 59_999, now: NOW })).toBe(false)
  })
  it('idleMinutes=0 恒不触发（禁用）', () => {
    expect(shouldLockNow({ idleMinutes: 0, lastActivityAt: 0, now: NOW })).toBe(false)
  })
  it('负数/非整数钳为禁用', () => {
    expect(shouldLockNow({ idleMinutes: -1, lastActivityAt: 0, now: NOW })).toBe(false)
    expect(shouldLockNow({ idleMinutes: 2.5, lastActivityAt: 0, now: NOW })).toBe(false)
  })
  it('lastActivityAt 晚于 now（时钟回拨）不触发', () => {
    expect(shouldLockNow({ idleMinutes: 5, lastActivityAt: NOW + 60_000, now: NOW })).toBe(false)
  })
})
