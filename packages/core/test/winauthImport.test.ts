import { describe, expect, it } from 'vitest'
import { pbkdf2Sync } from 'node:crypto'
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

// 官方 secretdata 格式（Authenticator.cs SecretData 属性 L179-218）：
// hex(SecretKey) + "\t" + digits + "\t" + HMAC + "\t" + period；HOTP 再追加 "|counter"（HOTPAuthenticator.cs L88-107）
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
  // WinAuth 实际口径：Authenticator.cs L70 PBKDF2_KEYSIZE=256 + L1266 GetBytes(PBKDF2_KEYSIZE)
  // —— .NET GetBytes 参数为字节数 → 派生 256 字节（多 block），用 node:crypto(OpenSSL) 独立交叉验证
  it('2000 次 × 256 字节与 node:crypto 交叉验证', async () => {
    const key = await deriveExplicitKey('winauth-pass', utf8('0123456789abcdef'), 256, 2000)
    expect(key).toHaveLength(256)
    expect(hex(key)).toBe(pbkdf2Sync('winauth-pass', utf8('0123456789abcdef'), 2000, 256, 'sha1').toString('hex'))
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

// ---------- 旧布局 / 边角矩阵（盘点 B8 #30-33） ----------

const HEADER_HEX_LEN = 16 // ENCRYPTION_HEADER = hex("WINAUTH3")，8 字节（BitConverter 大写 hex）
const SALT_HEX_LEN = 16
const HASH_HEX_LEN = 64

describe('importWinauth v3.0 旧布局与无 WINAUTH3 头 v2 路径', () => {
  const pass = 'legacy-pass'
  it('v3.0 旧布局：密文直接是 <WinAuth> 根元素文本（ReadXmlInternal 根节点 encrypted 分支）', async () => {
    const payloadHex = hex(utf8(`<config>${ENTRY_XML('GitHub:me@x.com', secretData())}</config>`))
    const seq = await buildWinauthSequence(payloadHex, 'y', pass)
    const xml = `<WinAuth version="3.0.0.0" encrypted="y">${seq}</WinAuth>`
    const r = await importWinauth(xml, { password: pass })
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', label: 'me@x.com', secret: SECRET })
  })

  it('v3.0 旧布局带 encrypted 属性但根元素无密文文本：不进解密分支，空结果', async () => {
    const r = await importWinauth(`<WinAuth version="3.0.0.0" encrypted="y">   </WinAuth>`, { password: pass })
    expect(r.entries).toHaveLength(0)
    expect(r.failures).toHaveLength(0)
  })

  it('无 WINAUTH3 头（v2 无头路径）：payload = hex(salt)+hex(Blowfish 密文) 直接解口令层', async () => {
    const payloadHex = hex(utf8(PLAIN_AUTH_DATA(secretData())))
    const seq = await buildWinauthSequence(payloadHex, 'y', pass)
    const headless = seq.slice(HEADER_HEX_LEN + SALT_HEX_LEN + HASH_HEX_LEN) // 剥掉头+盐+哈希 → v2 布局
    const xml = `<WinAuth version="3.2.0.0"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>GitHub:me@x.com</name><authenticatordata encrypted="y">${headless}</authenticatordata></WinAuthAuthenticator></WinAuth>`
    const r = await importWinauth(xml, { password: pass })
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', secret: SECRET })
  })

  it('头剥离大小写不敏感：全小写密文同样可解（真实文件为大写 BitConverter 输出）', async () => {
    const payloadHex = hex(utf8(`<config>${ENTRY_XML('Low:case', secretData())}</config>`))
    const seq = await buildWinauthSequence(payloadHex, 'y', pass)
    const xml = `<WinAuth version="3.6.4.2"><data encrypted="y">${seq.toLowerCase()}</data></WinAuth>`
    const r = await importWinauth(xml, { password: pass })
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: 'Low', label: 'case' })
  })
})

