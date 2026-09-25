import { describe, expect, it } from 'vitest'
import { backupFileName, conflictBackupFileName, OVERWRITE_NAME, READABLE_BACKUP_RE, selectBackupsToKeep } from '../src/backup/policy'

describe('backupFileName', () => {
  it('本地时区格式', () => {
    const d = new Date(2026, 8, 13, 15, 4, 5) // 2026-09-13 15:04:05 本地
    expect(backupFileName(d)).toBe('vault-20260913-150405.totpbackup')
  })
})

describe('conflictBackupFileName', () => {
  it('conflict 前缀时间戳名', () => {
    const d = new Date(2026, 8, 13, 15, 4, 5)
    expect(conflictBackupFileName(d)).toBe('conflict-20260913-150405.totpbackup')
  })
})

describe('READABLE_BACKUP_RE', () => {
  it('时间戳名与 overwrite 名均可读，非法名拒绝', () => {
    expect(READABLE_BACKUP_RE.test('vault-backup.totpbackup')).toBe(true)
    expect(READABLE_BACKUP_RE.test('vault-20260913-150405.totpbackup')).toBe(true)
    expect(READABLE_BACKUP_RE.test('notes.txt')).toBe(false)
  })
  it('云同步冲突副本名可读（备份列表可恢复）', () => {
    expect(READABLE_BACKUP_RE.test('conflict-20260913-150405.totpbackup')).toBe(true)
    expect(READABLE_BACKUP_RE.test('conflict-backup.totpbackup')).toBe(false)
  })
  it('冲突副本允许多段 sourceId 中间段：旧 backend 单段与 plan16 uuid 五段均可读（审查 C2）', () => {
    expect(READABLE_BACKUP_RE.test('conflict-webdav-20260916-120000.totpbackup')).toBe(true)
    expect(READABLE_BACKUP_RE.test('conflict-20260916-120000.totpbackup')).toBe(true)
    expect(READABLE_BACKUP_RE.test('conflict-2dc4bf8a-5ca7-4087-8b3e-2f1a4d5c6b7e-20260918-024714.totpbackup')).toBe(true)
  })
  it('冲突副本中间段各限小写字母数字：大写拒绝、非法段拒绝、缺时间戳拒绝（防穿越锚定不变）', () => {
    expect(READABLE_BACKUP_RE.test('conflict-WebDav-20260916-120000.totpbackup')).toBe(false)
    expect(READABLE_BACKUP_RE.test('conflict-web_dav-20260916-120000.totpbackup')).toBe(false)
    expect(READABLE_BACKUP_RE.test('conflict-x-y-20260916-120000.totpbackup')).toBe(true)
    expect(READABLE_BACKUP_RE.test('conflict-x-y.totpbackup')).toBe(false)
    expect(READABLE_BACKUP_RE.test('conflict-x-y-20260916-120000.totpbackup/../../evil')).toBe(false)
  })
})

describe('selectBackupsToKeep', () => {
  const names = ['vault-20260913-150405.totpbackup', 'vault-20260912-090000.totpbackup', 'vault-20260911-090000.totpbackup', 'notes.txt', OVERWRITE_NAME]
  it('保留最近 n 个，返回应删除列表；非法名忽略', () => {
    expect(selectBackupsToKeep(names, 2)).toEqual(['vault-20260911-090000.totpbackup'])
    expect(selectBackupsToKeep(names, 5)).toEqual([])
  })
  it('keep=0/负数 → 返回全部合法名（全量清理方向，不裁剪）', () => {
    const allValid = ['vault-20260911-090000.totpbackup', 'vault-20260912-090000.totpbackup', 'vault-20260913-150405.totpbackup']
    expect(selectBackupsToKeep(names, 0)).toEqual(allValid)
    expect(selectBackupsToKeep(names, -1)).toEqual(allValid)
  })
  it('冲突副本不计入滚动删除', () => {
    expect(selectBackupsToKeep(['conflict-20260913-150405.totpbackup', 'vault-20260912-090000.totpbackup'], 1)).toEqual([])
  })
})
