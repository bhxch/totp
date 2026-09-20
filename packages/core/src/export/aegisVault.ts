import { scrypt } from 'hash-wasm'
import { aesGcmEncrypt, bytesToBase64, randomBytes } from '../crypto/aesgcm'
import type { OtpEntry, Vault } from '../model'

// 布局对齐 Aegis VaultFile.java（本项目 import/aegis.ts 头部注释已核对）：
// 顶层 {version:1, header:{slots,params}, db}；明文 header.slots=[]、db 为对象。
// entry 字段对齐 import 侧 parseEntry 读取口径：type/name/issuer/note + info{secret,algo,digits,period,counter}；
// group 按 Aegis 布局为 entry.groupid → db.groups[].uuid 的引用（导入侧 groups.get(entry.groupid) 查名），
// 不直接在 entry 上写 group 名。

const randomUUID = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

export interface AegisExportReport {
  /** 实际写入的 group 名（去重，条目顺序） */
  usedGroups: string[]
  /** 多标签条目中被丢弃的标签总数（每条目保留第一个，spec §2.2） */
  droppedTagCount: number
}

export interface AegisExportResult {
  json: string
  report: AegisExportReport
}

interface AegisEntryJson {
  type: OtpEntry['type']
  uuid: string
  name: string
  issuer?: string
  note?: string
  groupid?: string
  info: { secret: string; algo: string; digits: number; period: number; counter?: number }
}

function tagNameOf(v: Vault, id: string): string | null {
  return v.tags.find((t) => t.id === id)?.name ?? null
}

function toAegisEntry(e: OtpEntry, groupid: string | undefined): AegisEntryJson {
  const name = e.issuer !== '' ? `${e.issuer}:${e.label}` : e.label
  return {
    type: e.type,
    uuid: e.uuid,
    name,
    ...(e.issuer !== '' ? { issuer: e.issuer } : {}),
    ...(e.note !== undefined && e.note !== '' ? { note: e.note } : {}),
    ...(groupid !== undefined ? { groupid } : {}),
    info: {
      secret: e.secret,
      algo: e.algorithm,
      digits: e.digits,
      period: e.period,
      ...(e.type === 'hotp' ? { counter: e.counter ?? 0 } : {}),
    },
  }
}

function buildDb(v: Vault, report: AegisExportReport): Record<string, unknown> {
  // 逐条目解出首个 tag 名作 group（其余计入 droppedTagCount，spec §2.2）；
  // 同名 group 共用一个 uuid，groups 表按首次出现顺序（Set 保序）生成
  const groupNames = v.entries.map((e) => {
    const names = e.tagIds.map((id) => tagNameOf(v, id)).filter((n): n is string => n !== null)
    report.droppedTagCount += Math.max(0, names.length - 1)
    return names[0] ?? null
  })
  const usedGroups = [...new Set(groupNames.filter((g): g is string => g !== null))]
  report.usedGroups = usedGroups
  const groupUuid = new Map(usedGroups.map((name) => [name, randomUUID()]))
  const entries = v.entries.map((e, i) => toAegisEntry(e, groupNames[i] === null ? undefined : groupUuid.get(groupNames[i] as string)))
  return { entries, groups: usedGroups.map((name) => ({ uuid: groupUuid.get(name) ?? '', name })) }
}

export function exportAegisPlaintext(v: Vault): AegisExportResult {
  const report: AegisExportReport = { usedGroups: [], droppedTagCount: 0 }
  const json = JSON.stringify({ version: 1, header: { slots: [], params: {} }, db: buildDb(v, report) })
  return { json, report }
}

// 加密导出与 import/aegis.ts 同口径（本文件头部注释 + import 侧已核对官方布局）：
// AES-256-GCM，nonce 12B、tag 16B，WebCrypto 产 ct||tag 连体后拆分存储；
// PasswordSlot(type=1)：KEK = scrypt(pw, salt, n=16384, r=8, p=1)（Aegis 默认档）包 master key。
// exportAegisEncrypted 是 importAegisEncrypted 的精确逆过程，round-trip 为权威验证。
const AEGIS_SCRYPT = { costFactor: 16384, blockSize: 8, parallelism: 1, hashLength: 32 } as const
const AEGIS_SCRYPT_NRP = { n: 16384, r: 8, p: 1 } as const

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** GCM 加密并按 Aegis 布局拆 nonce/tag（随机 12B nonce，WebCrypto 输出 ct||tag 连体后拆分） */
async function gcmSplit(key: Uint8Array, plain: Uint8Array): Promise<{ ct: Uint8Array; tag: Uint8Array; nonce: Uint8Array }> {
  const nonce = randomBytes(12)
  const out = new Uint8Array(await aesGcmEncrypt(key, plain, nonce))
  return { ct: out.slice(0, out.length - 16), tag: out.slice(out.length - 16), nonce }
}

/** Aegis 加密 vault 导出：单个 PasswordSlot 包 32B 随机 master key，master key 解 db */
export async function exportAegisEncrypted(v: Vault, password: string): Promise<AegisExportResult> {
  const report: AegisExportReport = { usedGroups: [], droppedTagCount: 0 }
  const dbJson = JSON.stringify(buildDb(v, report))

  // ① 32B 随机 master key → 加密 db（密文 Base64 写顶层 db，nonce/tag 写 header.params）
  const master = randomBytes(32)
  const db = await gcmSplit(master, new TextEncoder().encode(dbJson))

  // ② PasswordSlot：KEK = scrypt(password, salt, 16384/8/1) 包 master key
  const salt = randomBytes(16)
  const kek = (await scrypt({ password, salt, ...AEGIS_SCRYPT, outputType: 'binary' })) as Uint8Array
  const slotWrap = await gcmSplit(kek, master)

  const header = {
    slots: [{
      type: 1,
      uuid: randomUUID(),
      key: bytesToHex(slotWrap.ct),
      key_params: { nonce: bytesToHex(slotWrap.nonce), tag: bytesToHex(slotWrap.tag) },
      salt: bytesToHex(salt),
      ...AEGIS_SCRYPT_NRP,
    }],
    params: { nonce: bytesToHex(db.nonce), tag: bytesToHex(db.tag) },
  }
  const json = JSON.stringify({ version: 1, header, db: bytesToBase64(db.ct) })
  return { json, report }
}
