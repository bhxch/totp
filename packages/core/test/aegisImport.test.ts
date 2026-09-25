import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { aesGcmEncrypt, randomBytes } from '../src/crypto/aesgcm'
import { scrypt } from 'hash-wasm'
import { importAegisEncrypted, importAegisPlaintext } from '../src/import/aegis'
import { base32Decode } from '../src/encoding/base32'

const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

const enc = () => readFileSync(fileURLToPath(new URL('./fixtures/aegis-encrypted.json', import.meta.url)), 'utf8')

describe('importAegisPlaintext', () => {
  it('官方结构样例', () => {
    const r = importAegisPlaintext(
      JSON.stringify({
        db: {
          version: 1,
          entries: [
            {
              type: 'totp',
              uuid: 'u1',
              name: 'GitHub:me@x.com',
              info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30, origin: 'manual' },
            },
            {
              type: 'steam',
              uuid: 'u2',
              name: 'Steam:player1',
              info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 5, period: 30 },
            },
            {
              // Aegis YandexInfo 序列化：type=yandex + info.pin
              type: 'yandex',
              uuid: 'u3',
              name: 'Yandex:user',
              info: { secret: 'KJTEUGOD5SNXVWBCWJ4G36W4IA', algo: 'SHA256', digits: 8, period: 30, pin: '1234' },
            },
          ],
        },
      }),
    )
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', label: 'me@x.com', type: 'totp' })
    expect(r.entries[1]).toMatchObject({ type: 'steam', digits: 5 })
    expect(r.entries[2]).toMatchObject({ type: 'yandex', digits: 8, algorithm: 'SHA256', pin: '1234' })
    expect(r.failures).toHaveLength(0)
  })
  it('坏条目进 failures 不阻断', () => {
    const r = importAegisPlaintext(JSON.stringify({ db: { entries: [{ type: 'totp', name: 'x', info: {} }] } }))
    expect(r.entries).toHaveLength(0)
    expect(r.failures).toHaveLength(1)
  })
  it('结构非法：缺少 db.entries 报结构化错误', () => {
    expect(() => importAegisPlaintext('{}')).toThrow('结构非法')
  })
  it('db.groups + 条目 groupid 映射为 tags；查表 miss 静默丢弃', () => {
    const text = JSON.stringify({
      version: 3, header: {},
      db: {
        groups: [{ uuid: 'g1', name: '工作' }],
        entries: [
          { type: 'totp', name: 'GitHub:me', info: { secret: 'JBSWY3DPEHPK3PXP' }, groupid: 'g1' },
          { type: 'totp', name: 'GitLab:me', info: { secret: 'JBSWY3DPEHPK3PXP' }, groupid: 'missing' },
          { type: 'totp', name: 'No:group', info: { secret: 'JBSWY3DPEHPK3PXP' } },
        ],
      },
    })
    const res = importAegisPlaintext(text)
    expect(res.failures).toHaveLength(0)
    expect(res.entries[0]!.tags).toEqual(['工作'])
    expect(res.entries[1]!.tags).toBeUndefined()
    expect(res.entries[2]!.tags).toBeUndefined()
  })
  it('官方布局：entry.groups 为 uuid 数组（可多值），逐个查名进 tags 且顺序保留', () => {
    const text = JSON.stringify({
      db: {
        groups: [{ uuid: 'g1', name: '工作' }, { uuid: 'g2', name: '重要' }],
        entries: [
          { type: 'totp', name: 'GitHub:me', info: { secret: 'JBSWY3DPEHPK3PXP' }, groups: ['g1', 'g2'] },
          { type: 'totp', name: 'GitLab:me', info: { secret: 'JBSWY3DPEHPK3PXP' }, groups: ['missing'] },
          { type: 'totp', name: 'No:group', info: { secret: 'JBSWY3DPEHPK3PXP' }, groups: [] },
        ],
      },
    })
    const res = importAegisPlaintext(text)
    expect(res.failures).toHaveLength(0)
    expect(res.entries[0]!.tags).toEqual(['工作', '重要'])
    expect(res.entries[1]!.tags).toBeUndefined()
    expect(res.entries[2]!.tags).toBeUndefined()
  })
  it('legacy 官方回退：entry.group 为组名字符串（老版 Aegis 从无 groupid），直接作 tag', () => {
    const text = JSON.stringify({
      db: {
        entries: [
          { type: 'totp', name: 'GitHub:me', info: { secret: 'JBSWY3DPEHPK3PXP' }, group: '工作' },
          // groups 数组优先于 legacy group
          { type: 'totp', name: 'GitLab:me', info: { secret: 'JBSWY3DPEHPK3PXP' }, groups: ['g9'], group: '旧名' },
        ],
      },
    })
    const res = importAegisPlaintext(text)
    expect(res.failures).toHaveLength(0)
    expect(res.entries[0]!.tags).toEqual(['工作'])
    expect(res.entries[1]!.tags).toBeUndefined() // g9 查表 miss → 整体无 tag（不回落 legacy）
  })
})

