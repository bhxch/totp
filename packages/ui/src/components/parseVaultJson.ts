import type { HashAlgorithm, OtpEntry, Vault } from '@totp/core'

/** 恢复统一流程第 1 步产物校验：version===2 且 entries/tags 是数组（缺 tags 会在 replaceVault 半途抛错污染 commit 队列）。
 *  BackupCard（文件恢复）与 CloudCard（云端下载采用）共用同一份恢复语义。
 *  每条目再做一次语义校验（type/digits/algorithm/period/counter + secret base32 形态）——任何一条不合法都直接抛错，
 *  调用方必须在拿不到合法 Vault 时中止流程，不得调用 replaceAllOp 写入半成品。 */
export function parseVaultJson(json: string): Vault {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('备份内容不是有效的 vault 数据')
  const v = parsed as Vault
  if (v.version !== 2 || !Array.isArray(v.entries) || !Array.isArray(v.tags)) throw new Error('备份内容不是有效的 vault 数据')
  v.entries.forEach((e, i) => validateEntry(e, i))
  return v
}

const ALGORITHMS: HashAlgorithm[] = ['SHA1', 'SHA256', 'SHA512']
/** steam 强制 5；totp/hotp 仅允许 6/7/8 */
function allowedDigits(type: OtpEntry['type']): number[] {
  return type === 'steam' ? [5] : [6, 7, 8]
}

function isBase32String(s: string): boolean {
  // RFC4648 base32：大写字母 A-Z + 数字 2-7，可选尾部 '=' 填充
  return /^[A-Z2-7]+=*$/.test(s)
}

function validateEntry(e: unknown, index: number): asserts e is OtpEntry {
  if (typeof e !== 'object' || e === null) throw new Error(`条目 ${index} 不是有效的对象`)
  const o = e as Record<string, unknown>
  const at = `条目 ${index}`

  if (typeof o.uuid !== 'string' || !o.uuid) throw new Error(`${at} uuid 缺失`)

  if (o.type !== 'totp' && o.type !== 'hotp' && o.type !== 'steam') {
    throw new Error(`${at} type 必须是 totp/hotp/steam`)
  }

  if (typeof o.issuer !== 'string') throw new Error(`${at} issuer 必须为字符串`)
  if (typeof o.label !== 'string') throw new Error(`${at} label 必须为字符串`)

  if (typeof o.secret !== 'string' || !isBase32String(o.secret.toUpperCase().replace(/\s+/g, ''))) {
    throw new Error(`${at} secret 不是合法的 base32 字符串`)
  }

  if (!ALGORITHMS.includes(o.algorithm as HashAlgorithm)) {
    throw new Error(`${at} algorithm 必须是 SHA1/SHA256/SHA512`)
  }

  const allowed = allowedDigits(o.type)
  if (typeof o.digits !== 'number' || !allowed.includes(o.digits)) {
    throw new Error(`${at} digits 必须是 ${allowed.join('/')}`)
  }

  if (typeof o.period !== 'number' || !Number.isFinite(o.period) || o.period < 1) {
    throw new Error(`${at} period 必须为 ≥1 的数字`)
  }

  if (!Array.isArray(o.tagIds) || o.tagIds.some((g) => typeof g !== 'string')) {
    throw new Error(`${at} tagIds 必须为字符串数组`)
  }

  if (typeof o.order !== 'number') throw new Error(`${at} order 必须为数字`)
  if (typeof o.createdAt !== 'number') throw new Error(`${at} createdAt 必须为数字`)

  // HOTP：counter 必填且为非负整数
  if (o.type === 'hotp') {
    if (typeof o.counter !== 'number' || !Number.isInteger(o.counter) || o.counter < 0) {
      throw new Error(`${at}（hotp）counter 必须为非负整数`)
    }
  }
}
