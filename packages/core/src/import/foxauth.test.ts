import { beforeAll, describe, expect, it } from 'vitest'
import { importFoxauth } from './jsonApps'

const plaintext = JSON.stringify({
  accountInfos: [
    { localIssuer: 'GitHub', localAccountName: 'a@b.c', localSecretToken: 'JBSWY3DPEHPK3PXP', localOTPType: 'Time based', localOTPDigits: '6', localOTPPeriod: '30' },
    { localIssuer: 'Battle.net', localAccountName: 'player1', localSecretToken: 'JBSWY3DPEHPK3PXP', localOTPType: 'Counter based', localOTPDigits: '8' },
    { localIssuer: '坏条目', localAccountName: 'x', localSecretToken: '!!not-base32!!', localOTPType: 'Time based' },
  ],
  isEncrypted: false,
})

describe('importFoxauth 明文', () => {
  it('字段映射与缺省口径', async () => {
    const r = await importFoxauth(plaintext)
    expect(r.entries).toHaveLength(2)
    expect(r.failures).toHaveLength(1)
    const [gh, bnet] = r.entries
    expect(gh).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'a@b.c', algorithm: 'SHA1', digits: 6, period: 30 })
    expect(bnet).toMatchObject({ type: 'hotp', issuer: 'Battle.net', digits: 8, counter: 0 })
  })

  it('结构级错误：非对象/缺 accountInfos/空数组', async () => {
    await expect(importFoxauth('[]')).rejects.toThrow(/顶层不是 JSON 对象/)
    await expect(importFoxauth('{}')).rejects.toThrow(/accountInfos/)
    await expect(importFoxauth(JSON.stringify({ accountInfos: [], isEncrypted: false }))).rejects.toThrow(/无条目/)
  })

  it('加密备份未给口令：明确报错', async () => {
    await expect(importFoxauth(JSON.stringify({ accountInfos: 'CIPHER', isEncrypted: true, passwordInfo: {} })))
      .rejects.toThrow(/加密/)
  })
})

// ---------- 加密备份（参数严格按 spec「加密参数附录」，与 FoxAuth keychain.js/MessageEncryption.js 同口径） ----------
// 口令 latin1 字节（逐字符 charCode）→ HKDF-SHA-256（salt 空 0 字节，info = UTF-8("encryption")）
// 派生 128bit AES-GCM key → 加密（tag 128bit，无 AAD）→ 密文逐字节 String.fromCharCode 存二进制字符串。
// IV 不在密文内，由 encryptIV 字段携带；向量程序化构造保证可复现，不硬编码来历不明密文。
async function foxauthTestKey(password: string): Promise<CryptoKey> {
  const rawSecret = Uint8Array.from(password, (c) => c.charCodeAt(0))
  const base = await crypto.subtle.importKey('raw', rawSecret as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0) as BufferSource, info: new TextEncoder().encode('encryption') },
    base,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt'],
  )
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return s
}

async function foxauthTestEncrypt(key: CryptoKey, iv: Uint8Array, plain: string): Promise<string> {
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 }, key, new TextEncoder().encode(plain)),
  )
  return bytesToBinaryString(cipher)
}

const FOXAUTH_IV = Uint8Array.from([103, 22, 171, 5, 240, 91, 9, 77, 66, 199, 34, 13])

