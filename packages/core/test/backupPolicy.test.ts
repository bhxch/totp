import { describe, expect, it } from 'vitest'
import { backupFileName, OVERWRITE_NAME, READABLE_BACKUP_RE, selectBackupsToKeep } from '../src/backup/policy'

describe('backupFileName', () => {
  it('本地时区格式', () => {
    const d = new Date(2026, 8, 13, 15, 4, 5) // 2026-09-13 15:04:05 本地
    expect(backupFileName(d)).toBe('vault-20260913-150405.totpbackup')
  })
})

describe('READABLE_BACKUP_RE', () => {
  it('时间戳名与 overwrite 名均可读，非法名拒绝', () => {
    expect(READABLE_BACKUP_RE.test('vault-backup.totpbackup')).toBe(true)
    expect(READABLE_BACKUP_RE.test('vault-20260913-150405.totpbackup')).toBe(true)
    expect(READABLE_BACKUP_RE.test('notes.txt')).toBe(false)
  })
})

describe('selectBackupsToKeep', () => {
  const names = ['vault-20260913-150405.totpbackup', 'vault-20260912-090000.totpbackup', 'vault-20260911-090000.totpbackup', 'notes.txt', OVERWRITE_NAME]
  it('保留最近 n 个，返回应删除列表；非法名忽略', () => {
    expect(selectBackupsToKeep(names, 2)).toEqual(['vault-20260911-090000.totpbackup'])
    expect(selectBackupsToKeep(names, 5)).toEqual([])
  })
})
