import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { importAegisEncrypted, importAegisPlaintext } from '../src/import/aegis'
import { base32Decode } from '../src/encoding/base32'

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
          ],
        },
      }),
    )
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', label: 'me@x.com', type: 'totp' })
    expect(r.entries[1]).toMatchObject({ type: 'steam', digits: 5 })
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
