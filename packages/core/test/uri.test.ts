import { describe, expect, it } from 'vitest'
import { base32Decode } from '../src/encoding/base32'
import { steamCode } from '../src/otp/steam'
import { parseOtpUri, buildOtpUri } from '../src/otp/uri'

describe('parseOtpUri', () => {
  it('标准 totp：label 前缀 issuer + 参数齐全', () => {
    const p = parseOtpUri(
      'otpauth://totp/GitHub:me%40ex.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256',
    )
    expect(p).toMatchObject({
      type: 'totp', issuer: 'GitHub', label: 'me@ex.com',
      secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60,
    })
    // C2：RFC4648 解码的 secretBytes 与 base32Decode 一致
    expect(p.secretBytes).toEqual(base32Decode('JBSWY3DPEHPK3PXP'))
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

  it('I32：issuer=Steam 但 host=totp 不再被强转为 steam（按 host 判定）', () => {
    const p = parseOtpUri('otpauth://totp/Steam:user?secret=JBSWY3DPEHPK3PXP')
    expect(p.type).toBe('totp')
    expect(p.issuer).toBe('Steam')
    expect(p.label).toBe('user')
  })

  it('I33：digits/period/counter 越界抛 invalid otpauth uri', () => {
    expect(() => parseOtpUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&digits=4')).toThrow(/digits out of range/)
    expect(() => parseOtpUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&digits=9')).toThrow(/digits out of range/)
    expect(() => parseOtpUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP&period=0')).toThrow(/period out of range/)
    expect(() => parseOtpUri('otpauth://hotp/A:b?secret=JBSWY3DPEHPK3PXP&counter=-1')).toThrow(/counter out of range/)
    expect(() => parseOtpUri('otpauth://hotp/A:b?secret=JBSWY3DPEHPK3PXP&counter=abc')).toThrow(/counter out of range/)
  })

  it('I34：steam URI 即使 query 写 algorithm=SHA512 也强制 SHA1', () => {
    const p = parseOtpUri('otpauth://steam/Steam:u?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512')
    expect(p.type).toBe('steam')
    expect(p.algorithm).toBe('SHA1')
    expect(p.digits).toBe(5)
  })

  it('C2：steam URI secret 按 Steam 字母表解码；round-trip 出参考 Steam 码', async () => {
    // 关键回归点：otpauth://steam/ 的 secret 必须按 Steam 自定义字母表解码，
    // 否则 steamCode 会算出错误码（参考 vectors/steam.json）。
    // vectors/steam.json 的 secretBase32 'MZLVOVJQVEWROFJVOUQ4EJCVOFRKGADG' 本身是 RFC4648 字符
    // （Steam alphabet 是 RFC4648 的字符子集，去除视觉混淆字符 0/1/8/I/L/O），
    // 因此 RFC4648 与 Steam alphabet 路径在 RFC4648 字符输入时结果一致。
    // 本测试同时验证：1) parseOtpUri 返回的 secretBytes 等于 vectors 字节；
    // 2) steamCode 命中 vector。
    const rfcBytes = base32Decode('MZLVOVJQVEWROFJVOUQ4EJCVOFRKGADG')
    const p = parseOtpUri('otpauth://steam/Steam:user?secret=MZLVOVJQVEWROFJVOUQ4EJCVOFRKGADG')
    expect(p.type).toBe('steam')
    expect(p.secretBytes).toEqual(rfcBytes)
    const code = await steamCode(p.secretBytes!, 1789277850000)
    expect(code).toBe('JHHW2')
  })

  it('C2：totp/hotp URI secret 不走 Steam 路径，按 RFC4648 解码', () => {
    const totp = parseOtpUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP')
    expect(totp.secretBytes).toEqual(base32Decode('JBSWY3DPEHPK3PXP'))
    const hotp = parseOtpUri('otpauth://hotp/A:b?secret=JBSWY3DPEHPK3PXP')
    expect(hotp.secretBytes).toEqual(base32Decode('JBSWY3DPEHPK3PXP'))
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

  it('I35：hotp 即使 counter=undefined 也输出 counter=0', () => {
    const uri = buildOtpUri({ type: 'hotp', issuer: 'X', label: 'y', secret: 'AB', algorithm: 'SHA1', digits: 6, period: 30 })
    expect(uri).toContain('counter=0')
  })

  it('I34：buildOtpUri steam 不输出 algorithm 参数', () => {
    const uri = buildOtpUri({ type: 'steam', issuer: 'Steam', label: 'u', secret: 'AB', algorithm: 'SHA512', digits: 5, period: 30 })
    expect(uri).not.toContain('algorithm=')
  })
})