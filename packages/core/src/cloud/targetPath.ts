import { backupFileName } from '../backup/policy'
import type { CloudCred } from './backend'

export const DEFAULT_OBJECT_PATH = 'totp-backup.totpbackup'

/** 云端对象路径：凭据可自定义（objectPath），缺省回落历史固定值；写盘前校验防穿越 */
export function resolveObjectPath(cred: CloudCred): string {
  const raw = cred.objectPath?.trim()
  if (raw === undefined || raw === '') return DEFAULT_OBJECT_PATH
  if (raw.includes('\0')) throw new Error('云端路径含非法字符')
  const segments = raw.split(/[\\/]/).filter((s) => s !== '')
  if (segments.length === 0) return DEFAULT_OBJECT_PATH
  if (segments.some((s) => s === '.' || s === '..')) throw new Error('云端路径不允许相对段（. / ..）')
  return segments.join('/')
}

/** keep-n 云源上传名：对象路径同目录下 vault-{yyyyMMdd-HHmmss}.totpbackup（与本地 backupFileName 同戳格式） */
export function resolveTimestampPath(cred: CloudCred, now: Date): string {
  const dir = resolveDirPath(cred)
  const name = backupFileName(now)
  return dir ? `${dir}/${name}` : name
}

/** 对象路径父目录（'a/b/c.totpbackup'→'a/b'；无目录段→''）。穿越校验与 resolveObjectPath 同款 */
export function resolveDirPath(cred: CloudCred): string {
  const p = resolveObjectPath(cred)
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : ''
}
