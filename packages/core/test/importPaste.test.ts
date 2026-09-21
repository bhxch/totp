import { parsePastedText } from '@totp/core'
import { describe, expect, it } from 'vitest'

describe('parsePastedText', () => {
  it('多行 otpauth URI 走 uriBatch', () => {
    const r = parsePastedText('otpauth://totp/G:a?secret=JBSWY3DPEHPK3PXP\notpauth://totp/G:b?secret=JBSWY3DPEHPK3PXP')
    expect('unsupported' in r).toBe(false)
    if (!('unsupported' in r)) expect(r.entries).toHaveLength(2)
  })
  it('Aegis 明文 JSON 走 aegis 解析', () => {
    const json = JSON.stringify({ version: 1, header: { slots: [], params: {} }, db: { entries: [{ type: 'totp', uuid: 'u', name: 'G:a', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30 } }], groups: [] } })
    const r = parsePastedText(json)
    if (!('unsupported' in r)) expect(r.entries).toHaveLength(1)
    else expect.unreachable()
  })
  it('FoxAuth 明文备份走同步明文解析', () => {
    const json = JSON.stringify({
      accountInfos: [
        { localIssuer: 'GitHub', localAccountName: 'a@b.c', localSecretToken: 'JBSWY3DPEHPK3PXP', localOTPType: 'Time based', localOTPDigits: '6', localOTPPeriod: '30' },
      ],
      isEncrypted: false,
    })
    const r = parsePastedText(json)
    expect('unsupported' in r).toBe(false)
    if (!('unsupported' in r)) {
      expect(r.entries).toHaveLength(1)
      expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'a@b.c', secret: 'JBSWY3DPEHPK3PXP' })
    }
  })
  it('FoxAuth 加密备份提示走导入页', () => {
    const r = parsePastedText(JSON.stringify({ accountInfos: 'CIPHER', isEncrypted: true, passwordInfo: {} }))
    expect(r).toEqual({ unsupported: expect.stringContaining('导入页') })
  })
  it('通用 JSON 提示走导入页', () => {
    const r = parsePastedText('{"foo": 1}')
    expect(r).toEqual({ unsupported: expect.stringContaining('导入页') })
  })
  it('乱文本无法识别', () => {
    expect(parsePastedText('hello world')).toHaveProperty('unsupported')
  })
})
