import { describe, expect, it } from 'vitest'
import { parseOtpUri, buildOtpUri } from '../src/otp/uri'

describe('parseOtpUri', () => {
  it('标准 totp：label 前缀 issuer + 参数齐全', () => {
    const p = parseOtpUri(
      'otpauth://totp/GitHub:me%40ex.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256',
    )
    expect(p).toEqual({
      type: 'totp', issuer: 'GitHub', label: 'me@ex.com',
      secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60,
    })
  })

  it('issuer 参数缺失时取 label 前缀', () => {
    const p = parseOtpUri('otpauth://totp/MyBank:alice?secret=JBSWY3DPEHPK3PXP')
    expect(p.issuer).toBe('MyBank')
    expect(p.label).toBe('alice')
  })

  it('otpauth://steam/ 判为 steam', () => {
    const p = parseOtpUri('otpauth://steam/Steam:user?secret=JBSWY3DPEHPK3PXP')
    expect(p.type).toBe('steam')
    expect(p.issuer).toBe('Steam')
  })

  it('hotp 带 counter', () => {
    const p = parseOtpUri('otpauth://hotp/x:y?secret=JBSWY3DPEHPK3PXP&counter=5')
    expect(p.type).toBe('hotp')
    expect(p.counter).toBe(5)
  })

  it.each([
    'https://example.com',
    'otpauth://totp/x?secret=',
    'otpauth://zzz/x?secret=AB',
    'otpauth://totp/a%ZZb?secret=JBSWY3DPEHPK3PXP',
  ])('非法输入 %s 抛错', (uri) => {
    expect(() => parseOtpUri(uri)).toThrow('invalid otpauth uri')
  })

  it('大写 host 按 RFC3986 大小写不敏感归一化', () => {
    const p = parseOtpUri('otpauth://TOTP/MyBank:alice?secret=JBSWY3DPEHPK3PXP')
    expect(p.type).toBe('totp')
    expect(p.issuer).toBe('MyBank')
    expect(p.label).toBe('alice')
  })
})

describe('buildOtpUri', () => {
  it('往返一致', () => {
    const uri = buildOtpUri({
      type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256', digits: 8, period: 60,
    })
    expect(parseOtpUri(uri)).toMatchObject({
      type: 'totp', issuer: 'GitHub', label: 'me@ex.com',
      secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60,
    })
  })

  it('steam 生成 otpauth://steam/', () => {
    const uri = buildOtpUri({ type: 'steam', issuer: 'Steam', label: 'user', secret: 'AB', algorithm: 'SHA1', digits: 5, period: 30 })
    expect(uri).toContain('otpauth://steam/')
  })
})
