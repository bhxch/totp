import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode } from '../src/encoding/base32'
import {
  importAndOtp,
  importFreeOtp,
  importFreeOtpLegacy,
  importTotpAuthenticator,
} from '../src/import/miscApps'
import { sniffFormat } from '../src/import/sniff'

const SECRET = 'JBSWY3DPEHPK3PXP'
const SECRET_BYTES = base32Decode(SECRET)

// Java byte（有符号）序列化口径：FreeOtpImporter.java toBytes —— (byte) array.getInt(i) 取低 8 位
const signedBytes = (bytes: Uint8Array): number[] => Array.from(bytes, (b) => (b << 24) >> 24)

// ---------- FreeOTP+（FreeOtpPlusImporter.java → FreeOtpImporter.DecryptedStateV1.convertEntry：
// tokens[].secret 为有符号字节数组（Gson byte[]），issuerExt→issuer、label→label；简报猜测的
// "params 池索引/secret 为 base64" 与源码不符，见 task-2-report 差异清单） ----------
describe('importFreeOtp（FreeOTP+ JSON 导出）', () => {
  it('HOTP/TOTP/Steam 解析：secret 字节数组→base32、issuerExt→issuer、algo/digits/period 缺省与 null 回退', () => {
    const text = JSON.stringify({
      tokenOrder: ['WWE:Mason', 'Steam:Elijah', 'Deno:Mason', 'Null:Algo'],
      tokens: [
        {
          algo: 'SHA256', counter: 49, digits: 7, issuerExt: 'WWE', issuerInt: 'WWE',
          label: 'Benjamin', period: 30, secret: signedBytes(SECRET_BYTES), type: 'HOTP',
        },
        {
          algo: 'SHA512', counter: 0, digits: 8, issuerExt: 'Steam', issuerInt: 'Steam',
          label: 'Elijah', period: 50, secret: signedBytes(SECRET_BYTES), type: 'TOTP',
        },
        { counter: 0, digits: 6, issuerExt: 'Deno', label: 'Mason', period: 30, secret: signedBytes(SECRET_BYTES), type: 'TOTP' },
        { algo: null, counter: 0, issuerExt: 'Null', label: 'Algo', secret: signedBytes(SECRET_BYTES), type: 'totp' },
      ],
    })
    const r = importFreeOtp(text)
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({
      type: 'hotp', issuer: 'WWE', label: 'Benjamin', secret: SECRET, algorithm: 'SHA256', digits: 7, counter: 49, period: 30,
    })
    // issuerExt === 'Steam' → steam（本仓库口径 digits=5，对齐 jsonApps steamEntry）
    expect(r.entries[1]).toMatchObject({ type: 'steam', issuer: 'Steam', label: 'Elijah', digits: 5, period: 30 })
    // algo/digits/period 缺省 → SHA1/6/30（FreeOtpImporter.java optString/optInt 默认值）
    expect(r.entries[2]).toMatchObject({ type: 'totp', issuer: 'Deno', label: 'Mason', secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30 })
    expect(r.entries[3]).toMatchObject({ type: 'totp', issuer: 'Null', algorithm: 'SHA1', digits: 6, period: 30 })
  })

  it('坏条目不阻断：缺 issuerExt / secret 非字节数组 / 未知 type / HOTP 缺 counter / 空 secret', () => {
    const text = JSON.stringify({
      tokens: [
        { label: 'noIssuer', secret: signedBytes(SECRET_BYTES), type: 'TOTP' },
        { issuerExt: 'badSecret', label: 'x', secret: 'JBSWY3DP', type: 'TOTP' },
        { issuerExt: 'badType', label: 'x', secret: signedBytes(SECRET_BYTES), type: 'MOTP' },
        { issuerExt: 'noCounter', label: 'x', secret: signedBytes(SECRET_BYTES), type: 'HOTP' },
        { issuerExt: 'empty', label: 'x', secret: [], type: 'TOTP' },
        { issuerExt: 'ok', label: 'ok', secret: signedBytes(SECRET_BYTES), type: 'TOTP', period: 60, digits: 8 },
      ],
    })
    const r = importFreeOtp(text)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ issuer: 'ok', digits: 8, period: 60 })
    expect(r.failures.map((f) => f.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('结构级错误：非 JSON / 顶层非对象 / 缺 tokens 数组', () => {
    expect(() => importFreeOtp('not json')).toThrow(/FreeOTP\+/)
    expect(() => importFreeOtp('[1,2]')).toThrow(/FreeOTP\+/)
    expect(() => importFreeOtp('{"foo": 1}')).toThrow(/tokens/)
  })
})

// ---------- 旧版 FreeOTP（FreeOtpImporter.readV1：shared_prefs/tokens.xml，
// <string name="..."> 值为实体转义的 Gson token JSON，跳过 tokenOrder） ----------
describe('importFreeOtpLegacy（旧版 FreeOTP tokens.xml）', () => {
  const xmlEntry = (name: string, json: Record<string, unknown>): string =>
    `<string name="${name}">${JSON.stringify(json)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')}</string>`

  it('转义 JSON 逐条解析并跳过 tokenOrder 与非 string 项', () => {
    const xml = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n` +
      xmlEntry('WWE:Mason', { algo: 'SHA512', counter: 10299, digits: 8, issuerExt: 'WWE', label: 'Mason', period: 30, secret: signedBytes(SECRET_BYTES), type: 'HOTP' }) + '\n' +
      '    <int name="RATE_US_COUNTER" value="13" />\n' +
      xmlEntry('tokenOrder', ['WWE:Mason'] as unknown as Record<string, unknown>) + '\n' +
      xmlEntry('Deno:Mason', { issuerExt: 'Deno', label: 'Mason', period: 50, secret: signedBytes(SECRET_BYTES), type: 'TOTP' }) + '\n' +
      '</map>'
    const r = importFreeOtpLegacy(xml)
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({ type: 'hotp', issuer: 'WWE', label: 'Mason', secret: SECRET, algorithm: 'SHA512', digits: 8, counter: 10299 })
    expect(r.entries[1]).toMatchObject({ type: 'totp', issuer: 'Deno', label: 'Mason', period: 50 })
  })

  it('坏条目不阻断（JSON 损坏进 failures）；非 XML 输入抛结构级错误', () => {
    const xml = `<map>\n<string name="bad">{oops</string>\n` +
      xmlEntry('Ok:Ok', { issuerExt: 'Ok', label: 'Ok', secret: signedBytes(SECRET_BYTES), type: 'TOTP' }) + '\n</map>'
    const r = importFreeOtpLegacy(xml)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ issuer: 'Ok' })
    expect(r.failures).toHaveLength(1)
    expect(() => importFreeOtpLegacy('{"tokens": []}')).toThrow(/XML/)
  })
})

// ---------- TOTP Authenticator（TotpAuthenticatorImporter.java：
// 外部分享 = Base64(AES-CBC(SHA-256(口令), IV=0, PKCS5))，明文为「首键即条目数组 JSON 串」的对象；
// 内部/解密态条目 {base:16|32|64, key, name?, issuer?}，固定 totp/SHA1/6/30） ----------
describe('importTotpAuthenticator', () => {
  // TotpAuthenticatorImporter.decrypt：解出 JSON 对象后取 names()[0]（即条目数组的 JSON 字符串）
  const buildBin = async (entries: unknown[], password: string): Promise<string> => {
    const outer = JSON.stringify({ [JSON.stringify(entries)]: '' })
    const iv = new Uint8Array(16) // WARNING 注释下方的全零 IV
    const keyBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password)))
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt'])
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, new TextEncoder().encode(outer)))
    let s = ''
    for (const b of ct) s += String.fromCharCode(b)
    return btoa(s)
  }

  it('明文条目数组：base 16/32/64 三种编码，label 取 name、issuer 取 issuer，固定 totp/SHA1/6/30', async () => {
    const r = await importTotpAuthenticator(
      JSON.stringify([
        { base: 32, key: SECRET, issuer: 'GitHub', name: 'me@x.com', digits: '6' },
        // base16 样本取自 Aegis 官方 fixture totp_authenticator_internal.xml（key 为 hex）
        { base: 16, key: 'e49270f0d21f365c8408f8b475c5e20d', issuer: 'Deno', name: 'Mason' },
        { base: 64, key: 'q83v', name: 'B64Only' },
      ]),
    )
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'me@x.com', secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30 })
    expect(r.entries[1]).toMatchObject({ type: 'totp', issuer: 'Deno', label: 'Mason', secret: '4SJHB4GSD43FZBAI7C2HLRPCBU======' })
    expect(r.entries[2]).toMatchObject({ type: 'totp', issuer: '', label: 'B64Only', secret: base32Encode(new Uint8Array([0xab, 0xcd, 0xef])) })
  })

  it('坏条目不阻断：非法 base / 缺 key / 非法编码内容', async () => {
    const r = await importTotpAuthenticator(
      JSON.stringify([
        { base: 10, key: 'zz', issuer: 'x' },
        { base: 32, issuer: 'x' },
        { base: 32, key: '1', issuer: 'x' },
        { base: 32, key: SECRET, issuer: 'ok', name: 'ok' },
      ]),
    )
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ issuer: 'ok' })
    expect(r.failures.map((f) => f.index)).toEqual([0, 1, 2])
  })

  it('加密分享文件：口令解密（默认口令 TotpAuthenticator）、自定义口令、错口令中文报错', async () => {
    const entries = [{ base: 32, key: SECRET, issuer: 'GitHub', name: 'me@x.com' }]
    // 默认口令（Aegis 对话框「否」路径的硬编码 PASSWORD）
    const defaultBin = await buildBin(entries, 'TotpAuthenticator')
    const r1 = await importTotpAuthenticator(defaultBin)
    expect(r1.failures).toEqual([])
    expect(r1.entries[0]).toMatchObject({ issuer: 'GitHub', label: 'me@x.com', secret: SECRET })
    // 自定义口令（Aegis 测试 TotpAuthenticatorImporterTest 用 "Testtest1"）
    const r2 = await importTotpAuthenticator(await buildBin(entries, 'Testtest1'), 'Testtest1')
    expect(r2.entries[0]).toMatchObject({ issuer: 'GitHub' })
    // 口令错误 → 中文错误
    await expect(importTotpAuthenticator(await buildBin(entries, 'Testtest1'), 'wrong')).rejects.toThrow(/口令错误/)
    // 非 base64 → 结构级错误
    await expect(importTotpAuthenticator('not base64!!!')).rejects.toThrow(/base64/)
  })
})

// ---------- andOTP（AndOtpImporter.java DecryptedState：明文为顶层 JSON 数组（简报猜测的
// {entries:[...]} 与源码不符）；type/algorithm/digits/secret 为必需字段，issuer 存在则
// label=issuer+label 否则按 " - " 拆分；加密备份为二进制 AES-256-GCM（非 fernet），文本管道不支持） ----------
describe('importAndOtp', () => {
  it('TOTP/HOTP/Steam：issuer 存在取 label/issuer、缺失按 " - " 拆分、Steam period 缺省 30', () => {
    const text = JSON.stringify([
      { secret: SECRET + '======', issuer: 'Deno', label: 'Mason', digits: 6, type: 'TOTP', algorithm: 'SHA1', period: 30, tags: [] },
      { secret: SECRET, issuer: 'SPDX', label: 'James', digits: 7, type: 'TOTP', algorithm: 'SHA256', period: 20 },
      { secret: SECRET, issuer: 'Issuu', label: 'James', digits: 6, type: 'HOTP', algorithm: 'SHA1', counter: 1 },
      { secret: SECRET, label: 'Airbnb - Elijah', digits: 8, type: 'TOTP', algorithm: 'SHA512', period: 50 },
      { secret: SECRET, label: 'Steam only', digits: 8, type: 'STEAM', algorithm: 'SHA1' },
    ])
    const r = importAndOtp(text)
    expect(r.failures).toEqual([])
    // secret 原样保留（normalizeSecret 不去 padding，与 jsonApps 2FAS 口径一致）
    expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'Deno', label: 'Mason', secret: SECRET + '======', algorithm: 'SHA1', digits: 6, period: 30 })
    expect(r.entries[1]).toMatchObject({ type: 'totp', issuer: 'SPDX', label: 'James', algorithm: 'SHA256', digits: 7, period: 20 })
    expect(r.entries[2]).toMatchObject({ type: 'hotp', issuer: 'Issuu', label: 'James', counter: 1, period: 30 })
    expect(r.entries[3]).toMatchObject({ type: 'totp', issuer: 'Airbnb', label: 'Elijah', algorithm: 'SHA512', digits: 8, period: 50 })
    expect(r.entries[4]).toMatchObject({ type: 'steam', issuer: '', label: 'Steam only', digits: 5, period: 30 })
  })

  it('坏条目不阻断：缺 type/algorithm/digits/period(TOTP)/counter(HOTP)/secret、未知 type、非法 base32', () => {
    const text = JSON.stringify([
      { label: 'noType', secret: SECRET, digits: 6, algorithm: 'SHA1', period: 30 },
      { type: 'TOTP', label: 'noAlgo', secret: SECRET, digits: 6, period: 30 },
      { type: 'TOTP', label: 'noDigits', secret: SECRET, algorithm: 'SHA1', period: 30 },
      { type: 'TOTP', label: 'noPeriod', secret: SECRET, digits: 6, algorithm: 'SHA1' },
      { type: 'HOTP', label: 'noCounter', secret: SECRET, digits: 6, algorithm: 'SHA1' },
      { type: 'TOTP', label: 'noSecret', digits: 6, algorithm: 'SHA1', period: 30 },
      { type: 'MOTP', label: 'badType', secret: SECRET, digits: 6, algorithm: 'SHA1', period: 30 },
      { type: 'TOTP', label: 'badSecret', secret: 'totp123', digits: 6, algorithm: 'SHA1', period: 30 },
      // issuer 键存在但 label 缺失（AndOtpImporter.java：getString("label") 抛错 → 单条失败）
      { type: 'TOTP', secret: SECRET, digits: 6, algorithm: 'SHA1', period: 30, issuer: 'x' },
      { type: 'TOTP', label: 'ok', secret: SECRET, digits: 6, algorithm: 'SHA1', period: 60 },
    ])
    const r = importAndOtp(text)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ issuer: '', label: 'ok', period: 60 })
    expect(r.failures.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('结构级错误：顶层非数组 / 加密备份（非 JSON 数组输入）明确报暂不支持', () => {
    expect(() => importAndOtp('{"entries": []}')).toThrow(/数组/)
    expect(() => importAndOtp('not json')).toThrow(/加密/)
    // 模拟二进制加密备份被文本管道读入（迭代数头 + 随机字节）
    expect(() => importAndOtp('\u0000\u0000\u03e8\u0000saltnonces....')).toThrow(/加密/)
  })
})

// ---------- sniffFormat 扩展 ----------
describe('sniffFormat misc app 格式扩展', () => {
  it('FreeOTP+/andOTP/TotpAuthenticator/旧版 FreeOTP 特征判定', () => {
    // FreeOTP+：tokens 数组且存在条目 issuerExt 字符串 + secret 字节数组
    expect(
      sniffFormat(JSON.stringify({ tokenOrder: [], tokens: [{ issuerExt: 'A', secret: [1, -2], type: 'TOTP' }] })),
    ).toBe('freeOtp')
    // andOTP：JSON 数组且存在条目含 type/algorithm/label/secret 字符串
    expect(sniffFormat(JSON.stringify([{ type: 'TOTP', algorithm: 'SHA1', label: 'a', secret: SECRET }]))).toBe('andOtp')
    // Totp Authenticator 明文数组：条目含 base 整数 + key 字符串
    expect(sniffFormat(JSON.stringify([{ base: 32, key: SECRET, issuer: 'x' }]))).toBe('totpAuthenticator')
    // 旧版 FreeOTP tokens.xml
    expect(sniffFormat('<map><string name="tokenOrder">[{}]</string></map>')).toBe('freeOtpLegacy')
    expect(sniffFormat('<map><string name="0">{&quot;issuerExt&quot;:&quot;A&quot;}</string></map>')).toBe('freeOtpLegacy')
  })

  it('既有判定不回退；无特征不强判', () => {
    expect(sniffFormat('[{"secret":"JBSWY3DPEHPK3PXP"}]')).toBe('generic')
    expect(sniffFormat('{"tokens": [{}, 1]}')).toBe('generic')
    expect(sniffFormat('[{"type":"TOTP","secret":"X"}]')).toBe('generic')
    expect(sniffFormat('<?xml version="1.0"?><WinAuth>…</WinAuth>')).toBe('winauth')
    expect(sniffFormat('<map><string name="other">x</string></map>')).toBeNull()
    expect(sniffFormat('{"db": {"entries": []}}')).toBe('aegis')
    expect(sniffFormat(`otpauth://totp/a?secret=${SECRET}`)).toBe('uriBatch')
  })
})