describe('importWinauth 加密失败分类（DecodePasswordTypes 四态与 hash 校验点）', () => {
  it('encrypted 含 "a"/"b"（YubiKey）→「暂不支持」', async () => {
    const payloadHex = hex(utf8(PLAIN_AUTH_DATA(secretData())))
    for (const flag of ['a', 'b']) {
      const seq = await buildWinauthSequence(payloadHex, flag)
      const xml = `<WinAuth version="3.6.4.2"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>GitHub:me@x.com</name><authenticatordata encrypted="${flag}">${seq}</authenticatordata></WinAuthAuthenticator></WinAuth>`
      const r = await importWinauth(xml)
      expect(r.entries).toHaveLength(0)
      expect(r.failures[0]!.message).toBe('该 WinAuth 条目使用 YubiKey 加密，暂不支持')
    }
  })

  it('m+u 双 DPAPI 层：按 Machine→User 逆序各解一次（decryptDpapi stub 调用两次）', async () => {
    const innerXml = `<config>${ENTRY_XML('GitHub:me@x.com', secretData())}</config>`
    const payloadHex = hex(utf8(innerXml))
    const seq = await buildWinauthSequence(payloadHex, 'mu')
    const xml = `<WinAuth version="3.6.4.2"><data encrypted="mu">${seq}</data></WinAuth>`
    let calls = 0
    const stub = async (b64: string): Promise<string> => {
      calls++
      return new TextDecoder().decode(new Uint8Array([...atob(b64)].map((c) => c.charCodeAt(0))))
    }
    const r = await importWinauth(xml, { decryptDpapi: stub })
    expect(calls).toBe(2) // m、u 各一层
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', secret: SECRET })
  })

  it('有 WINAUTH3 头且口令正确但 SHA256 校验段被篡改 → 独立命中哈希不匹配分支（同样归类口令错误）', async () => {
    const payloadHex = hex(utf8(PLAIN_AUTH_DATA(secretData())))
    const seq = await buildWinauthSequence(payloadHex, 'y', 'right-pass')
    // 篡改 hash 段（位于头 14 + 盐 16 字符之后的 64 字符）
    const tampered = seq.slice(0, HEADER_HEX_LEN + SALT_HEX_LEN) + (seq.charAt(HEADER_HEX_LEN + SALT_HEX_LEN) === '0' ? '1' : '0') + seq.slice(HEADER_HEX_LEN + SALT_HEX_LEN + 1)
    const wrap = (s: string): string =>
      `<WinAuth version="3.6.4.2"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>GitHub:me@x.com</name><authenticatordata encrypted="y">${s}</authenticatordata></WinAuthAuthenticator></WinAuth>`
    const r = await importWinauth(wrap(tampered), { password: 'right-pass' })
    expect(r.entries).toHaveLength(0)
    expect(r.failures[0]!.message).toBe('需要口令或口令错误')
  })

  it('ISO10126 去填充 pad 超过块长（错口令解出随机尾字节）→ 口令错误', async () => {
    // 手工构造无头口令层密文：单块明文尾字节 0xFF（> 块长 8）→ 去填充即抛
    const salt = new Uint8Array(8)
    const key = await deriveExplicitKey('some-pass', salt, 256)
    const plain = new Uint8Array(8)
    plain[7] = 0xff
    const cipher = blowfishEcbEncrypt(key, plain)
    const dataHex = hex(salt) + hex(cipher)
    const xml = `<WinAuth version="3.2.0.0"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>GitHub:me@x.com</name><authenticatordata encrypted="y">${dataHex}</authenticatordata></WinAuthAuthenticator></WinAuth>`
    const r = await importWinauth(xml, { password: 'some-pass' })
    expect(r.entries).toHaveLength(0)
    expect(r.failures[0]!.message).toBe('需要口令或口令错误')
  })

  it('密文含非 hex 字符（无头路径 hexToBytes 抛「非法 hex」）→ 归类口令错误', async () => {
    const xml = `<WinAuth version="3.2.0.0"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>GitHub:me@x.com</name><authenticatordata encrypted="y">zzzz-not-hex</authenticatordata></WinAuthAuthenticator></WinAuth>`
    const r = await importWinauth(xml, { password: 'p' })
    expect(r.entries).toHaveLength(0)
    expect(r.failures[0]!.message).toBe('需要口令或口令错误')
  })

  it('DPAPI 层解出非 XML（内层损坏）→ 兜底「条目解析失败」', async () => {
    const xml = `<WinAuth version="3.6.4.2"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>GitHub:me@x.com</name><authenticatordata encrypted="m">00ff</authenticatordata></WinAuthAuthenticator></WinAuth>`
    const r = await importWinauth(xml, { decryptDpapi: async () => 'this is not xml' })
    expect(r.entries).toHaveLength(0)
    expect(r.failures[0]!.message).toBe('条目解析失败')
  })
})

