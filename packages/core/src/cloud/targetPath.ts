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

/** 各目录上次签发的时间戳（秒级取整 ms）（审查 M3）：精度到秒，同目录两个源同一秒上传会同名互相覆盖——
 *  同目录撞名时推进一秒避让。选推进而非随机后缀：文件名严格保持 vault-\d{8}-\d{6} 格式，
 *  BACKUP_NAME_RE/READABLE_BACKUP_RE（滚动删除与恢复列表过滤）零改动全兼容；同进程确定性防撞；
 *  字典序=时间序的滚动删除排序不变。跨进程/多端残余碰撞概率与旧版相同（需两端同秒上传同目录，可接受）。
 *  比较与存储均取整秒：文件名只精确到秒，若按原始毫秒比较则同秒不同毫秒（.2s 与 .8s）不触发推进仍撞名
 *  （质量审查勘误）。 */
const lastIssuedMsByDir = new Map<string, number>()

/** keep-n 云源上传名：对象路径同目录下 vault-{yyyyMMdd-HHmmss}.totpbackup（与本地 backupFileName 同戳格式） */
export function resolveTimestampPath(cred: CloudCred, now: Date): string {
  const dir = resolveDirPath(cred)
  let sec = Math.floor(now.getTime() / 1000) * 1000
  const last = lastIssuedMsByDir.get(dir)
  if (last !== undefined && sec <= last) sec = last + 1000 // 同秒（含毫秒错开；或时钟回拨到已签发秒）推进一秒防同名
  lastIssuedMsByDir.set(dir, sec)
  const name = backupFileName(new Date(sec))
  return dir ? `${dir}/${name}` : name
}

/** 对象路径父目录（'a/b/c.totpbackup'→'a/b'；无目录段→''）。穿越校验与 resolveObjectPath 同款 */
export function resolveDirPath(cred: CloudCred): string {
  const p = resolveObjectPath(cred)
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : ''
}