describe('importFoxauth 加密备份（整串密文形态）', () => {
  let encryptedFixture: string
  beforeAll(async () => {
    // 整串密文：accountInfos = 密文二进制字符串，解密后为条目数组 JSON（spec 附录 Task 4 口径）
    const accountInfosJson = JSON.stringify([
      { localIssuer: 'GitHub', localAccountName: 'a@b.c', localSecretToken: 'JBSWY3DPEHPK3PXP', localOTPType: 'Time based', localOTPDigits: '6', localOTPPeriod: '30' },
    ])
    const key = await foxauthTestKey('test-password')
    encryptedFixture = JSON.stringify({
      accountInfos: await foxauthTestEncrypt(key, FOXAUTH_IV, accountInfosJson),
      isEncrypted: true,
      passwordInfo: { encryptPassword: btoa('test-password'), encryptIV: Array.from(FOXAUTH_IV) },
    })
  })

  it('正确口令解密导入：与明文同结果', async () => {
    const r = await importFoxauth(encryptedFixture, 'test-password')
    expect(r.entries).toHaveLength(1)
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'a@b.c', algorithm: 'SHA1', digits: 6, period: 30 })
  })

  it('错误口令：结构级报错（口令错误或文件已损坏）', async () => {
    await expect(importFoxauth(encryptedFixture, 'wrong-password')).rejects.toThrow('FoxAuth 备份解密失败：口令错误或文件已损坏')
  })

  it('encryptIV 缺失：结构级报错（不进入解密）', async () => {
    const fixture = JSON.stringify({ accountInfos: 'CIPHER', isEncrypted: true, passwordInfo: { encryptPassword: btoa('test-password') } })
    await expect(importFoxauth(fixture, 'test-password')).rejects.toThrow(/encryptIV/)
  })

  it('encryptPassword 非法 Base64：中文结构级报错', async () => {
    const fixture = JSON.stringify({ accountInfos: 'CIPHER', isEncrypted: true, passwordInfo: { encryptPassword: '!!not-b64!!', encryptIV: Array.from(FOXAUTH_IV) } })
    await expect(importFoxauth(fixture, 'test-password')).rejects.toThrow(/不是合法 Base64/)
  })
})

describe('importFoxauth 加密备份（真实导出形态：数组 + 逐字段密文）', () => {
  // FoxAuth sync.js exportBtn = storage.local 全量 dump；accountInfo.js __encryptAndDecrypt
  // 仅加密各条目的 localAccountName/localSecretToken/localRecovery 三字段，其余保持明文
  let encryptedFixture: string
  beforeAll(async () => {
    const key = await foxauthTestKey('test-password')
    const rows: Array<Record<string, unknown>> = [
      { localIssuer: 'GitHub', localAccountName: 'a@b.c', localSecretToken: 'JBSWY3DPEHPK3PXP', localOTPType: 'Time based', localOTPDigits: '6', localOTPPeriod: '30' },
      { localIssuer: 'Battle.net', localAccountName: 'player1', localSecretToken: 'JBSWY3DPEHPK3PXP', localOTPType: 'Counter based', localOTPDigits: '8' },
      { localIssuer: '坏条目', localAccountName: 'x', localSecretToken: '!!not-base32!!', localOTPType: 'Time based' },
    ]
    const accountInfos = await Promise.all(rows.map(async (row) => {
      const out = { ...row }
      for (const k of ['localAccountName', 'localSecretToken', 'localRecovery'] as const) {
        out[k] = await foxauthTestEncrypt(key, FOXAUTH_IV, typeof out[k] === 'string' ? (out[k] as string) : '')
      }
      return out
    }))
    encryptedFixture = JSON.stringify({
      accountInfos,
      isEncrypted: true,
      passwordInfo: { encryptPassword: btoa('test-password'), encryptIV: Array.from(FOXAUTH_IV) },
    })
  })

  it('正确口令解密导入：与明文同结果（坏 secret 进 failures）', async () => {
    const r = await importFoxauth(encryptedFixture, 'test-password')
    expect(r.entries).toHaveLength(2)
    expect(r.failures).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'a@b.c', algorithm: 'SHA1', digits: 6, period: 30 })
    expect(r.entries[1]).toMatchObject({ type: 'hotp', issuer: 'Battle.net', digits: 8, counter: 0 })
  })

  it('错误口令：结构级报错（口令错误或文件已损坏）', async () => {
    await expect(importFoxauth(encryptedFixture, 'wrong-password')).rejects.toThrow('FoxAuth 备份解密失败：口令错误或文件已损坏')
  })
})
