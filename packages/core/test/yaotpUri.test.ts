import { describe, expect, it } from 'vitest'
import { buildOtpUri, parseOtpUri } from '@totp/core'

describe('yaotp URI（uri.ts 扩展）', () => {
  it('host yaotp → type yandex，默认 SHA256/8 位，pin 参数读取', () => {
    const p = parseOtpUri('otpauth://yaotp/Yandex:user?secret=JBSWY3DPEHPK3PXP&pin=1234')
    expect(p.type).toBe('yandex')
    expect(p.algorithm).toBe('SHA256')
    expect(p.digits).toBe(8)
    expect(p.pin).toBe('1234')
  })
  it('yandex 无 query algorithm/digits 时取默认；显式白名单 algorithm 仍覆盖', () => {
    const bare = parseOtpUri('otpauth://yaotp/Yandex:user?secret=JBSWY3DPEHPK3PXP')
    expect(bare.algorithm).toBe('SHA256')
    expect(bare.digits).toBe(8)
    expect(bare.pin).toBeUndefined()
    const explicit = parseOtpUri('otpauth://yaotp/Yandex:user?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512')
    expect(explicit.algorithm).toBe('SHA512')
    // 非 SHA1/SHA256/SHA512 的显式值回落 yandex 默认 SHA256
    const junk = parseOtpUri('otpauth://yaotp/Yandex:user?secret=JBSWY3DPEHPK3PXP&algorithm=MD5')
    expect(junk.algorithm).toBe('SHA256')
  })
  it('buildOtpUri：yandex → host yaotp，默认 SHA256/8 不写出，pin 参与回写', () => {
    const uri = buildOtpUri({ type: 'yandex', issuer: 'Yandex', label: 'user', secret: 'KJTEUGOD5SNXVWBCWJ4G36W4IA', algorithm: 'SHA256', digits: 8, period: 30, pin: '1234' })
    expect(uri.startsWith('otpauth://yaotp/')).toBe(true)
    expect(uri).toContain('pin=1234')
    expect(uri).not.toContain('algorithm=')
    expect(uri).not.toContain('digits=')
    const back = parseOtpUri(uri)
    expect(back.type).toBe('yandex')
    expect(back.algorithm).toBe('SHA256')
    expect(back.digits).toBe(8)
    expect(back.pin).toBe('1234')
  })
  it('buildOtpUri：非默认 algorithm/digits/period 仍写出并 round-trip', () => {
    const uri = buildOtpUri({ type: 'yandex', issuer: 'Yandex', label: 'user', secret: 'KJTEUGOD5SNXVWBCWJ4G36W4IA', algorithm: 'SHA512', digits: 8, period: 60 })
    expect(uri).toContain('algorithm=SHA512')
    expect(uri).toContain('period=60')
    const back = parseOtpUri(uri)
    expect(back.algorithm).toBe('SHA512')
    expect(back.period).toBe(60)
  })
  it('M6：pin 仅 yandex host 读取；totp URI 携带 pin 参数不产出（文档-行为对齐）', () => {
    const totp = parseOtpUri('otpauth://totp/G:user?secret=JBSWY3DPEHPK3PXP&pin=9999')
    expect(totp.pin).toBeUndefined()
  })
  it('既有 totp/hotp/steam URI 行为不回归（默认与 host 映射不变）', () => {
    const totp = parseOtpUri('otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP')
    expect(totp.algorithm).toBe('SHA1')
    expect(totp.digits).toBe(6)
    const steam = parseOtpUri('otpauth://steam/Valve:user?secret=JBSWY3DPEHPK3PXP')
    expect(steam.type).toBe('steam')
    expect(steam.digits).toBe(5)
    expect(steam.algorithm).toBe('SHA1')
    const steamUri = buildOtpUri({ type: 'steam', issuer: 'Valve', label: 'user', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 5, period: 30 })
    expect(steamUri.startsWith('otpauth://steam/')).toBe(true)
    expect(steamUri).not.toContain('digits=')
    // 非法 host 仍拒绝（yaotp 之外的新 host 不放行）
    expect(() => parseOtpUri('otpauth://ya0tp/X:user?secret=JBSWY3DPEHPK3PXP')).toThrow()
  })
})
