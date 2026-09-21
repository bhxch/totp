import { describe, expect, it } from 'vitest'
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
