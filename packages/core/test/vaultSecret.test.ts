import { describe, expect, it } from 'vitest'
import { createVault } from '../src/vault'
import { readVaultBackupSecret, withVaultBackupSecret } from '../src/backup/vaultSecret'

describe('vault 备份口令保管', () => {
  it('未设置时读出 null', () => {
    expect(readVaultBackupSecret(createVault())).toBeNull()
  })
  it('写入后可读回', () => {
    const v = withVaultBackupSecret(createVault(), '口令A')
    expect(readVaultBackupSecret(v)).toBe('口令A')
  })
  it('null 与空串均为清除', () => {
    expect(readVaultBackupSecret(withVaultBackupSecret(createVault(), ''))).toBeNull()
    expect(readVaultBackupSecret(withVaultBackupSecret(createVault(), null))).toBeNull()
  })
  it('覆盖写入', () => {
    const v = withVaultBackupSecret(withVaultBackupSecret(createVault(), '旧'), '新')
    expect(readVaultBackupSecret(v)).toBe('新')
  })
  it('不影响其他字段与 updatedAt 刷新', () => {
    const base = createVault()
    const v = withVaultBackupSecret(base, 'x')
    expect(v.version).toBe(1); expect(v.entries).toEqual([])
    expect(v.updatedAt).toBeGreaterThanOrEqual(base.updatedAt)
  })
})
