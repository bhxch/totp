import { scrypt } from 'hash-wasm'
import { aesGcmDecrypt, base64ToBytes } from '../crypto/aesgcm'
import { hexToBytes } from '../encoding/hex'
import {
  asObject, normalizeAlgorithm, normalizeSecret, normalizeType, toPositiveNumber,
} from './normalize'
import type { ImportResult, ParsedEntry } from './types'

// Aegis vault 导入（明文 + 加密），布局对齐 Aegis 官方源码（beemdevelopment/Aegis master）：
// - vault/VaultFile.java：顶层 {version, header:{slots, params}, db}；加密时 db=Base64(密文)，
//   解密时 Base64 解码后按 header.params 解密（getContent）；明文时 db 为 JSON 对象
// - crypto/CryptParameters.java：nonce/tag 为十六进制编码的分开字段 {"nonce","tag"}，
//   header.params 无 scrypt 字段（scrypt 参数在 slot 级）
// - crypto/CryptoUtils.java：AES/GCM/NoPadding，nonce 12B、tag 16B；encrypt 时 JCE 输出
//   ct||tag 后拆分存储，decrypt 时重新拼接 ct||tag 再校验（本实现用 WebCrypto，
//   其 data 参数即 ct||tag 连体，故解密前需把 tag 拼回密文尾部）
// - vault/slots/Slot.java：slot 字段 type/uuid/key/key_params；key=Hex(密文，不含 tag)
// - vault/slots/PasswordSlot.java（TYPE_ID=1）：scrypt 参数为 slot 级字段 n/r/p，salt=Hex(salt)
// - vault/slots/RawSlot.java TYPE_ID=0、BiometricSlot TYPE_ID=2：本实现只支持 PasswordSlot
// - crypto/MasterKey.java + vault/VaultFileCredentials.java：master key 由 KEK（scrypt 派生）
//   从 slot 解出，再用 master key + header.params(nonce/tag) 解 db
// - encoding/Hex.java：小写编码，解码大小写兼容

const TAG_LEN = 16
const NONCE_LEN = 12

// 钳制 slot 级 scrypt 参数（与 backup/envelope、security/securityStore 对 argon2id 的上限同口径）：
// 恶意导入文件可声明超大 n/r/p，使 hash-wasm scrypt 按 128*n*r 字节预分配内存而资源耗尽，
// 且解密失败会吞错换下一个 slot 逐个放大；超限视为文件结构非法，整文件拒绝而非逐 slot 回退。
// 上限换算：scrypt 内存 = 128*n*r 字节 ≤ 2 GiB（对应 argon2id m ≤ 2**21 KiB 的同额度上限），
// r ≤ 8 时得 n ≤ 2**31/(128*8) = 2**21；r/p 上限沿用 envelope/securityStore 的 8。
// 真实 Aegis 导出（N=16384/r=8/p=1，slot 仅口令+生物识别等少数几个）远低于该上限。
const MAX_SCRYPT_N = 2 ** 21
const MAX_SCRYPT_R = 8
const MAX_SCRYPT_P = 8
// 参与解密尝试的 slot 数上限：真实导出至多数个 slot，超出即结构非法
const MAX_SLOTS = 8

