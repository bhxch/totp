/**
 * desktopPrefs 直测（P4，盘点 B1.3/B3.12/B4.17 装配层缺口）：localStorage 偏好/状态纯函数——
 * loadBackupPrefs ≥15min 钳制边界与坏数据兜底、legacyRetention 旧键迁移读取口径、云偏好同口径、
 * 自动状态三态写入与卡片文本格式化往返、基线键读写删。jsdom 提供 localStorage。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKUP_AUTO_STATUS_KEY, BACKUP_KEEP_N_KEY, BACKUP_MODE_KEY, CLOUD_AUTO_STATUS_KEY, CLOUD_CONTENT_HASH_KEY,
  LAST_BACKUP_HASH_KEY, legacyRetention, loadBackupPrefs, loadCloudPrefs, persistBackupPrefs, readAutoStatusText,
  readCloudContentHash, readLastBackupHash, recordAutoStatus, writeCloudContentHash, writeLastBackupHash,
} from '../src/desktopPrefs'

beforeEach(() => {
  localStorage.clear()
})

describe('loadBackupPrefs（backupAutoPrefs 键，≥15min 钳制）', () => {
  it('键缺失 → 全默认（不开启、间隔 60）', () => {
    expect(loadBackupPrefs()).toEqual({ onChange: false, onInterval: false, intervalMinutes: 60 })
  })

  it('坏 JSON → 全默认不抛错', () => {
    localStorage.setItem('backupAutoPrefs', '{broken')
    expect(loadBackupPrefs()).toEqual({ onChange: false, onInterval: false, intervalMinutes: 60 })
  })

  it('钳制边界：15 保底生效、14/0/负数/非整数/非数字回落 60、90 如实保留', () => {
    for (const [raw, expectMinutes] of [
      ['15', 15], ['90', 90], ['30', 30],
      ['14', 60], ['0', 60], ['-5', 60], ['14.5', 60], ['"abc"', 60], ['null', 60],
    ] as Array<[string, number]>) {
      localStorage.setItem('backupAutoPrefs', JSON.stringify({ onChange: true, onInterval: true, intervalMinutes: JSON.parse(raw) }))
      expect(loadBackupPrefs().intervalMinutes).toBe(expectMinutes)
    }
  })

  it('布尔字段严格 === true 判定：字符串 "true"/1 不算开启', () => {
    localStorage.setItem('backupAutoPrefs', JSON.stringify({ onChange: 'true', onInterval: 1, intervalMinutes: 30 }))
    expect(loadBackupPrefs()).toEqual({ onChange: false, onInterval: false, intervalMinutes: 30 })
  })

  it('persistBackupPrefs 往返；读侧与 BackupCard（platform.getAutoPrefs）共享同一实现', () => {
    persistBackupPrefs({ onChange: true, onInterval: true, intervalMinutes: 45 })
    expect(loadBackupPrefs()).toEqual({ onChange: true, onInterval: true, intervalMinutes: 45 })
  })
})

describe('legacyRetention（旧 backupMode/backupKeepN 迁移读取）', () => {
  it('两键缺失 → keep 3（与旧 loadBackupMode 缺省同口径）', () => {
    expect(legacyRetention()).toEqual({ type: 'keep', n: 3 })
  })

  it('backupMode=overwrite → overwrite（优先于 keepN）', () => {
    localStorage.setItem(BACKUP_MODE_KEY, 'overwrite')
    localStorage.setItem(BACKUP_KEEP_N_KEY, '9')
    expect(legacyRetention()).toEqual({ type: 'overwrite' })
  })

  it('keep：n 合法如实保留；0/负数/非整数/非数字回退 3', () => {
    localStorage.setItem(BACKUP_KEEP_N_KEY, '5')
    expect(legacyRetention()).toEqual({ type: 'keep', n: 5 })
    for (const bad of ['0', '-1', '2.5', 'abc', '']) {
      localStorage.setItem(BACKUP_KEEP_N_KEY, bad)
      expect(legacyRetention()).toEqual({ type: 'keep', n: 3 })
    }
  })

  it('keep n 以字符串存储同样按 Number 解析（「7」→ 7）', () => {
    localStorage.setItem(BACKUP_KEEP_N_KEY, '7')
    expect(legacyRetention()).toEqual({ type: 'keep', n: 7 })
  })
})

describe('loadCloudPrefs（cloudAutoPrefs 键，与 backup 偏好独立实现同口径）', () => {
  it('键缺失/坏 JSON → 全默认', () => {
    expect(loadCloudPrefs()).toEqual({ onChange: false, onInterval: false, intervalMinutes: 60 })
    localStorage.setItem('cloudAutoPrefs', 'not-json')
    expect(loadCloudPrefs()).toEqual({ onChange: false, onInterval: false, intervalMinutes: 60 })
  })

  it('同口径 ≥15min 钳制；与 backupAutoPrefs 键互不串扰', () => {
    localStorage.setItem('cloudAutoPrefs', JSON.stringify({ onChange: true, onInterval: true, intervalMinutes: 20 }))
    localStorage.setItem('backupAutoPrefs', JSON.stringify({ onChange: true, onInterval: true, intervalMinutes: 90 }))
    expect(loadCloudPrefs()).toEqual({ onChange: true, onInterval: true, intervalMinutes: 20 })
    expect(loadBackupPrefs().intervalMinutes).toBe(90)
    localStorage.setItem('cloudAutoPrefs', JSON.stringify({ intervalMinutes: 3 }))
    expect(loadCloudPrefs().intervalMinutes).toBe(60)
  })
})

describe('自动状态键（recordAutoStatus/readAutoStatusText 三态）', () => {
  it('三态写入 → 卡片文本含 成功/失败/跳过 标签与 summary（formatAutoStatusText 委托往返）', () => {
    recordAutoStatus(BACKUP_AUTO_STATUS_KEY, true, '已备份到 2 个目录')
    expect(readAutoStatusText(BACKUP_AUTO_STATUS_KEY)).toContain('成功：已备份到 2 个目录')
    recordAutoStatus(BACKUP_AUTO_STATUS_KEY, false, '备份失败：U 盘')
    expect(readAutoStatusText(BACKUP_AUTO_STATUS_KEY)).toContain('失败：备份失败：U 盘')
    recordAutoStatus(CLOUD_AUTO_STATUS_KEY, null, '库已锁定')
    expect(readAutoStatusText(CLOUD_AUTO_STATUS_KEY)).toContain('跳过：库已锁定')
  })

  it('写入载荷形状 {at, ok, summary}（at=毫秒数）', () => {
    const before = Date.now()
    recordAutoStatus(BACKUP_AUTO_STATUS_KEY, true, 'x')
    const parsed = JSON.parse(localStorage.getItem(BACKUP_AUTO_STATUS_KEY)!) as { at: number; ok: boolean; summary: string }
    expect(parsed.ok).toBe(true)
    expect(parsed.summary).toBe('x')
    expect(parsed.at).toBeGreaterThanOrEqual(before)
  })

  it('键缺失/坏 JSON/缺字段 → null（卡片显示「暂无」）', () => {
    expect(readAutoStatusText(BACKUP_AUTO_STATUS_KEY)).toBeNull()
    localStorage.setItem(CLOUD_AUTO_STATUS_KEY, 'nope')
    expect(readAutoStatusText(CLOUD_AUTO_STATUS_KEY)).toBeNull()
    localStorage.setItem(CLOUD_AUTO_STATUS_KEY, JSON.stringify({ at: 1 }))
    expect(readAutoStatusText(CLOUD_AUTO_STATUS_KEY)).toBeNull()
  })
})

describe('自动通道基线键', () => {
  it('lastBackupHash 读/写（缺失 null）', () => {
    expect(readLastBackupHash()).toBeNull()
    writeLastBackupHash('abc123')
    expect(readLastBackupHash()).toBe('abc123')
    expect(localStorage.getItem(LAST_BACKUP_HASH_KEY)).toBe('abc123')
  })

  it('cloudContentHash 读/写/null=删键（跨会话内容门基线）', () => {
    expect(readCloudContentHash()).toBeNull()
    writeCloudContentHash('h1')
    expect(localStorage.getItem(CLOUD_CONTENT_HASH_KEY)).toBe('h1')
    writeCloudContentHash(null)
    expect(localStorage.getItem(CLOUD_CONTENT_HASH_KEY)).toBeNull()
    expect(readCloudContentHash()).toBeNull()
  })
})

describe('localStorage 不可用兜底（宿主读抛错路径）', () => {
  it('getItem 抛 → legacyRetention/readAutoStatusText 兜底默认值不抛', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(legacyRetention()).toEqual({ type: 'keep', n: 3 })
    expect(readAutoStatusText(BACKUP_AUTO_STATUS_KEY)).toBeNull()
    spy.mockRestore()
  })

  it('setItem 抛 → 各 persist/record 写路径静默不影响主流程', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => persistBackupPrefs({ onChange: true, onInterval: false, intervalMinutes: 30 })).not.toThrow()
    expect(() => recordAutoStatus(BACKUP_AUTO_STATUS_KEY, true, 'x')).not.toThrow()
    expect(() => writeLastBackupHash('h')).not.toThrow()
    expect(() => writeCloudContentHash('h')).not.toThrow()
    spy.mockRestore()
  })
})
