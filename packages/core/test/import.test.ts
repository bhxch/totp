import { describe, expect, it } from 'vitest'
import { extractGenericRows, importGeneric, importUriBatch, mapRowToEntry, sniffAegis, sniffFoxauthEncrypted, sniffFormat } from '../src/import/sniff'
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

describe('sniffAegis', () => {
  // 明文 vault 顶层同样带 header（slots 为空数组，与 Aegis 官方明文导出一致）——
  // 加密判定只能看顶层 db 类型：明文为对象、加密为密文 Base64 字符串
  it('加密（db 为字符串）true，明文（带 header + db 对象）false，非 aegis null', () => {
    expect(sniffAegis('{"version":1,"header":{"slots":[{"type":1}],"params":{}},"db":"aGVsbG8="}')).toMatchObject({ kind: 'aegis', encrypted: true })
    expect(sniffAegis('{"version":1,"header":{"slots":[],"params":{}},"db":{"entries":[],"groups":[]}}')).toMatchObject({ kind: 'aegis', encrypted: false })
    expect(sniffAegis('{"foo":1}')).toBeNull()
    expect(sniffAegis('[1,2]')).toBeNull()
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

  it('I41：steam URI 导入强制 digits=5（即便原始 URI 写 digits=6 也覆盖）', () => {
    const r = importUriBatch(`otpauth://steam/Steam:u?secret=JBSWY3DPEHPK3PXP&digits=6`)
    expect(r.entries[0]).toMatchObject({ type: 'steam', digits: 5 })
  })
})

describe('extractGenericRows', () => {
  it('数组/嵌套数组/JSONL', () => {
    expect(extractGenericRows('[{"s":"a"},{"s":"b"}]').rows).toHaveLength(2)
    const nested = extractGenericRows('{"data": {"otps": [{"s":"a"}]}}')
    expect(nested.rows).toEqual([{ s: 'a' }])
    expect(extractGenericRows('{"s":"a"}\n{"s":"b"}').kind).toBe('jsonl')
  })

  it('I18：metadata.tags: [] 短数组 vs entries 长数组，优先含 secret 字段的 entries', () => {
    const text = JSON.stringify({
      metadata: { tags: [] },
      entries: [
        { secret: 'JBSWY3DPEHPK3PXP', issuer: 'A' },
        { secret: 'JBSWY3DPEHPK3PXP', issuer: 'B' },
        { secret: 'JBSWY3DPEHPK3PXP', issuer: 'C' },
      ],
    })
    const r = extractGenericRows(text)
    expect(r.kind).toBe('jsonObjectArray')
    expect(r.rows).toHaveLength(3)
    expect(r.rows[0]).toMatchObject({ issuer: 'A' })
  })

  it('I18：所有数组均无 secret 字段时退而求其次取最长数组', () => {
    const text = JSON.stringify({
      metadata: { tags: ['t1', 't2'] },
      notes: ['n1'],
      items: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }],
    })
    const r = extractGenericRows(text)
    expect(r.rows).toHaveLength(4)
  })

  it('I18：显式 path 覆盖探测，直接按点路径取值', () => {
    const text = JSON.stringify({
      meta: { tags: ['t1', 't2', 't3'] },
      data: { otps: [{ secret: 'JBSWY3DPEHPK3PXP', issuer: 'A' }] },
    })
    const r = extractGenericRows(text, 'data.otps')
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ issuer: 'A' })
  })

  it('I19：单对象导出（{secret, issuer} 一条）→ rows=[root]，kind=jsonSingleObject', () => {
    const r = extractGenericRows(JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'Solo' }))
    expect(r.kind).toBe('jsonSingleObject')
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ issuer: 'Solo' })
  })

  it('I19：单对象 + 嵌套空数组时退化为 jsonObjectArray（数组优先）', () => {
    // 嵌套了空数组时按数组分支走（findFirstArray 找到 tags），rows 是嵌套数组
    const r = extractGenericRows(JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'S', metadata: { tags: [] } }))
    expect(r.kind).toBe('jsonObjectArray')
  })
})

