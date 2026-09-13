import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { importAegisEncrypted, importAegisPlaintext } from '../src/import/aegis'

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
})
