import { importUriBatch } from './uriBatch'
import { decryptZipEntryAes } from './zipAes'
import { inflateEntry, listZipEntries, readZipEntryData } from './zipRead'
import type { ImportResult } from './types'

/**
 * Authenticator Plus 导入（对齐 Aegis AuthenticatorPlusImporter.java 的权威源核实结论）：
 * AP「导出为文本」生成 WinZip AES 加密 zip，内为 Accounts.txt（otpauth URI 逐行文本），
 * 解出后直接复用 importUriBatch——无 SQLite、无 group→tag 映射。
 */
export async function importAuthenticatorPlus(zipBytes: Uint8Array, password: string): Promise<ImportResult> {
  const entries = listZipEntries(zipBytes)
  const target = entries.find((e) => e.name.endsWith('Accounts.txt'))
  if (!target) throw new Error('压缩包中未找到 Accounts.txt（请使用 Authenticator Plus 的文本导出）')
  const raw = readZipEntryData(zipBytes, target)
  const plain = target.aes ? await decryptZipEntryAes(password, raw, target.aes.strength, target.aes.version) : raw
  const text = new TextDecoder().decode(inflateEntry(target, plain))
  return importUriBatch(text)
}