/** 加密导入前的 slot 结构钳制：超限直接拒绝整文件，防止恶意参数在逐 slot 解密尝试中触发资源耗尽 */
function assertSlotsWithinLimits(slots: Record<string, unknown>[]): void {
  if (slots.length > MAX_SLOTS) throw new Error('Aegis 文件结构非法：slots 数量超限')
  for (const slot of slots) {
    if (slot === null || typeof slot !== 'object') continue
    const s = slot as Record<string, unknown>
    if (s.type !== 1) continue // 仅 PasswordSlot 参与 scrypt（与 tryDecryptSlot 的过滤口径一致）
    const n = Number(s.n)
    const r = Number(s.r)
    const p = Number(s.p)
    // 非有限数沿用既有行为：交由 tryDecryptSlot 返回 null 换下一 slot，这里只钳有限值
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) continue
    if (n > MAX_SCRYPT_N || r > MAX_SCRYPT_R || p > MAX_SCRYPT_P) {
      throw new Error('Aegis 文件结构非法：slot 的 scrypt 参数超限')
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

// type/algorithm/数值规整 helpers 已迁出至 ./normalize（M10 收敛）
/** Aegis entry → ParsedEntry；secret 缺失视为单条损坏（进 failures） */
function parseEntry(raw: unknown, index: number, groups: Map<string, string>): ParsedEntry | { error: string } {
  if (raw === null || typeof raw !== 'object') return { error: `条目 ${index} 非对象` }
  const entry = raw as Record<string, unknown>
  const info = (entry.info ?? {}) as Record<string, unknown>

  if (typeof info.secret !== 'string' || info.secret.trim() === '') return { error: `条目 ${index} 缺少 secret` }

  const type = normalizeType(entry.type)
  const name = typeof entry.name === 'string' ? entry.name : ''
  // issuer 优先独立字段（新版 Aegis），否则按 name 的 `Issuer:label` 前缀段拆分
  const sep = name.indexOf(':')
  const issuer =
    typeof entry.issuer === 'string' && entry.issuer !== '' ? entry.issuer : sep > 0 ? name.slice(0, sep) : ''
  const label = sep > 0 ? name.slice(sep + 1) : name

  const parsed: ParsedEntry = {
    type,
    issuer,
    label,
    secret: normalizeSecret(info.secret),
    algorithm: normalizeAlgorithm(info.algo),
    digits: type === 'steam' ? 5 : toPositiveNumber(info.digits, 6),
    period: toPositiveNumber(info.period, 30),
  }
  const counter = Number(info.counter)
  if (Number.isFinite(counter) && counter >= 0) parsed.counter = counter
  // Yandex（type=yandex）：Aegis YandexInfo 序列化把 PIN 放 info.pin；仅字符串形态采纳
  if (parsed.type === 'yandex' && typeof info.pin === 'string') parsed.pin = info.pin
  if (typeof entry.note === 'string' && entry.note !== '') parsed.note = entry.note
  // 分组（官方布局对拍）：新版 entry.groups 为 uuid 数组（可多值=多标签，逐个查 db.groups 表保留全部）；
  // 回退 1：本项目旧版自产文件的 groupid（uuid 查表）；回退 2：官方老版 legacy 的 group（组名字符串直用）。
  // 历史上官方从无 groupid 字段。groups 数组存在时优先（即使查表全 miss 也不回落 legacy，避免错挂旧名）
  const tagNames = ((): string[] => {
    if (Array.isArray(entry.groups)) {
      return entry.groups
        .filter((g): g is string => typeof g === 'string')
        .map((id) => groups.get(id))
        .filter((n): n is string => n !== undefined)
    }
    if (typeof entry.groupid === 'string') {
      const n = groups.get(entry.groupid)
      return n !== undefined ? [n] : []
    }
    return typeof entry.group === 'string' ? [entry.group] : []
  })()
  if (tagNames.length > 0) parsed.tags = tagNames
  return parsed
}

/** Aegis db（明文 JSON 对象）→ ImportResult，单条损坏进 failures */
function parseDbEntries(db: unknown): ImportResult {
  if (db === null || typeof db !== 'object') throw new Error('Aegis 文件结构非法：缺少 db 对象')
  const dbObj = db as Record<string, unknown>
  const entries = dbObj.entries
  if (!Array.isArray(entries)) throw new Error('Aegis 文件结构非法：缺少 db.entries 数组')

  // db.groups: [{uuid, name}] → entry.groups uuid 数组查表（官方布局；groupid/group 为回退，见 parseEntry）；
  // 缺 groups/条目无分组引用均合法
  const groups = new Map<string, string>()
  if (Array.isArray(dbObj.groups)) {
    for (const g of dbObj.groups) {
      const o = asObject(g)
      if (o && typeof o.uuid === 'string' && typeof o.name === 'string' && o.name.trim() !== '') {
        groups.set(o.uuid, o.name)
      }
    }
  }

  const parsed: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  entries.forEach((raw, index) => {
    const res = parseEntry(raw, index, groups)
    if ('error' in res) failures.push({ index, message: res.error })
    else parsed.push(res)
  })
  return { entries: parsed, failures }
}

function parseJson(text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Aegis 文件结构非法：不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('Aegis 文件结构非法：顶层不是 JSON 对象')
  return parsed as Record<string, unknown>
}

/** Aegis 明文 vault 导入：{ db: { entries: [...] } } */
export function importAegisPlaintext(text: string): ImportResult {
  return parseDbEntries(parseJson(text).db)
}

interface AegisHeader {
  slots: Record<string, unknown>[]
  params: Record<string, unknown>
  dbB64: string
}

function parseEncryptedHeader(text: string): AegisHeader {
  const obj = parseJson(text)
  const header = obj.header
  if (header === null || typeof header !== 'object') throw new Error('Aegis 文件结构非法：缺少 header')
  const h = header as Record<string, unknown>
  const params = h.params
  if (params === null || typeof params !== 'object') throw new Error('Aegis 文件结构非法：缺少 header.params')
  if (!Array.isArray(h.slots)) throw new Error('Aegis 文件结构非法：缺少 header.slots 数组')
  if (typeof obj.db !== 'string') throw new Error('Aegis 文件结构非法：缺少加密的 db 字符串')
  return {
    slots: h.slots as Record<string, unknown>[],
    params: params as Record<string, unknown>,
    dbB64: obj.db,
  }
}

/** 从单个 PasswordSlot（type=1）解出 master key；结构不完整或解密失败返回 null */
async function tryDecryptSlot(
  slot: Record<string, unknown>,
  password: string,
): Promise<Uint8Array | null> {
  if (slot.type !== 1) return null // 仅 PasswordSlot（KeySlot TYPE_ID=1），RawSlot/BiometricSlot 跳过
  try {
    const keyParams = (slot.key_params ?? {}) as Record<string, unknown>
    if (
      typeof slot.key !== 'string' ||
      typeof slot.salt !== 'string' ||
      typeof keyParams.nonce !== 'string' ||
      typeof keyParams.tag !== 'string'
    ) {
      return null
    }
    const n = Number(slot.n)
    const r = Number(slot.r)
    const p = Number(slot.p)
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return null

    const salt = hexToBytes(slot.salt)
    const slotCt = hexToBytes(slot.key)
    const slotNonce = hexToBytes(keyParams.nonce)
    const slotTag = hexToBytes(keyParams.tag)
    if (!salt || !slotCt || !slotNonce || !slotTag || slotNonce.length !== NONCE_LEN || slotTag.length !== TAG_LEN) {
      return null
    }

    // KEK = scrypt(password, slot.salt, n, r, p)，32 字节（PasswordSlot.deriveKey → CryptoUtils.deriveKey）
    // 注意 hash-wasm 4.x 的参数名为 costFactor/blockSize/parallelism，对应 scrypt 的 N/r/p
    const kek = (await scrypt({
      password,
      salt,
      costFactor: n,
      blockSize: r,
      parallelism: p,
      hashLength: 32,
      outputType: 'binary',
    })) as Uint8Array

    // master key = GCM 解密 slot.key：nonce=key_params.nonce、tag 拼回密文尾部（CryptoUtils.decrypt）
    return await aesGcmDecrypt(kek, concatBytes(slotCt, slotTag), slotNonce)
  } catch {
    return null // scrypt 参数非法 / GCM tag 校验失败（口令错）等，换下一个 slot
  }
}

/**
 * Aegis 加密 vault 导入：解开任一 PasswordSlot 得 master key，再解 db（明文 JSON 后走 parseDbEntries）。
 * 全部 slot 解不开（口令错或文件损坏）→ Error('口令错误或文件已损坏')
 */
export async function importAegisEncrypted(text: string, password: string): Promise<ImportResult> {
  const header = parseEncryptedHeader(text)

  const params = header.params
  const dbNonce = typeof params.nonce === 'string' ? hexToBytes(params.nonce) : null
  const dbTag = typeof params.tag === 'string' ? hexToBytes(params.tag) : null
  if (!dbNonce || !dbTag || dbNonce.length !== NONCE_LEN || dbTag.length !== TAG_LEN) {
    throw new Error('Aegis 文件结构非法：header.params 的 nonce/tag 非法')
  }
  let dbBytes: Uint8Array
  try {
    dbBytes = base64ToBytes(header.dbB64)
  } catch {
    throw new Error('Aegis 文件结构非法：db 不是合法 base64')
  }

  let masterKey: Uint8Array | null = null
  assertSlotsWithinLimits(header.slots)
  for (const slot of header.slots) {
    if (slot === null || typeof slot !== 'object') continue
    masterKey = await tryDecryptSlot(slot as Record<string, unknown>, password)
    if (masterKey) break
  }
  if (!masterKey) throw new Error('口令错误或文件已损坏')

  // db = Base64(密文)，nonce/tag 在 header.params；tag 拼回尾部（MasterKey.decrypt → CryptoUtils.decrypt）
  let dbJsonBytes: Uint8Array
  try {
    dbJsonBytes = await aesGcmDecrypt(masterKey, concatBytes(dbBytes, dbTag), dbNonce)
  } catch {
    throw new Error('口令错误或文件已损坏')
  }
  return parseDbEntries(parseJson(new TextDecoder().decode(dbJsonBytes)))
}