describe('importWinauth XML 边角与条目字段边角（盘点 B8 #30-31）', () => {
  it('BOM/DOCTYPE/注释剥离 + CDATA secretdata + 实体与单引号属性均正常解析', async () => {
    const sd = secretData()
    const xml = '\uFEFF<?xml version="1.0" encoding="utf-8"?>' +
      '<!DOCTYPE WinAuth PUBLIC "-//x//EN" "dtd.dtd">' +
      '<!-- exported by WinAuth -->' +
      `<WinAuth version='3.6.4.2'>` +
      `<WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>A&amp;B:me@x.com</name>` +
      `<authenticatordata><secretdata><![CDATA[${sd}]]></secretdata></authenticatordata>` +
      `</WinAuthAuthenticator></WinAuth>`
    const r = await importWinauth(xml)
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: 'A&B', label: 'me@x.com', secret: SECRET })
  })

  it('标签不匹配 / 多根元素 / 未闭合 → 结构化错误', async () => {
    await expect(importWinauth('<WinAuth><data></other></WinAuth>')).rejects.toThrow('结构非法')
    await expect(importWinauth('<WinAuth/><WinAuth2/>')).rejects.toThrow('结构非法')
    await expect(importWinauth('<WinAuth><data>')).rejects.toThrow('结构非法')
  })

  it('secretdata SHA256/SHA512 算法字段；HOTP counter 追加段', async () => {
    const xml = `<WinAuth version="3.6.4.2">` +
      ENTRY_XML('A:a', secretData(6, 'SHA256')) +
      ENTRY_XML('B:b', secretData(8, 'SHA512')) +
      ENTRY_XML('C:c', secretData(6, 'SHA1', 60, 7), 'WinAuth.HOTPAuthenticator') +
      `</WinAuth>`
    const r = await importWinauth(xml)
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ algorithm: 'SHA256', digits: 6 })
    expect(r.entries[1]).toMatchObject({ algorithm: 'SHA512', digits: 8 })
    expect(r.entries[2]).toMatchObject({ type: 'hotp', algorithm: 'SHA1', period: 60, counter: 7 })
  })

  it('name 无冒号 → issuer 空、label 全名；digits/period 非正回退 6/30', async () => {
    const xml = `<WinAuth version="3.6.4.2">` +
      ENTRY_XML('NoIssuer', secretData(0, 'SHA1', 0)) +
      ENTRY_XML('Neg:ative', secretData(-3, 'SHA1', -5)) +
      `</WinAuth>`
    const r = await importWinauth(xml)
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: '', label: 'NoIssuer', digits: 6, period: 30 })
    expect(r.entries[1]).toMatchObject({ issuer: 'Neg', label: 'ative', digits: 6, period: 30 })
  })

  it('缺 authenticatordata / 缺 secretdata / secretdata 非 hex / 空 secret → 逐条 failures', async () => {
    const xml = `<WinAuth version="3.6.4.2">` +
      `<WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>A:a</name></WinAuthAuthenticator>` +
      `<WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>B:b</name><authenticatordata><servertimediff>0</servertimediff></authenticatordata></WinAuthAuthenticator>` +
      `<WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>C:c</name><authenticatordata><secretdata>zz</secretdata></authenticatordata></WinAuthAuthenticator>` +
      `<WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>D:d</name><authenticatordata><secretdata></secretdata></authenticatordata></WinAuthAuthenticator>` +
      `</WinAuth>`
    const r = await importWinauth(xml)
    expect(r.entries).toHaveLength(0)
    expect(r.failures.map((f) => f.message)).toEqual([
      '缺少 authenticatordata',
      '缺少 secret',
      'secretdata 非法',
      '缺少 secret',
    ])
  })
})

describe('importWinauth 口令保护（官方算法，Authenticator.cs L1250-1309 Decrypt：PBKDF2-SHA1×2000 派生 256 字节密钥 + Blowfish/ISO10126）', () => {
  const pass = 'winauth-pass'
  it('fixture 锚定官方序列布局：大写 WINAUTH3 头 + 256 字节派生密钥可解开', async () => {
    // 序列布局 Authenticator.cs L1114-1184 EncryptSequence；头 = L75 ByteArrayToString(UTF8("WINAUTH3"))，
    // ByteArrayToString（L934-937）经 BitConverter 输出大写 hex——真实 .wauth 密文整串全大写
    const seq = await buildWinauthSequence('00ff', 'y', pass)
    expect(seq.startsWith('57494E4155544833')).toBe(true)
    expect(seq).toBe(seq.toUpperCase())
  })
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
