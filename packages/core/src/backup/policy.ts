export const BACKUP_EXT = '.totpbackup'
export const OVERWRITE_NAME = 'vault-backup.totpbackup'

function stamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

export function backupFileName(now: Date): string {
  return `vault-${stamp(now)}${BACKUP_EXT}`
}

/** 云同步冲突副本文件名（conflict 前缀，与常规备份区分；不参与滚动删除）。
 *  sourceId 可选（R14 单点化：desktop backupService 与 extension cloudCredStore 原各拼一份
 *  `conflict-{id}-{ts}`，跨端命名一致才能被 READABLE_BACKUP_RE 识别恢复）：提供时产
 *  conflict-{sourceId}-{ts}（多源副本按源区分，中间段形态受 READABLE_BACKUP_RE 的
 *  (?:[a-z0-9]+-)* 段约束），缺省保持历史 conflict-{ts} 名 */
export function conflictBackupFileName(now: Date, sourceId?: string): string {
  return `conflict-${sourceId ? `${sourceId}-` : ''}${stamp(now)}${BACKUP_EXT}`
}

export const BACKUP_NAME_RE = /^vault-\d{8}-\d{6}\.totpbackup$/
// 可读（恢复）范围：时间戳名或 overwrite 名均可 + 云同步冲突副本名（备份列表可恢复）；
// 冲突副本允许可选的多段 sourceId 中间段（conflict-{sourceId}-{ts}）：plan16 后新源 id 为
// uuid（五段连字符），旧迁移源 id=backend（单段）；各段均限小写字母数字（无需 i 标志且
// vault- 分支大小写语义不变），整体锚定且不含路径分隔符——防穿越语义与「多段」不冲突。
// 滚动删除仍仅认 BACKUP_NAME_RE（overwrite 名与 conflict 名永不滚动删除）
export const READABLE_BACKUP_RE = /^(vault-(\d{8}-\d{6}|backup)|conflict-(?:[a-z0-9]+-)*\d{8}-\d{6})\.totpbackup$/

/** 从 vault-YYYYMMDD-HHMMSS 名解析本地时间戳（ms）；不匹配或日历段非法返回 null（云-M3：
 *  13 月、32 日、99 时等 \d{2} 匹配但非日历值的段会被 new Date 静默进位，年龄计算偏移——
 *  按既有时间戳格式的段位范围校验：月 01-12、日 01-31、时 00-23、分/秒 00-59） */
export function backupNameTimestampMs(name: string): number | null {
  const m = /^vault-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.totpbackup$/.exec(name)
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  const h = Number(m[4]); const mi = Number(m[5]); const s = Number(m[6])
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/** 滚动删除名单（③ 加 days 维度）：字典序=时间序；候选=超出最近 keep 份的超额名单；
 *  days>0 时仅删「超 keep 份 且 文件龄 > days 天」者（任一条件不满足即保留）。
 *  days 缺省/0=忽略天数条件，行为与旧版逐字节一致。 */
export function selectBackupsToKeep(names: string[], keep: number, days = 0): string[] {
  const valid = names.filter((n) => BACKUP_NAME_RE.test(n)).sort() // 字典序=时间序
  const excess = keep > 0 ? valid.slice(0, Math.max(0, valid.length - keep)) : valid
  if (!(days > 0)) return excess
  const now = Date.now()
  return excess.filter((n) => {
    const ts = backupNameTimestampMs(n)
    return ts !== null && now - ts > days * 86_400_000
  })
}
