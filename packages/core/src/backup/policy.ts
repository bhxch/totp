export const BACKUP_EXT = '.totpbackup'
export const OVERWRITE_NAME = 'vault-backup.totpbackup'

function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

export function backupFileName(now: Date): string {
  return `vault-${stamp(now)}${BACKUP_EXT}`
}

/** 云同步冲突副本文件名（conflict 前缀，与常规备份区分；不参与滚动删除） */
export function conflictBackupFileName(now: Date): string {
  return `conflict-${stamp(now)}${BACKUP_EXT}`
}

export const BACKUP_NAME_RE = /^vault-\d{8}-\d{6}\.totpbackup$/
// 可读（恢复）范围：时间戳名或 overwrite 名均可 + 云同步冲突副本名（备份列表可恢复）；
// 冲突副本允许可选的中间 backend 段（conflict-{backendKey}-{ts}，backendKey 取自 cred.backend，
// 均为小写字母数字，故无需 i 标志且 vault- 分支大小写语义不变）；只允许一段（双段拒绝）。
// 滚动删除仍仅认 BACKUP_NAME_RE（overwrite 名与 conflict 名永不滚动删除）
export const READABLE_BACKUP_RE = /^(vault-(\d{8}-\d{6}|backup)|conflict-(?:[a-z0-9]+-)?\d{8}-\d{6})\.totpbackup$/

export function selectBackupsToKeep(names: string[], keep: number): string[] {
  const valid = names.filter((n) => BACKUP_NAME_RE.test(n)).sort() // 字典序=时间序
  const excess = keep > 0 ? valid.slice(0, Math.max(0, valid.length - keep)) : valid
  return excess
}
