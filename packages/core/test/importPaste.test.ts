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
  it('通用 JSON 提示走导入页', () => {
    const r = parsePastedText('{"foo": 1}')
    expect(r).toEqual({ unsupported: expect.stringContaining('导入页') })
  })
  it('乱文本无法识别', () => {
    expect(parsePastedText('hello world')).toHaveProperty('unsupported')
  })
})
