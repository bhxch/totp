import { scrypt } from 'hash-wasm'
import { aesGcmEncrypt, bytesToBase64, randomBytes } from '../crypto/aesgcm'
import type { OtpEntry, Vault } from '../model'

// 布局对齐 Aegis VaultFile.java / VaultEntry.java（官方 master 终审对拍结论）：
// 顶层 {version:1, header:{slots,params}, db}；明文 header.slots=[]、db 为对象。
// entry 字段：type/uuid/name + issuer/note 恒写（官方 toJson 无条件写、fromJson 用 getString("issuer")
// 读取——字段缺失抛异常致整条导入失败，故空串也必须写出）+ info{secret,algo,digits,period,counter}。
// 分组（官方 toJson）：entry 级写 `groups: [<组uuid>,...]` 数组（同名组共享 uuid，db.groups=[{uuid,name}]
// 建引用表）；官方 fromJson 旧版回退读 `group`（组名字符串）。历史上从无 `groupid` 字段（本项目旧版
// 自造约定，导入侧仍兼容回退读取，导出侧不再产出）。

const randomUUID = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

export interface AegisExportReport {
  /** 实际写入的 group 名（去重，条目顺序） */
  usedGroups: string[]
  /** 遗留字段：groups 数组支持多标签后不再丢标签，恒 0（保留以免破坏 BackupCard 消费方签名） */
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
  issuer: string
  note: string
  groups?: string[]
  info: { secret: string; algo: string; digits: number; period: number; counter?: number; pin?: string }
}

function tagNameOf(v: Vault, id: string): string | null {
  return v.tags.find((t) => t.id === id)?.name ?? null
}

function toAegisEntry(e: OtpEntry, groupUuids: string[]): AegisEntryJson {
  const name = e.issuer !== '' ? `${e.issuer}:${e.label}` : e.label
  return {
    type: e.type,
    uuid: e.uuid,
    name,
    // 官方 toJson 无条件写 issuer/note（空串亦写）：fromJson getString("issuer") 对缺失抛异常
    issuer: e.issuer,
    note: e.note ?? '',
    ...(groupUuids.length > 0 ? { groups: groupUuids } : {}),
    info: {
      secret: e.secret,
      algo: e.algorithm,
      digits: e.digits,
      period: e.period,
      ...(e.type === 'hotp' ? { counter: e.counter ?? 0 } : {}),
      // Aegis YandexInfo.toJson 把 pin 放 info.pin（导入侧同口径读取）；无 pin 不写
      ...(e.type === 'yandex' && e.pin !== undefined ? { pin: e.pin } : {}),
    },
  }
}

function buildDb(v: Vault, report: AegisExportReport): Record<string, unknown> {
  // 逐条目解出全部 tag 名（官方 groups 数组可多值，多标签语义保留）；同名 group 共用一个 uuid，
  // groups 表按首次出现顺序（Set 保序）生成
  const entryGroupNames = v.entries.map((e) => e.tagIds.map((id) => tagNameOf(v, id)).filter((n): n is string => n !== null))
  const usedGroups = [...new Set(entryGroupNames.flat())]
  report.usedGroups = usedGroups
  const groupUuid = new Map(usedGroups.map((name) => [name, randomUUID()]))
  const entries = v.entries.map((e, i) => toAegisEntry(e, entryGroupNames[i]!.map((name) => groupUuid.get(name) ?? '')))
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
