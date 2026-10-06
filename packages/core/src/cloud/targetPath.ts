import { backupFileName } from '../backup/policy'
import type { CloudCred } from './backend'

export const DEFAULT_OBJECT_PATH = 'totp-backup.totpbackup'

/** 云端对象路径：凭据可自定义（objectPath），缺省回落历史固定值；写盘前校验防穿越 */
export function resolveObjectPath(cred: CloudCred): string {
  const raw = cred.objectPath?.trim()
  if (raw === undefined || raw === '') return DEFAULT_OBJECT_PATH
  if (raw.includes('\0')) throw new Error('云端路径含非法字符')
  // #/? 不编码会被 URL parser 截断成 fragment/query → 实际写到错误位置（spec §4.4 404 根因之一）
  if (/[#?]/.test(raw)) throw new Error('云端路径不允许包含 # 或 ?')
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

/** 测试隔离：清空同秒防撞记忆（模块级状态跨用例污染；生产代码勿调）。
 *  先例：oauthRefresh.ts __resetOAuthCacheForTest 同款。 */
export function __resetForTest(): void {
  lastIssuedMsByDir.clear()
}

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

/** keep 模式路径预览的文件名占位（真实上传名由 resolveTimestampPath 按当时时间签发） */
export const KEEP_NAME_PLACEHOLDER = 'vault-YYYYMMDD-HHMMSS.totpbackup'

/** 「目标文件路径」实时预览结果 */
export interface ObjectPathPreview {
  /** 'ok'=可展示；'invalid'=resolveObjectPath 会抛的非法路径（\0/相对段），UI 据此展示错误文案 */
  state: 'ok' | 'invalid'
  /** overwrite：实际完整目标；keep：目录部分（''=根目录） */
  path: string
  /** keep 模式自动生成的文件名占位；overwrite 时缺省 */
  keepNamePlaceholder?: string
}

/** 「目标文件路径」实时预览（②）：与上传链同语义（resolveObjectPath/resolveDirPath 单点复用）、
 *  纯只读——绝不调用 resolveTimestampPath（其会推进同秒防撞记忆，预览不得产生副作用），keep
 *  文件名以固定占位展示。resolveObjectPath 的两类抛错折叠为 state:'invalid'，不向 UI 抛异常。
 *  retention 参数收 Retention 联合的超集形状（n 可选），调用方可直接传源 retention。 */
export function previewObjectPath(cred: CloudCred, retention: { type: 'overwrite' | 'keep'; n?: number }): ObjectPathPreview {
  let resolved: string
  try {
    resolved = resolveObjectPath(cred)
  } catch {
    return { state: 'invalid', path: '' }
  }
  if (retention.type === 'overwrite') return { state: 'ok', path: resolved }
  return { state: 'ok', path: resolveDirPath(cred), keepNamePlaceholder: KEEP_NAME_PLACEHOLDER }
}
