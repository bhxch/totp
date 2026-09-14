import { describe, expect, it } from 'vitest'
import { extractGenericRows, importGeneric, importUriBatch, mapRowToEntry, sniffFormat } from '../src/import/sniff'
import type { RowMapping } from '../src/import/sniff'

describe('sniffFormat', () => {
  it('各格式判定', () => {
    expect(sniffFormat('{"db": {"entries": []}}')).toBe('aegis')
    expect(sniffFormat('{"version": 1, "header": {"slots": []}}')).toBe('aegis')
    expect(sniffFormat('<?xml version="1.0"?><WinAuth>…</WinAuth>')).toBe('winauth')
    expect(sniffFormat('[{"secret":"JBSWY3DPEHPK3PXP"}]')).toBe('generic')
    expect(sniffFormat('{"a":1}\n{"b":2}')).toBe('generic')
    expect(sniffFormat('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP')).toBe('uriBatch')
    expect(sniffFormat('hello')).toBeNull()
  })
})

describe('importUriBatch', () => {
  it('混合合法/非法行', () => {
    const r = importUriBatch(
      'otpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP\n\nnot a uri\notpauth://steam/Steam:u?secret=JBSWY3DPEHPK3PXP',
    )
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', label: 'me@x.com', type: 'totp' })
    expect(r.entries[1]).toMatchObject({ type: 'steam', digits: 5 })
    expect(r.failures).toEqual([{ index: 2, message: expect.stringContaining('invalid otpauth uri') }])
  })

  it('Firefox 协议处理器 ext+otpauth:// 前缀被还原为 otpauth:// 后正常解析', () => {
    const SECRET = 'JBSWY3DPEHPK3PXP'
    // 正常 ext+otpauth:// 写法（href 形式带 //）
    const r = importUriBatch(
      `ext+otpauth://totp/GitHub:me@x.com?secret=${SECRET}\n` +
        // 大小写不敏感
        `EXT+OTPAUTH://hotp/Hotp:k?secret=${SECRET}&counter=1\n` +
        // 仍是非 otpauth 行（其他 scheme）
        `ext+something://nope`,
    )
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0]!.index).toBe(2)
    expect(r.entries[0]).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'me@x.com', secret: SECRET })
    expect(r.entries[1]).toMatchObject({ type: 'hotp', counter: 1 })
  })
})

describe('extractGenericRows', () => {
  it('数组/嵌套数组/JSONL', () => {
    expect(extractGenericRows('[{"s":"a"},{"s":"b"}]').rows).toHaveLength(2)
    const nested = extractGenericRows('{"data": {"otps": [{"s":"a"}]}}')
    expect(nested.rows).toEqual([{ s: 'a' }])
    expect(extractGenericRows('{"s":"a"}\n{"s":"b"}').kind).toBe('jsonl')
  })
})

describe('mapRowToEntry/importGeneric', () => {
  const mapping: RowMapping = {
    issuer: { path: 'name' },
    label: { path: 'account' },
    secret: { path: 'otp.secret' },
    type: { path: 'kind' },
  }
  const row = { name: 'GitHub', account: 'me@x.com', kind: 'totp', otp: { secret: 'jbswy3dpehpk3pxp' } }

  it('点路径取值 + secret 规整大写', () => {
    expect(mapRowToEntry(row, mapping)).toMatchObject({ issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', type: 'totp', digits: 6, period: 30, algorithm: 'SHA1' })
  })
  it('缺 secret 报错；defaults 补齐', () => {
    expect(mapRowToEntry({ name: 'x' }, mapping)).toEqual({ error: '缺少 secret 字段' })
    const withDefaults: RowMapping = { ...mapping, defaults: { issuer: '默认' } }
    expect(mapRowToEntry({ otp: { secret: 'JBSWY3DPEHPK3PXP' } }, withDefaults)).toMatchObject({ issuer: '默认', label: '' })
  })
  it('importGeneric 逐行报告', () => {
    const r = importGeneric(JSON.stringify([row, { name: 'bad' }]), mapping)
    expect(r.entries).toHaveLength(1)
    expect(r.failures).toEqual([{ index: 1, message: '缺少 secret 字段' }])
  })
  it('type=steam 时 digits 强制 5', () => {
    expect(mapRowToEntry({ ...row, kind: 'steam' }, mapping)).toMatchObject({ type: 'steam', digits: 5 })
  })
})
