export const BACKUP_EXT = '.totpbackup'
export const OVERWRITE_NAME = 'vault-backup.totpbackup'

export function backupFileName(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `vault-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${BACKUP_EXT}`
}

const NAME_RE = /^vault-\d{8}-\d{6}\.totpbackup$/

export function selectBackupsToKeep(names: string[], keep: number): string[] {
  const valid = names.filter((n) => NAME_RE.test(n)).sort() // 字典序=时间序
  const excess = keep > 0 ? valid.slice(0, Math.max(0, valid.length - keep)) : valid
  return excess
}
