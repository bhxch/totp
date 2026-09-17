/** 云源 keep-n 远端滚动删除（设计 §3）：名单口径与本地一致（BACKUP_NAME_RE、字典序=时间序、
 *  conflict/overwrite 名不参与），仅作用域换成远端 list/delete。删除逐个进行，单个失败不阻断（只计成功数）。 */
import type { CloudBackend } from '../cloud/backend'
import { selectBackupsToKeep } from './policy'

/** 返回删除数；backend 不支持 listBackups 返回 -1 */
export async function enforceRemoteRetention(backend: CloudBackend, keep: number): Promise<number> {
  if (!backend.listBackups) return -1
  if (!Number.isInteger(keep) || keep < 1) return 0
  const stale = selectBackupsToKeep(await backend.listBackups(), keep)
  let deleted = 0
  for (const name of stale) {
    try {
      await backend.delete(name)
      deleted++
    } catch {
      // 单个删除失败不阻断：下轮同步会再次尝试
    }
  }
  return deleted
}
