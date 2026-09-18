import { describe, expect, it } from 'vitest'
import { lockPrefsUnsupportedKeys } from './lockPrefs'

describe('lockPrefsUnsupportedKeys（审查 I10：desktop 锁定触发器显式降级）', () => {
  it('Windows UA → 仅 lockOnRestart 不支持（系统锁屏有 WTS 事件源，开关有效）', () => {
    expect(lockPrefsUnsupportedKeys('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0')).toEqual(['lockOnRestart'])
  })

  it('macOS UA → lockOnRestart + lockOnSystemLock（Rust lock_events 非 Windows no-op）', () => {
    expect(lockPrefsUnsupportedKeys('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15')).toEqual(['lockOnRestart', 'lockOnSystemLock'])
  })

  it('Linux UA → 同 macOS 两项降级', () => {
    expect(lockPrefsUnsupportedKeys('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36')).toEqual(['lockOnRestart', 'lockOnSystemLock'])
  })
})
