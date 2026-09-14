import { describe, expect, it } from 'vitest'
import type { OtpEntry } from '@totp/core'
import { parseUriToEntryData } from '../src/otpauthFlow'

describe('parseUriToEntryData', () => {
  it('标准 totp：映射为 OtpEntry 形状预填对象（哑值 uuid/order/createdAt）', () => {
    const r = parseUriToEntryData(
      'otpauth://totp/GitHub:me%40ex.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256',
    )
    if (!('data' in r)) throw new Error('应解析成功')
    expect(r.data).toEqual({
      uuid: '', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256', digits: 8, period: 60,
      note: '', groupIds: [], matchRules: [], order: 0, createdAt: 0,
    })
    const initial: OtpEntry = r.data // 可直接作 EntryForm initial
    expect(initial.uuid).toBe('')
  })

  it('otpauth://steam/：type=steam 且 digits 固定 5', () => {
    const r = parseUriToEntryData('otpauth://steam/Steam:user?secret=JBSWY3DPEHPK3PXP')
    if (!('data' in r)) throw new Error('应解析成功')
    expect(r.data.type).toBe('steam')
    expect(r.data.digits).toBe(5)
    expect(r.data.algorithm).toBe('SHA1')
  })

  it('hotp：携带 counter', () => {
    const r = parseUriToEntryData('otpauth://hotp/x:y?secret=JBSWY3DPEHPK3PXP&counter=5')
    if (!('data' in r)) throw new Error('应解析成功')
    expect(r.data.type).toBe('hotp')
    expect(r.data.counter).toBe(5)
  })

  it('issuer 参数缺失时取 label 前缀', () => {
    const r = parseUriToEntryData('otpauth://totp/MyBank:alice?secret=JBSWY3DPEHPK3PXP')
    if (!('data' in r)) throw new Error('应解析成功')
    expect(r.data.issuer).toBe('MyBank')
    expect(r.data.label).toBe('alice')
  })

  it.each([
    '',
    'https://example.com',
    'otpauth://totp/x?secret=',
    'otpauth://zzz/x?secret=AB',
  ])('非法输入 %j → 中文错误', (uri) => {
    const r = parseUriToEntryData(uri)
    expect('error' in r ? r.error : undefined).toBe('不是有效的 otpauth 链接')
  })
})
