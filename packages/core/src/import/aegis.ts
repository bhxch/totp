import { scrypt } from 'hash-wasm'
import { aesGcmDecrypt, base64ToBytes } from '../crypto/aesgcm'
import { hexToBytes } from '../encoding/hex'
import {
  normalizeAlgorithm, normalizeSecret, normalizeType, toPositiveNumber,
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

// type/algorithm/数值规整 helpers 已迁出至 ./normalize（M10 收敛）
/** Aegis entry → ParsedEntry；secret 缺失视为单条损坏（进 failures） */
function parseEntry(raw: unknown, index: number): ParsedEntry | { error: string } {
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
  if (typeof entry.note === 'string' && entry.note !== '') parsed.note = entry.note
  return parsed
}

/** Aegis db（明文 JSON 对象）→ ImportResult，单条损坏进 failures */
function parseDbEntries(db: unknown): ImportResult {
  if (db === null || typeof db !== 'object') throw new Error('Aegis 文件结构非法：缺少 db 对象')
  const entries = (db as Record<string, unknown>).entries
  if (!Array.isArray(entries)) throw new Error('Aegis 文件结构非法：缺少 db.entries 数组')

  const parsed: ParsedEntry[] = []
  const failures: ImportResult['failures'] = []
  entries.forEach((raw, index) => {
    const res = parseEntry(raw, index)
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