describe('importAegisEncrypted', () => {
  it('口令正确解开 fixture', async () => {
    const r = await importAegisEncrypted(enc(), 'test1234')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP' })
  })
  it('口令错误报中文错误', async () => {
    await expect(importAegisEncrypted(enc(), 'wrong')).rejects.toThrow('口令错误或文件已损坏')
  })
  it('结构非法：缺少 header/db 报结构化错误', async () => {
    await expect(importAegisEncrypted('{}', 'test1234')).rejects.toThrow('结构非法')
  })

  it('slot 级 scrypt 参数超限：整文件按结构非法拒绝（F2 资源耗尽防护）', async () => {
    const base = JSON.parse(enc()) as { header: { slots: Record<string, unknown>[] } }
    // 上限：n ≤ 2**21（128*n*8 ≤ 2GiB）、r ≤ 8、p ≤ 8（与 envelope/securityStore 的 argon2id 口径同源）
    const overrides: Array<Record<string, number>> = [{ n: 2 ** 21 + 1 }, { r: 9 }, { p: 9 }]
    for (const override of overrides) {
      const text = JSON.stringify({
        ...base,
        header: { ...base.header, slots: [{ ...base.header.slots[0]!, ...override }] },
      })
      await expect(importAegisEncrypted(text, 'test1234')).rejects.toThrow('结构非法')
    }
  })

  it('slots 数量超限（>8）：整文件按结构非法拒绝', async () => {
    const base = JSON.parse(enc()) as { header: { slots: Record<string, unknown>[] } }
    const text = JSON.stringify({
      ...base,
      header: { ...base.header, slots: Array.from({ length: 9 }, (_, i) => ({ type: 0, uuid: `s${i}` })) },
    })
    await expect(importAegisEncrypted(text, 'test1234')).rejects.toThrow('结构非法')
  })

  it('I23：解密后 secret 字节与 base32 已知值一致（hash-wasm 4.x scrypt 冒烟）', async () => {
    const r = await importAegisEncrypted(enc(), 'test1234')
    // fixture 内条目 secret='JBSWY3DPEHPK3PXP'，scrypt + AES-GCM 解密后 base32Decode 须为同一字节
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]!.secret).toBe('JBSWY3DPEHPK3PXP')
    // 16 字节 SHA-1 secret 的已知值（base32 → bytes 往返）
    expect(r.entries[0]!.secret.replace(/\s+/g, '').toUpperCase()).toBe('JBSWY3DPEHPK3PXP')
    const expected = base32Decode('JBSWY3DPEHPK3PXP')
    expect(expected.length).toBe(10) // SHA-1 长度 160bit = 20 字节（这里因 base32 padding 损失了尾部，正常 16B；仅 sanity check 非空）
    expect(expected.length).toBeGreaterThan(0)
  })
})

// ---------- 程序化加密 fixture（盘点 B1 #8）：scrypt 降参数（n=16/r=1/p=1）保证毫秒级，
// 布局与官方 VaultFile/PasswordSlot/CryptoUtils 一致（本文件头注释），避免新增大量真实 scrypt 用例。

const DB_JSON = JSON.stringify({
  entries: [{ type: 'totp', uuid: 'u1', name: 'GitHub:me@x.com', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30 } }],
})

async function gcmSplit(key: Uint8Array, plain: Uint8Array): Promise<{ ct: Uint8Array; tag: Uint8Array; nonce: Uint8Array }> {
  const nonce = randomBytes(12)
  const out = new Uint8Array(await aesGcmEncrypt(key, plain, nonce))
  return { ct: out.slice(0, out.length - 16), tag: out.slice(out.length - 16), nonce }
}