describe('sniffFormat foxauth', () => {
  it('accountInfos 数组 + isEncrypted 布尔判 foxauth', () => {
    expect(sniffFormat(JSON.stringify({ accountInfos: [], isEncrypted: false }))).toBe('foxauth')
    expect(sniffFormat(JSON.stringify({ accountInfos: [{ localIssuer: 'GitHub' }], isEncrypted: true, passwordInfo: {} }))).toBe('foxauth')
  })

  it('加密备份密文形态（accountInfos 为字符串）也判 foxauth，不落 generic', () => {
    expect(sniffFormat(JSON.stringify({ accountInfos: 'CIPHER', isEncrypted: true, passwordInfo: { encryptPassword: 'dGVzdA==' } }))).toBe('foxauth')
    expect(sniffFormat(JSON.stringify({ accountInfos: 'CIPHER', isEncrypted: false }))).toBe('foxauth')
  })

  it('isEncrypted 非布尔不判 foxauth（仍落 generic）', () => {
    expect(sniffFormat(JSON.stringify({ accountInfos: 'CIPHER' }))).toBe('generic')
  })

  it('不误伤既有格式', () => {
    expect(sniffFormat(JSON.stringify({ db: {}, header: {} }))).toBe('aegis')
    expect(sniffFormat(JSON.stringify({ services: [{ secret: 'JBSW' }] }))).toBe('twoFas')
    expect(sniffFormat('{}')).toBe('generic')
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
  it('transform 契约：缺省/uppercaseSecret 去空白+大写；none 仅去空白保留原大小写', () => {
    const spaced = { ...row, otp: { secret: ' jbsw y3dp ehpk 3pxp ' } }
    // 缺省（undefined）= uppercaseSecret 语义
    expect(mapRowToEntry(spaced, mapping)).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP' })
    expect(
      mapRowToEntry(spaced, { ...mapping, secret: { path: 'otp.secret', transform: 'uppercaseSecret' } }),
    ).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP' })
    // none：保留小写/混合大小写 secret（hex 小写习惯），仅去除空白
    expect(
      mapRowToEntry(spaced, { ...mapping, secret: { path: 'otp.secret', transform: 'none' } }),
    ).toMatchObject({ secret: 'jbswy3dpehpk3pxp' })
  })
  it('importGeneric 透传 mapping.secret.transform（与 mapRowToEntry 同口径）', () => {
    const r = importGeneric(JSON.stringify([{ ...row }]), { ...mapping, secret: { path: 'otp.secret', transform: 'none' } })
    expect(r.failures).toEqual([])
    expect(r.entries[0]).toMatchObject({ secret: 'jbswy3dpehpk3pxp' })
  })

  it('显式 path 存在但值非数组 → rows=[]（jsonObjectArray 空行）', () => {
    const r = extractGenericRows(JSON.stringify({ data: { otps: { a: 1 } } }), 'data.otps')
    expect(r.kind).toBe('jsonObjectArray')
    expect(r.rows).toEqual([])
  })

  it('importGeneric rowsOverride 透传：跳过文本探测，直接按行映射', () => {
    const r = importGeneric('irrelevant text', mapping, [row, { name: 'bad' }])
    expect(r.entries).toHaveLength(1)
    expect(r.failures).toEqual([{ index: 1, message: '缺少 secret 字段' }])
  })

  it('counter 采纳与 defaults：行内 counter≥0 优先、非法回落 defaults.counter；note 同口径', () => {
    const m: RowMapping = {
      issuer: { path: 'name' },
      secret: { path: 'secret' },
      counter: { path: 'seq' },
      note: { path: 'memo' },
      defaults: { counter: 5, note: '默认备注' },
    }
    // 行内值合法 → 采纳
    expect(mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', name: 'A', seq: 9, memo: '行内备注' }, m))
      .toMatchObject({ counter: 9, note: '行内备注' })
    // 行内值非法（负数/缺失/非数值）→ defaults
    expect(mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', name: 'B', seq: -1 }, m)).toMatchObject({ counter: 5, note: '默认备注' })
    expect(mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', name: 'C' }, m)).toMatchObject({ counter: 5, note: '默认备注' })
    // 无 defaults → 不写 counter/note
    const bare = mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', name: 'D' }, { issuer: { path: 'name' }, secret: { path: 'secret' } })
    expect('counter' in bare).toBe(false)
    expect('note' in bare).toBe(false)
  })

  it('JSONL 混坏行：坏行跳过不计 rows，好行保留', () => {
    const r = extractGenericRows('{"a":1}\nthis is broken\n\n{"b":2}')
    expect(r.kind).toBe('jsonl')
    expect(r.rows).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe('嗅探与批量导入边角（盘点 B6/B7 #27-28）', () => {
  it('importUriBatch 空文本输入 → 空结果', () => {
    expect(importUriBatch('')).toEqual({ entries: [], failures: [] })
    expect(importUriBatch('   \n  ')).toEqual({ entries: [], failures: [] })
  })

  it('sniffAegis/sniffFoxauthEncrypted 对非对象 JSON 与解析失败收敛 false/null', () => {
    expect(sniffAegis('{broken json')).toBeNull()
    expect(sniffAegis('"just a string"')).toBeNull()
    expect(sniffFoxauthEncrypted('[1,2]')).toBe(false)
    expect(sniffFoxauthEncrypted('{broken json')).toBe(false)
  })

  it('整体非合法 JSON 的花括号文本不误判：落 JSONL 判定失败后返回 null', () => {
    expect(sniffFormat('{"db":{"entries":[]},,}')).toBeNull()
  })
})
