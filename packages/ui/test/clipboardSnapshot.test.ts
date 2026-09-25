import { describe, expect, it, vi } from 'vitest'
import { importUriBatch } from '@totp/core'
import { readClipboardSnapshot, resolveTextIntent } from '../src/clipboardImport'

// jsdom 25 的 Blob 未实现 text()，用 FileReader polyfill（仅测试环境生效，EntryForm.test.ts arrayBuffer 同款）
if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = function (this: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
      reader.readAsText(this)
    })
  }
}

/** 构造 ClipboardItem 形状（jsdom 无该 API）：types + getType 返回 Blob */
function clipItem(types: string[], blobs: Record<string, Blob>): { types: string[]; getType: (t: string) => Promise<Blob> } {
  return { types, getType: (t) => Promise.resolve(blobs[t]!) }
}

describe('readClipboardSnapshot（剪贴板快照：图+文混合采集）', () => {
  it('有图有文：图优先且只取第一张，文本一并收集', async () => {
    const png = new Blob(['png-bytes'], { type: 'image/png' })
    const read = vi.fn().mockResolvedValue([
      clipItem(['text/plain'], { 'text/plain': new Blob(['hello'], { type: 'text/plain' }) }),
      clipItem(['image/png', 'text/plain'], { 'image/png': png, 'text/plain': new Blob(['world'], { type: 'text/plain' }) }),
      clipItem(['image/png'], { 'image/png': new Blob(['second'], { type: 'image/png' }) }),
    ])
    vi.stubGlobal('navigator', { ...navigator, clipboard: { read } })
    try {
      const snap = await readClipboardSnapshot()
      expect(snap.image).toBe(png) // 首个图片项胜出，第二张忽略
      expect(snap.text).toBe('hello\nworld')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('纯文本多 item：按出现顺序以换行合并为整段文本', async () => {
    const read = vi.fn().mockResolvedValue([
      clipItem(['text/plain'], { 'text/plain': new Blob(['otpauth://totp/a'], { type: 'text/plain' }) }),
      clipItem(['text/plain'], { 'text/plain': new Blob(['otpauth://totp/b'], { type: 'text/plain' }) }),
    ])
    vi.stubGlobal('navigator', { ...navigator, clipboard: { read } })
    try {
      const snap = await readClipboardSnapshot()
      expect(snap.image).toBeNull()
      expect(snap.text).toBe('otpauth://totp/a\notpauth://totp/b')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('clipboard.read 抛错（无授权/宿主拒绝）：原样上抛由调用方提示「读取失败」', async () => {
    const read = vi.fn().mockRejectedValue(new Error('NotAllowedError'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { read } })
    try {
      await expect(readClipboardSnapshot()).rejects.toThrow('NotAllowedError')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('resolveTextIntent 分支补全', () => {
  const URI = 'otpauth://totp/Gen:pix?secret=JBSWY3DPEHPK3PXP&issuer=Gen'

  it('多行整串不强解单条 URI（WHATWG 剥换行会误判）：直接走批量通道', () => {
    // 两行都是合法 URI；若不设防，去掉换行后的整串可被 URL 解析器接受成一条
    const r = resolveTextIntent(`${URI}\n${URI}`)
    expect(r.kind).toBe('batch')
    if (r.kind === 'batch') expect(r.entries).toHaveLength(2)
  })

  it('parser 结构级抛错（嗅探 aegis 但解析中断）→ 错误消息透传', () => {
    // db 键使嗅探判 aegis；entries 非数组令 importAegisPlaintext 结构级 throw（非 unsupported）
    const r = resolveTextIntent(JSON.stringify({ db: {}, header: {}, entries: 42 }))
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message.length).toBeGreaterThan(0)
  })

  it('批量解析 0 条 + 有失败明细 → 取首条失败消息（与 parser 输出一致）', () => {
    const text = 'xx otpauth://totp/x\nyy otpauth://totp/y' // 含 otpauth 特征但每行都解析失败
    const expected = importUriBatch(text).failures[0]!.message
    const r = resolveTextIntent(text)
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toBe(expected)
  })

  it('2FAS 单条兜底：secret 在但 otp 形状不符 → 兜底失败回原 unsupported 消息', () => {
    const r = resolveTextIntent(JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP' })) // 无 otp 对象
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toContain('通用 JSON')
  })

  it('2FAS 单条兜底：形状可包但条目解析失败（非法 secret）→ 同样回 unsupported', () => {
    // secret 非空 + otp 为对象 → singleEntryFromJson 会真调 importTwoFas；条目级失败 → entries 空 → null
    const r = resolveTextIntent(JSON.stringify({ secret: '!!!not-base32!!!', otp: { account: 'a' }, name: 'X' }))
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message).toContain('通用 JSON')
  })

  it('2FAS 单条兜底命中：单条目 JSON → prefill（digits 收口 number→OtpDigits）', () => {
    const r = resolveTextIntent(JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', otp: { account: 'me@x.com' }, name: 'GH' }))
    expect(r.kind).toBe('prefill')
    if (r.kind === 'prefill') {
      expect(r.entry.issuer).toBe('GH')
      expect(r.entry.label).toBe('me@x.com')
      expect(r.entry.digits).toBe(6)
    }
  })
})