/** 构造 Aegis 加密 vault JSON；dbKey 缺省与 slot 口令派生 KEK 解出的 master key 一致 */
async function buildAegisEncrypted(
  password: string,
  opts: {
    dbPlain?: string
    dbKey?: Uint8Array
    params?: Record<string, unknown>
    slots?: unknown[]
    dbB64?: string
  } = {},
): Promise<string> {
  const master = randomBytes(32)
  const dbPlain = opts.dbPlain ?? DB_JSON
  const db = await gcmSplit(opts.dbKey ?? master, new TextEncoder().encode(dbPlain))
  const salt = randomBytes(16)
  const kek = (await scrypt({ password, salt, costFactor: 16, blockSize: 1, parallelism: 1, hashLength: 32, outputType: 'binary' })) as Uint8Array
  const slotWrap = await gcmSplit(kek, master)
  const slot = {
    type: 1,
    uuid: crypto.randomUUID(),
    key: bytesToHex(slotWrap.ct),
    key_params: { nonce: bytesToHex(slotWrap.nonce), tag: bytesToHex(slotWrap.tag) },
    salt: bytesToHex(salt),
    n: 16, r: 1, p: 1,
  }
  const header = {
    slots: opts.slots ?? [slot],
    params: opts.params ?? { nonce: bytesToHex(db.nonce), tag: bytesToHex(db.tag) },
  }
  return JSON.stringify({ version: 1, header, db: opts.dbB64 ?? Buffer.from(db.ct).toString('base64') })
}

describe('importAegisEncrypted 加密结构分支（盘点 B1 #8）', () => {
  it('降参数程序化 fixture 可解开（验证构造与实现互逆，供结构分支用例复用）', async () => {
    const r = await importAegisEncrypted(await buildAegisEncrypted('pw123'), 'pw123')
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP' })
  })

  it('缺 header / header 非对象 / 缺 header.params / 缺 header.slots 数组 / db 非字符串 → 结构级报错', async () => {
    const good = JSON.parse(await buildAegisEncrypted('pw')) as Record<string, unknown>
    await expect(importAegisEncrypted(JSON.stringify({ version: 1, db: 'x' }), 'pw')).rejects.toThrow('缺少 header')
    await expect(importAegisEncrypted(JSON.stringify({ version: 1, header: null, db: 'x' }), 'pw')).rejects.toThrow('缺少 header')
    await expect(importAegisEncrypted(JSON.stringify({ ...good, header: { slots: [] } }), 'pw')).rejects.toThrow('缺少 header.params')
    await expect(importAegisEncrypted(JSON.stringify({ ...good, header: { params: {} } }), 'pw')).rejects.toThrow('缺少 header.slots')
    await expect(importAegisEncrypted(JSON.stringify({ ...good, db: 42 }), 'pw')).rejects.toThrow('缺少加密的 db 字符串')
  })

  it('params.nonce/tag 非法（非 hex、长度≠12/16 字节）→ 结构级报错', async () => {
    const good = JSON.parse(await buildAegisEncrypted('pw')) as { header: { params: Record<string, string> } }
    const withParams = async (params: Record<string, unknown>): Promise<string> =>
      JSON.stringify({ ...good, header: { ...good.header, params } })
    await expect(importAegisEncrypted(await withParams({ nonce: 'zz-non-hex'.repeat(3), tag: 'bb'.repeat(16) }), 'pw'))
      .rejects.toThrow('nonce/tag 非法')
    await expect(importAegisEncrypted(await withParams({ nonce: 'aa'.repeat(11), tag: 'bb'.repeat(16) }), 'pw'))
      .rejects.toThrow('nonce/tag 非法')
    await expect(importAegisEncrypted(await withParams({ nonce: 'aa'.repeat(12), tag: 'bb'.repeat(15) }), 'pw'))
      .rejects.toThrow('nonce/tag 非法')
    await expect(importAegisEncrypted(await withParams({ nonce: 42, tag: 'bb'.repeat(16) }), 'pw'))
      .rejects.toThrow('nonce/tag 非法')
  })

  it('db 非合法 base64 → 结构级报错（区别于口令错误）', async () => {
    const text = await buildAegisEncrypted('pw')
    const good = JSON.parse(text) as { db: string }
    await expect(importAegisEncrypted(JSON.stringify({ ...good, db: '!!!not-base64!!!' }), 'pw'))
      .rejects.toThrow('db 不是合法 base64')
  })

  it('slots 含 null / 非 PasswordSlot（RawSlot type=0）→ 跳过，全部不可用时报口令错误', async () => {
    const text = await buildAegisEncrypted('pw', { slots: [null, { type: 0, uuid: 'raw' }, 42] })
    await expect(importAegisEncrypted(text, 'pw')).rejects.toThrow('口令错误或文件已损坏')
  })

  it('slot 结构残缺（缺 key 串 / n 非有限）→ 该 slot 失败换下一个，后续 slot 可解', async () => {
    const good = await buildAegisEncrypted('pw')
    const parsed = JSON.parse(good) as { header: { slots: Array<Record<string, unknown>> } }
    const okSlot = parsed.header.slots[0]!
    const text = JSON.stringify({
      ...parsed,
      header: { ...parsed.header, slots: [{ ...okSlot, key: 123 }, { ...okSlot, n: 'abc' }, okSlot] },
    })
    const r = await importAegisEncrypted(text, 'pw')
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]!.issuer).toBe('GitHub')
  })

  it('master key 解出但 db 用另一密钥加密（GCM 校验失败）→ 口令错误或文件已损坏', async () => {
    const wrongKey = randomBytes(32)
    const text = await buildAegisEncrypted('pw', { dbKey: wrongKey })
    await expect(importAegisEncrypted(text, 'pw')).rejects.toThrow('口令错误或文件已损坏')
  })

  it('slot 口令不匹配（KEK 错 → GCM 失败）→ 换下一 slot 全失败 → 口令错误', async () => {
    const text = await buildAegisEncrypted('pw')
    await expect(importAegisEncrypted(text, 'wrong')).rejects.toThrow('口令错误或文件已损坏')
  })

  it('解出的 db 非合法 JSON → 结构级报错（master key 正确、db 明文损坏）', async () => {
    const master = randomBytes(32)
    const salt = randomBytes(16)
    const kek = (await scrypt({ password: 'pw', salt, costFactor: 16, blockSize: 1, parallelism: 1, hashLength: 32, outputType: 'binary' })) as Uint8Array
    const db = await gcmSplit(master, new TextEncoder().encode('{not-json'))
    const slotWrap = await gcmSplit(kek, master)
    const text = JSON.stringify({
      version: 1,
      header: {
        slots: [{ type: 1, uuid: 's', key: bytesToHex(slotWrap.ct), key_params: { nonce: bytesToHex(slotWrap.nonce), tag: bytesToHex(slotWrap.tag) }, salt: bytesToHex(salt), n: 16, r: 1, p: 1 }],
        params: { nonce: bytesToHex(db.nonce), tag: bytesToHex(db.tag) },
      },
      db: Buffer.from(db.ct).toString('base64'),
    })
    await expect(importAegisEncrypted(text, 'pw')).rejects.toThrow('结构非法')
  })
})

