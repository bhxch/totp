import { describe, expect, it } from 'vitest'
import { resolveTextIntent, toParsedEntry } from '../src/clipboardImport'

const URI = 'otpauth://totp/Gen:pix?secret=JBSWY3DPEHPK3PXP&issuer=Gen'

describe('resolveTextIntent', () => {
  it('单条 otpauth URI → prefill（uuid 为哑值空串）', () => {
    const r = resolveTextIntent(URI)
    expect(r.kind).toBe('prefill')
    if (r.kind === 'prefill') {
      expect(r.entry.issuer).toBe('Gen')
      expect(r.entry.uuid).toBe('')
    }
  })
  it('多条 URI 文本 → batch（条数=行数）', () => {
    const r = resolveTextIntent(`${URI}\n${URI.replace('Gen', 'Other')}`)
    expect(r.kind).toBe('batch')
    if (r.kind === 'batch') expect(r.entries).toHaveLength(2)
  })
  it('单条目 JSON（2FAS 形态）→ prefill', () => {
    const r = resolveTextIntent(JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', otp: { account: 'me@x.com' }, name: 'GH' }))
    expect(r.kind).toBe('prefill')
  })
  it('不支持的格式（generic 无映射）→ error 且消息来自 parser', () => {
    const r = resolveTextIntent('{"foo": 1}')
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message.length).toBeGreaterThan(0)
  })
  it('空文本 → error', () => {
    expect(resolveTextIntent('   ').kind).toBe('error')
  })
})

describe('toParsedEntry', () => {
  it('投影导入字段、丢弃管理字段', () => {
    const p = toParsedEntry({
      uuid: 'u1', type: 'totp', issuer: 'GH', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, note: 'n', tagIds: ['t'], matchRules: [], order: 3, createdAt: 9,
    })
    expect(p).toEqual({ type: 'totp', issuer: 'GH', label: 'me', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 })
  })
  it('hotp counter 与 yandex pin 随投影保留（可选字段两向）', () => {
    const base = { uuid: 'u', issuer: 'GH', label: 'me', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1' as const, period: 30, note: '', tagIds: [], matchRules: [], order: 0, createdAt: 0 }
    const hotp = toParsedEntry({ ...base, type: 'hotp', digits: 6, counter: 7 })
    expect(hotp.counter).toBe(7)
    expect('pin' in hotp).toBe(false)
    const yandex = toParsedEntry({ ...base, type: 'yandex', digits: 8, pin: '1234' })
    expect(yandex.pin).toBe('1234')
    expect('counter' in yandex).toBe(false)
  })
})

describe('resolveTextIntent 兜底分支（singleEntryFromJson 形状防护）', () => {
  it('非 { 开头的无法识别文本：不走单条兜底，直接回 unsupported', () => {
    const r = resolveTextIntent('hello world')
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toContain('无法识别')
  })
  it('JSON 数组：判 generic 走 unsupported，数组形状不入单条兜底', () => {
    const r = resolveTextIntent('[1,2]')
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toContain('通用 JSON')
  })
  it('null 字面量：非对象形状不入单条兜底', () => {
    const r = resolveTextIntent('null')
    expect(r.kind).toBe('error')
  })
  it('{ 开头但坏 JSON：JSON.parse 失败回 null → unsupported', () => {
    const r = resolveTextIntent('{bad json')
    expect(r.kind).toBe('error')
  })
  it('secret 为纯空白：形状不符回 unsupported', () => {
    const r = resolveTextIntent(JSON.stringify({ secret: '   ', otp: {} }))
    expect(r.kind).toBe('error')
  })
  it('2FAS 单条 HOTP 带 counter：prefill 保留 counter（可选字段两向）', () => {
    const r = resolveTextIntent(JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', otp: { account: 'a', tokenType: 'HOTP', counter: '7' }, name: 'H' }))
    expect(r.kind).toBe('prefill')
    if (r.kind === 'prefill') expect(r.entry.counter).toBe(7)
  })
})
