import { createVault, addEntry, exportOtpauthText, parseOtpUri, newEntryFromUri, type OtpEntry, type Vault } from '@totp/core'
import { describe, expect, it } from 'vitest'

function vaultWith(entries: OtpEntry[]): Vault {
  let v = createVault()
  for (const e of entries) v = addEntry(v, e)
  return v
}

describe('exportOtpauthText', () => {
  it('totp/hotp/steam 逐行导出且可回读（round-trip）', () => {
    const totp = newEntryFromUri('otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP')
    const hotp = newEntryFromUri('otpauth://hotp/Repo:bob?secret=JBSWY3DPEHPK3PXP&counter=7')
    const steam = newEntryFromUri('otpauth://steam/Steam:carol?secret=JBSWY3DPEHPK3PXP')
    const text = exportOtpauthText(vaultWith([totp, hotp, steam]))
    const lines = text.split('\n')
    expect(lines).toHaveLength(3)
    const [a, b, c] = lines.map((l) => parseOtpUri(l))
    // noUncheckedIndexedAccess：数组解构为 T | undefined，用 ?. 保持断言语义（undefined 即失败）
    expect(a?.type).toBe('totp'); expect(a?.issuer).toBe('GitHub'); expect(a?.label).toBe('alice')
    expect(b?.type).toBe('hotp'); expect(b?.counter).toBe(7)
    expect(c?.type).toBe('steam'); expect(c?.digits).toBe(5)
  })
  it('yandex 导出走 yaotp host 且携带 pin（round-trip 保真）', () => {
    const ya = newEntryFromUri('otpauth://yaotp/Yandex:user?secret=KJTEUGOD5SNXVWBCWJ4G36W4IA&pin=1234')
    expect(ya.type).toBe('yandex')
    expect(ya.pin).toBe('1234')
    const [line] = exportOtpauthText(vaultWith([ya])).split('\n')
    const back = parseOtpUri(line!)
    expect(back.type).toBe('yandex')
    expect(back.digits).toBe(8)
    expect(back.pin).toBe('1234')
  })
  it('空 vault 导出空串', () => {
    expect(exportOtpauthText(createVault())).toBe('')
  })
})
