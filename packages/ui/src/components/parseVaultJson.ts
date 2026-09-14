import type { Vault } from '@totp/core'

/** 恢复统一流程第 1 步产物校验：version===1 且 entries/groups 是数组（缺 groups 会在 replaceVault 半途抛错污染 commit 队列）。
 *  BackupCard（文件恢复）与 CloudCard（云端下载采用）共用同一份恢复语义。 */
export function parseVaultJson(json: string): Vault {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('备份内容不是有效的 vault 数据')
  const v = parsed as Vault
  if (v.version !== 1 || !Array.isArray(v.entries) || !Array.isArray(v.groups)) throw new Error('备份内容不是有效的 vault 数据')
  return v
}
