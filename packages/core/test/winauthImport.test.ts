import { describe, expect, it } from 'vitest'
import { base32Decode } from '../src/encoding/base32'
import {
  blowfishEcbDecrypt,
  blowfishEcbEncrypt,
  buildWinauthSequence,
  deriveExplicitKey,
  importWinauth,
} from '../src/import/winauth'

// ---------- 测试工具 ----------
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const unhex = (s: string): Uint8Array => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)))
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const bytesToB64 = (bytes: Uint8Array): string => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

// 官方 secretdata 格式（Authenticator.cs SecretData 属性）：hex(SecretKey) + "\t" + digits + "\t" + HMAC + "\t" + period
// HOTP 再追加 "|counter"（HOTPAuthenticator.cs）
const SECRET = 'JBSWY3DPEHPK3PXP'
const SECRET_HEX = hex(base32Decode(SECRET))
const secretData = (digits = 6, hmac = 'SHA1', period = 30, counter?: number): string =>
  `${SECRET_HEX}\t${digits}\t${hmac}\t${period}${counter !== undefined ? `|${counter}` : ''}`

const ENTRY_XML = (name: string, sd: string, typeAttr = 'WinAuth.GoogleAuthenticator'): string =>
  `<WinAuthAuthenticator id="11111111-2222-3333-4444-555555555555" type="${typeAttr}">` +
  `<name>${name}</name><created>1600000000000</created><autorefresh>true</autorefresh>` +
  `<allowcopy>false</allowcopy><copyoncode>false</copyoncode><hideserial>true</hideserial><skin></skin>` +
  `<authenticatordata><servertimediff>0</servertimediff><lastservertime>0</lastservertime>` +
  `<secretdata>${sd}</secretdata></authenticatordata></WinAuthAuthenticator>`

// 明文 authenticatordata（构造 DPAPI 层的「明文」——官方 DPAPI 层明文恒为 hex ASCII）
const PLAIN_AUTH_DATA = (sd: string): string =>
  `<authenticatordata><servertimediff>0</servertimediff><lastservertime>0</lastservertime>` +
  `<secretdata>${sd}</secretdata></authenticatordata>`

// ---------- 非循环算法锚点：官方 Blowfish 测试向量 + RFC 6070 ----------
describe('blowfishEcbEncrypt/Decrypt（官方向量）', () => {
  const vectors: Array<[string, string, string]> = [
    ['0000000000000000', '0000000000000000', '4EF997456198DD78'],
    ['FFFFFFFFFFFFFFFF', 'FFFFFFFFFFFFFFFF', '51866FD5B85ECB8A'],
    ['FEDCBA9876543210', '0123456789ABCDEF', '0ACEAB0FC6A0A28D'],
  ]
  it.each(vectors)('key=%s pt=%s → ct=%s', (key, pt, ct) => {
    expect(hex(blowfishEcbEncrypt(unhex(key), unhex(pt)))).toBe(ct.toLowerCase())
    expect(hex(blowfishEcbDecrypt(unhex(key), unhex(ct)))).toBe(pt.toLowerCase())
  })
  it('ASCII key 变体（Schneier vectors）', () => {
    const key = utf8('abcdefghijklmnopqrstuvwxyz')
    expect(hex(blowfishEcbEncrypt(key, utf8('BLOWFISH')))).toBe('324ed0fef413a203')
  })
})

describe('deriveExplicitKey（PBKDF2-HMAC-SHA1，RFC 6070 向量）', () => {
  it('c=1 dkLen=20', async () => {
    expect(hex(await deriveExplicitKey('password', utf8('salt'), 20, 1))).toBe('0c60c80f961f0e71f3a9b524af6012062fe037a6')
  })
  it('c=4096 dkLen=20', async () => {
    expect(hex(await deriveExplicitKey('password', utf8('salt'), 20, 4096))).toBe(
      '4b007901b765489abead49d926f721d065a429c1',
    )
  })
})

