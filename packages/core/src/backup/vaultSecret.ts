import type { Vault } from '../model'

/** 库内保管的备份口令（仅随 DEK 加密的 vault JSON 落盘/同步；明文库禁存，守护在 ui store 层） */
export function readVaultBackupSecret(vault: Vault): string | null {
  const s = vault.backupSecret
  return typeof s === 'string' && s.length > 0 ? s : null
}

export function withVaultBackupSecret(vault: Vault, secret: string | null): Vault {
  const next: Vault = { ...vault, updatedAt: Date.now() }
  if (secret === null || secret.length === 0) delete next.backupSecret
  else next.backupSecret = secret
  return next
}
