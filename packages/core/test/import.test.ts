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

  it('对象无任何数组且无 secret-like 字段 → rows=[]（findFirstArray 落空回退）', () => {
    const r = extractGenericRows('{"a": {"b": 1}}')
    expect(r.kind).toBe('jsonObjectArray')
    expect(r.rows).toEqual([])
  })

  it('mapping 缺 secret 键 → 缺少 secret 字段；缺 digits/period/algorithm 键 → 走 defaults/缺省', () => {
    // RowMapping 类型要求 secret，此处刻意缺键验证运行时容错（generic 映射页可存残缺方案）
    const noSecret = { issuer: { path: 'name' } } as unknown as RowMapping
    const bare: RowMapping = { secret: { path: 'secret' } }
    expect(mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', name: 'A' }, { ...bare, issuer: { path: 'name' } }))
      .toMatchObject({ digits: 6, period: 30, algorithm: 'SHA1' })
    expect(mapRowToEntry({ name: 'A' }, noSecret)).toEqual({ error: '缺少 secret 字段' })
  })

  it('algorithm 行内值：合法映射、非法回落 SHA1、null/空串走 defaults', () => {
    const m: RowMapping = {
      secret: { path: 'secret' },
      algorithm: { path: 'algo' },
      defaults: { algorithm: 'SHA512' },
    }
    expect(mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', algo: 'sha256' }, m)).toMatchObject({ algorithm: 'SHA256' })
    expect(mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', algo: 'md5' }, m)).toMatchObject({ algorithm: 'SHA1' })
    expect(mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', algo: null }, m)).toMatchObject({ algorithm: 'SHA512' })
    expect(mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', algo: '' }, m)).toMatchObject({ algorithm: 'SHA512' })
  })

  it('digits/period 映射路径生效（非仅 defaults）', () => {
    const m: RowMapping = {
      secret: { path: 'secret' },
      digits: { path: 'd' },
      period: { path: 'p' },
    }
    expect(mapRowToEntry({ secret: 'JBSWY3DPEHPK3PXP', d: 8, p: 45 }, m)).toMatchObject({ digits: 8, period: 45 })
  })

  it('深层嵌套：secret 数组藏在另一数组的对象内仍被探出（findFirstArray 递归回传）', () => {
    const r = extractGenericRows(JSON.stringify({ list: [{ sub: [{ secret: 'JBSWY3DPEHPK3PXP' }] }] }))
    expect(r.kind).toBe('jsonObjectArray')
    expect(r.rows).toEqual([{ secret: 'JBSWY3DPEHPK3PXP' }])
  })
})

describe('嗅探与批量导入边角（盘点 B6/B7 #27-28）', () => {
  it('importUriBatch 空文本输入 → 空结果', () => {
    expect(importUriBatch('')).toEqual({ entries: [], failures: [] })
    expect(importUriBatch('   \n  ')).toEqual({ entries: [], failures: [] })
    expect(sniffFormat('')).toBeNull()
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

  it('数组/JSONL 残块与裸量收敛：非法数组块、单行可解析非块文本、纯数字', () => {
    expect(sniffFormat('[1,2')).toBeNull() // 以 [ 开头但非法 → 落 JSONL 判定（单行失败）
    expect(sniffFormat('123')).toBeNull() // 单行可解析但非块/非多行 → 不判 generic
  })

  it('特征键内层脏数据不误判格式：null service/login/content/数组元素', () => {
    // 2FAS：services 存在但条目为 null → 仍判 twoFas（空/无 secret 交 importTwoFas 报「无条目」）
    expect(sniffFormat(JSON.stringify({ services: [null, { otp: {} }] }))).toBe('twoFas')
    // 空数组显式判 twoFas（importTwoFas 给出「无条目」明确错误）
    expect(sniffFormat(JSON.stringify({ services: [] }))).toBe('twoFas')
    // Bitwarden：login 为 null、item 数组含 null 元素
    expect(sniffFormat(JSON.stringify({ items: [{ login: null }, { login: { totp: 'x' } }] }))).toBe('bitwarden')
    expect(sniffFormat(JSON.stringify({ items: [null, { login: { totp: 'x' } }] }))).toBe('bitwarden')
    // Proton：content 为 null、entry 数组含 null 元素
    expect(sniffFormat(JSON.stringify({ entries: [{ content: null }, { content: { uri: 'otpauth://totp/a?secret=X' } }] }))).toBe('proton')
    expect(sniffFormat(JSON.stringify({ entries: [null, { content: { uri: 'otpauth://totp/a?secret=X' } }] }))).toBe('proton')
  })

  it('andOtp/totpAuthenticator 数组内非对象元素跳过，不阻断特征判定', () => {
    expect(sniffFormat(JSON.stringify([42, { type: 'TOTP', algorithm: 'SHA1', label: 'a', secret: 'JBSWY3DPEHPK3PXP' }]))).toBe('andOtp')
    expect(sniffFormat(JSON.stringify([null, { base: 32, key: 'JBSWY3DPEHPK3PXP' }]))).toBe('totpAuthenticator')
  })
})