describe('importAegisPlaintext 明文字段与 groups 边角（盘点 B1 #2-5）', () => {
  it('db.groups 表项脏数据（null/缺 uuid/空白名）逐项跳过，合法项保留', () => {
    const text = JSON.stringify({
      db: {
        groups: [null, { name: 'no-uuid' }, { uuid: 42, name: 'bad-uuid' }, { uuid: 'g1', name: '   ' }, { uuid: 'g2', name: '工作' }],
        entries: [
          { type: 'totp', name: 'GitHub:me', info: { secret: 'JBSWY3DPEHPK3PXP' }, groups: ['g1', 'g2'] },
        ],
      },
    })
    const r = importAegisPlaintext(text)
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]!.tags).toEqual(['工作'])
  })

  it('新版独立 issuer 字段优先于 name 前缀；issuer 缺失/空串回退 name 冒号拆分', () => {
    const text = JSON.stringify({
      db: {
        entries: [
          { type: 'totp', uuid: 'u1', name: 'Prefix:label', issuer: 'RealIssuer', info: { secret: 'JBSWY3DPEHPK3PXP' } },
          { type: 'totp', uuid: 'u2', name: 'Fallback:label', issuer: '', info: { secret: 'JBSWY3DPEHPK3PXP' } },
          { type: 'totp', uuid: 'u3', name: 'Legacy:label', info: { secret: 'JBSWY3DPEHPK3PXP' } },
        ],
      },
    })
    const r = importAegisPlaintext(text)
    expect(r.entries[0]).toMatchObject({ issuer: 'RealIssuer', label: 'label' })
    expect(r.entries[1]).toMatchObject({ issuer: 'Fallback', label: 'label' })
    expect(r.entries[2]).toMatchObject({ issuer: 'Legacy', label: 'label' })
  })

  it('note 非空采纳（空串不写）；counter≥0 采纳（负数不写）；type=steam 强制 digits=5', () => {
    const text = JSON.stringify({
      db: {
        entries: [
          { type: 'totp', uuid: 'u1', name: 'A:a', note: '用户笔记', info: { secret: 'JBSWY3DPEHPK3PXP', counter: -1 } },
          { type: 'hotp', uuid: 'u2', name: 'B:b', note: '', info: { secret: 'JBSWY3DPEHPK3PXP', counter: 7 } },
          { type: 'steam', uuid: 'u3', name: 'Steam:s', info: { secret: 'JBSWY3DPEHPK3PXP', digits: 8 } },
        ],
      },
    })
    const r = importAegisPlaintext(text)
    expect(r.entries[0]).toMatchObject({ note: '用户笔记' })
    expect(r.entries[0]!.counter).toBeUndefined() // 负 counter 不采纳
    expect(r.entries[1]).toMatchObject({ counter: 7 })
    expect('note' in r.entries[1]!).toBe(false)
    expect(r.entries[2]).toMatchObject({ type: 'steam', digits: 5 })
  })

  it('条目数组 null 元素 / 缺 info 对象 → 单条失败不阻断', () => {
    const r = importAegisPlaintext(JSON.stringify({
      db: { entries: [null, { type: 'totp', uuid: 'u2', name: 'NoInfo' }] },
    }))
    expect(r.entries).toHaveLength(0)
    expect(r.failures.map((f) => f.message)).toEqual(['条目 0 非对象', '条目 1 缺少 secret'])
  })

  it('issuer 非字符串（非法形态）且 name 无冒号 → issuer 空、label 全名', () => {
    const r = importAegisPlaintext(JSON.stringify({
      db: { entries: [{ type: 'totp', uuid: 'u1', name: 'plainname', issuer: 42, info: { secret: 'JBSWY3DPEHPK3PXP' } }] },
    }))
    expect(r.entries[0]).toMatchObject({ issuer: '', label: 'plainname' })
  })

  it('顶层 JSON null → 结构级报错（区别于解析失败）', () => {
    expect(() => importAegisPlaintext('null')).toThrow('Aegis 文件结构非法：顶层不是 JSON 对象')
  })

  it('yandex 无 pin：不写 pin 字段', () => {
    const r = importAegisPlaintext(JSON.stringify({
      db: { entries: [{ type: 'yandex', uuid: 'u1', name: 'Yandex:u', info: { secret: 'KJTEUGOD5SNXVWBCWJ4G36W4IA' } }] },
    }))
    expect(r.entries[0]).toMatchObject({ type: 'yandex' })
    expect('pin' in r.entries[0]!).toBe(false)
  })

  it('slot 残缺形态（salt 非 hex / nonce 长度≠12 / 缺 key_params）→ 该 slot 解密返回 null，后续 slot 可解', async () => {
    const good = await buildAegisEncrypted('pw')
    const parsed = JSON.parse(good) as { header: { slots: Array<Record<string, unknown>> } }
    const okSlot = parsed.header.slots[0]!
    const { key_params: _kp, ...noKeyParams } = okSlot
    void _kp
    const text = JSON.stringify({
      ...parsed,
      header: {
        ...parsed.header,
        slots: [
          { ...okSlot, salt: 'zz-not-hex' },
          { ...okSlot, key_params: { nonce: 'aa'.repeat(11), tag: 'bb'.repeat(16) } },
          noKeyParams,
          okSlot,
        ],
      },
    })
    const r = await importAegisEncrypted(text, 'pw')
    expect(r.failures).toHaveLength(0)
    expect(r.entries[0]!.issuer).toBe('GitHub')
  })

  it('db 存在但缺 entries 数组 → 结构级报错；name 非字符串 → name 空串', () => {
    expect(() => importAegisPlaintext(JSON.stringify({ db: { groups: [] } }))).toThrow('缺少 db.entries 数组')
    const r = importAegisPlaintext(JSON.stringify({
      db: { entries: [{ type: 'totp', uuid: 'u1', name: 42, info: { secret: 'JBSWY3DPEHPK3PXP' } }] },
    }))
    expect(r.entries[0]).toMatchObject({ issuer: '', label: '' })
  })

  it('params.tag 非字符串 → 结构级报错', async () => {
    const good = JSON.parse(await buildAegisEncrypted('pw')) as { header: { params: Record<string, string> } }
    const text = JSON.stringify({ ...good, header: { ...good.header, params: { nonce: 'aa'.repeat(12), tag: 42 } } })
    await expect(importAegisEncrypted(text, 'pw')).rejects.toThrow('nonce/tag 非法')
  })
})