// ---------- importWinauth ----------
describe('importWinauth 明文 entrydata', () => {
  it('官方 v3 XML 结构：GitHub:me@x.com', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><WinAuth version="3.6.4.2">${ENTRY_XML('GitHub:me@x.com', secretData())}</WinAuth>`
    const r = await importWinauth(xml)
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toEqual({ type: 'totp', issuer: 'GitHub', label: 'me@x.com', secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30 })
  })
  it('Steam 判定（type 属性）且 digits 强制 5', async () => {
    const xml = `<WinAuth version="3.6.4.2">${ENTRY_XML('Steam:player1', secretData(5), 'WinAuth.SteamAuthenticator')}</WinAuth>`
    const r = await importWinauth(xml)
    expect(r.entries[0]).toMatchObject({ type: 'steam', issuer: 'Steam', label: 'player1', digits: 5, secret: SECRET })
  })
  it('HOTP counter 解析', async () => {
    const xml = `<WinAuth version="3.6.4.2">${ENTRY_XML('HOTP:z', secretData(6, 'SHA1', 30, 42), 'WinAuth.HOTPAuthenticator')}</WinAuth>`
    const r = await importWinauth(xml)
    expect(r.entries[0]).toMatchObject({ type: 'hotp', counter: 42 })
  })
  it('非 WinAuth XML → 空结果', async () => {
    const r = await importWinauth('<?xml version="1.0"?><other/>')
    expect(r.entries).toHaveLength(0)
    expect(r.failures).toHaveLength(0)
  })
  it('非法 XML → 结构化错误', async () => {
    await expect(importWinauth('this is not xml')).rejects.toThrow('结构非法')
  })
})

describe('importWinauth DPAPI 条目', () => {
  it('配置级 data encrypted="u" 无 decryptDpapi → 逐条中文失败', async () => {
    const payloadHex = hex(utf8(`<config>${ENTRY_XML('GitHub:me@x.com', secretData())}</config>`))
    const seq = await buildWinauthSequence(payloadHex, 'u')
    const xml = `<WinAuth version="3.6.4.2"><data encrypted="u" sha1="deadbeef">${seq}</data></WinAuth>`
    const r = await importWinauth(xml)
    expect(r.entries).toHaveLength(0)
    expect(r.failures[0]!.message).toContain('桌面版')
  })
  it('条目级 authenticatordata encrypted="u" 无 decryptDpapi → 逐条中文失败', async () => {
    const payloadHex = hex(utf8(PLAIN_AUTH_DATA(secretData())))
    const seq = await buildWinauthSequence(payloadHex, 'u')
    const xml = `<WinAuth version="3.6.4.2"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>GitHub:me@x.com</name><authenticatordata encrypted="u">${seq}</authenticatordata></WinAuthAuthenticator></WinAuth>`
    const r = await importWinauth(xml)
    expect(r.entries).toHaveLength(0)
    expect(r.failures[0]!.message).toContain('桌面版')
  })
  it('配置级 + decryptDpapi stub 解开', async () => {
    const innerXml = `<config>${ENTRY_XML('GitHub:me@x.com', secretData())}</config>`
    const payloadHex = hex(utf8(innerXml))
    const seq = await buildWinauthSequence(payloadHex, 'u')
    const xml = `<WinAuth version="3.6.4.2"><data encrypted="u">${seq}</data></WinAuth>`
    const stub = async (b64: string): Promise<string> => {
      // 桌面端真实流程：CryptUnprotectData 的明文即本层 hex ASCII（官方 DecryptSequenceNoHash decode=false 路径）
      expect(b64).toBe(bytesToB64(unhex(payloadHex)))
      return new TextDecoder().decode(unhex(payloadHex))
    }
    const r = await importWinauth(xml, { decryptDpapi: stub })
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', secret: SECRET })
  })
  it('条目级 + decryptDpapi stub 解开', async () => {
    const payloadHex = hex(utf8(PLAIN_AUTH_DATA(secretData())))
    const seq = await buildWinauthSequence(payloadHex, 'u')
    const xml = `<WinAuth version="3.6.4.2"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>GitHub:me@x.com</name><authenticatordata encrypted="u">${seq}</authenticatordata></WinAuthAuthenticator></WinAuth>`
    const stub = async (b64: string): Promise<string> => {
      expect(b64).toBe(bytesToB64(unhex(payloadHex)))
      return new TextDecoder().decode(unhex(payloadHex))
    }
    const r = await importWinauth(xml, { decryptDpapi: stub })
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', secret: SECRET })
  })
})

describe('importWinauth 口令保护（官方算法：PBKDF2-SHA1×2000 + Blowfish/ISO10126）', () => {
  const pass = 'winauth-pass'
  it('条目级 encrypted="y"：无口令/错口令失败，对口令成功', async () => {
    const payloadHex = hex(utf8(PLAIN_AUTH_DATA(secretData())))
    const seq = await buildWinauthSequence(payloadHex, 'y', pass)
    const wrap = (s: string): string =>
      `<WinAuth version="3.6.4.2"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>GitHub:me@x.com</name><authenticatordata encrypted="y">${s}</authenticatordata></WinAuthAuthenticator></WinAuth>`
    const r0 = await importWinauth(wrap(seq))
    expect(r0.entries).toHaveLength(0)
    expect(r0.failures[0]!.message).toContain('需要口令或口令错误')
    const r1 = await importWinauth(wrap(seq), { password: 'wrong' })
    expect(r1.failures[0]!.message).toContain('需要口令或口令错误')
    const r2 = await importWinauth(wrap(seq), { password: pass })
    expect(r2.failures).toHaveLength(0)
    expect(r2.entries[0]).toMatchObject({ issuer: 'GitHub', secret: SECRET })
  })
  it('配置级 data encrypted="y"：对口令解开', async () => {
    const payloadHex = hex(utf8(`<config>${ENTRY_XML('Gitlab:ops@x.com', secretData(8))}</config>`))
    const seq = await buildWinauthSequence(payloadHex, 'y', pass)
    const xml = `<WinAuth version="3.6.4.2"><data encrypted="y">${seq}</data></WinAuth>`
    const r = await importWinauth(xml, { password: pass })
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: 'Gitlab', label: 'ops@x.com', digits: 8, secret: SECRET })
  })
})
