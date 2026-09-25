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
  it('Aegis 加密 vault（db 为密文 Base64 串）拦截引导至导入页口令通道，不走明文解析', () => {
    // 结构对齐真实加密导出：header 带 slots/params、顶层 db 为 Base64 密文字符串（sniffAegis.encrypted=true）
    const encrypted = JSON.stringify({
      version: 1,
      header: { slots: [{ type: 1, uuid: 's', key: 'ab', key_params: { nonce: 'cd', tag: 'ef' }, salt: '01', n: 16384, r: 8, p: 1 }], params: { nonce: 'aa'.repeat(12), tag: 'bb'.repeat(16) } },
      db: 'aGVsbG8=',
    })
    const r = parsePastedText(encrypted)
    expect(r).toEqual({ unsupported: '加密 Aegis 文件请走导入页（需输入口令）' })
  })
  it('WinAuth XML 拦截：文件惯例不走粘贴强解，提示选择文件导入', () => {
    const r = parsePastedText('<?xml version="1.0"?><WinAuth version="3.6.4.2"></WinAuth>')
    expect(r).toEqual({ unsupported: 'WinAuth 请在导入页选择文件导入' })
  })
  it('通用 JSON 提示走导入页', () => {
    const r = parsePastedText('{"foo": 1}')
    expect(r).toEqual({ unsupported: expect.stringContaining('导入页') })
  })
  it('乱文本无法识别', () => {
    expect(parsePastedText('hello world')).toHaveProperty('unsupported')
  })
})
