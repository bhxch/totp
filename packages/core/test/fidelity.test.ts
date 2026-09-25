import {
  addEntry, createVault, exportAegisEncrypted, exportAegisPlaintext, exportOtpauthText,
  importAegisEncrypted, importAegisPlaintext, importUriBatch, newEntryFromUri, resolveTagNames,
} from '@totp/core'
import type { OtpEntry, Vault } from '@totp/core'
import { describe, expect, it } from 'vitest'

// 跨格式保真矩阵（盘点 B11 业务级新增）：同一 vault 经「Aegis 明文/加密」与「otpauth URI 文本」
// 双通道导出 → 再用对应 importer 导入，断言字段逐项无损。覆盖 type/issuer/label/secret/
// algorithm/digits/period/counter/pin/tags 全字段，含 steam/yandex/hotp 特殊形态与多标签。

const SECRET = 'JBSWY3DPEHPK3PXP'

/** 构造固定 vault：totp(多标签)/steam/hotp(counter)/yandex(pin) 各一 */
function buildVault(): { vault: Vault; entries: OtpEntry[] } {
  const totp = newEntryFromUri(`otpauth://totp/GitHub:alice?secret=${SECRET}&algorithm=SHA256&digits=8&period=60`)
  const steam = newEntryFromUri(`otpauth://steam/Steam:carol?secret=${SECRET}`)
  const hotp = newEntryFromUri(`otpauth://hotp/Repo:bob?secret=${SECRET}&counter=42&algorithm=SHA512&digits=7&period=30`)
  const yandex = newEntryFromUri('otpauth://yaotp/Yandex:user?secret=KJTEUGOD5SNXVWBCWJ4G36W4IA&pin=2468')
  let v = createVault()
  const { vault: v1, tagIds } = resolveTagNames(v, ['工作', '重要'])
  v = v1
  totp.tagIds = [tagIds[0]!, tagIds[1]!]
  steam.tagIds = [tagIds[1]!]
  for (const e of [totp, steam, hotp, yandex]) v = addEntry(v, e)
  return { vault: v, entries: [totp, steam, hotp, yandex] }
}

/** 业务字段投影（不含 uuid/order 等本地生命周期字段）；ParsedEntry 与 OtpEntry 共享该结构。
 * digits 用宽 number：导入侧 ParsedEntry 为归一前宽类型，此处只做断言投影 */
type BusinessFields = Pick<OtpEntry, 'type' | 'issuer' | 'label' | 'secret' | 'algorithm' | 'period'> & {
  digits: number
} & Partial<Pick<OtpEntry, 'counter' | 'pin'>>
const project = (e: BusinessFields) => ({
  type: e.type, issuer: e.issuer, label: e.label, secret: e.secret,
  algorithm: e.algorithm, digits: e.digits, period: e.period,
  ...(e.counter !== undefined ? { counter: e.counter } : {}),
  ...(e.pin !== undefined ? { pin: e.pin } : {}),
})

const expected = (): Array<ReturnType<typeof project>> => {
  const { entries } = buildVault()
  return entries.map(project)
}

describe('跨格式保真矩阵：Aegis 明文通道', () => {
  it('导出 → importAegisPlaintext 导入：全字段无损（含多标签/counter/pin）', () => {
    const { vault } = buildVault()
    const { json } = exportAegisPlaintext(vault)
    const r = importAegisPlaintext(json)
    expect(r.failures).toEqual([])
    expect(r.entries.map((e) => project(e))).toEqual(expected())
    // 标签经 groups 引用表回环
    expect(r.entries[0]!.tags).toEqual(['工作', '重要'])
    expect(r.entries[1]!.tags).toEqual(['重要'])
    expect(r.entries[2]!.tags).toBeUndefined()
  })
})

describe('跨格式保真矩阵：Aegis 加密通道', () => {
  it('加密导出 → importAegisEncrypted：scrypt/GCM 往返后全字段无损', async () => {
    const { vault } = buildVault()
    const { json } = await exportAegisEncrypted(vault, 'round-trip-pass')
    const r = await importAegisEncrypted(json, 'round-trip-pass')
    expect(r.failures).toEqual([])
    expect(r.entries.map((e) => project(e))).toEqual(expected())
    expect(r.entries[0]!.tags).toEqual(['工作', '重要'])
  })
})

describe('跨格式保真矩阵：otpauth URI 文本通道', () => {
  it('exportOtpauthText → importUriBatch：URI 可承载字段无损（tags 不入 URI 语义，不参与断言）', () => {
    const { vault } = buildVault()
    const text = exportOtpauthText(vault)
    const r = importUriBatch(text)
    expect(r.failures).toEqual([])
    expect(r.entries.map((e) => project(e))).toEqual(expected())
  })

  it('steam/yaotp 特殊 host 在 URI 文本中保形（非 otpauth://totp/ 标准形态）', () => {
    const { vault } = buildVault()
    const lines = exportOtpauthText(vault).split('\n')
    expect(lines[1]).toMatch(/^otpauth:\/\/steam\//)
    expect(lines[3]).toMatch(/^otpauth:\/\/yaotp\//)
    expect(lines[3]).toContain('pin=2468')
    expect(lines[2]).toContain('counter=42')
  })
})
