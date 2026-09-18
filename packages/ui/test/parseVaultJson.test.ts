import { describe, expect, it } from 'vitest'
import { parseVaultJson } from '../src/components/parseVaultJson'

/** 合法 totp 条目模板（按需展开覆盖字段） */
function mkTotp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid: 'u1',
    type: 'totp',
    issuer: 'GitHub',
    label: 'me@ex.com',
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    tagIds: [],
    order: 0,
    createdAt: 0,
    ...over,
  }
}

/** 装一份完整合法 vault 字符串 */
function vaultJson(entries: unknown[]): string {
  return JSON.stringify({ version: 2, entries, tags: [], updatedAt: 0 })
}

describe('parseVaultJson 结构校验', () => {
  it('空 entries 数组：合法', () => {
    const v = parseVaultJson(vaultJson([]))
    expect(v.entries).toEqual([])
  })

  it('一条合法条目：通过', () => {
    const v = parseVaultJson(vaultJson([mkTotp()]))
    expect(v.entries[0]?.secret).toBe('JBSWY3DPEHPK3PXP')
  })

  it('缺 version 抛错', () => {
    expect(() => parseVaultJson(JSON.stringify({ entries: [], tags: [] }))).toThrow('备份内容不是有效的 vault 数据')
  })

  it('缺 tags 抛错（防止 replaceVault 半途抛错污染 commit 队列）', () => {
    expect(() => parseVaultJson(JSON.stringify({ version: 2, entries: [] }))).toThrow('备份内容不是有效的 vault 数据')
  })

  it('非 JSON 抛错', () => {
    expect(() => parseVaultJson('not json')).toThrow()
  })

  it('version 2 校验：version!==2 或缺 tags 抛错', () => {
    const base = { updatedAt: 0, entries: [], tags: [] }
    expect(() => parseVaultJson(JSON.stringify({ ...base, version: 1 }))).toThrow()
    expect(() => parseVaultJson(JSON.stringify({ ...base, version: 2, tags: undefined }))).toThrow()
    expect(parseVaultJson(JSON.stringify({ ...base, version: 2 })).version).toBe(2)
  })
})

describe('parseVaultJson 单条目校验', () => {
  it('secret 含 0/1：base32 非法抛错', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ secret: 'AB01' })]))).toThrow(/base32/)
  })

  it('secret 含小写 base32 字符：合法（receiver 容忍大小写）', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ secret: 'jbswy3dpehpk3pxp' })]))).not.toThrow()
  })

  it('secret 含空白/换行：合法（恢复路径中可能出现）', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ secret: 'JBSW Y3D PEHP K3PX P' })]))).not.toThrow()
  })

  it('digits=5 但 type=totp：非法（totp 仅 6/7/8）', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ digits: 5 })]))).toThrow(/digits/)
  })

  it('digits=6 但 type=steam：非法（steam 强制 5）', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'steam', digits: 6 })]))).toThrow(/digits/)
  })

  it('digits=7/8 type=totp：合法', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ digits: 7 })]))).not.toThrow()
    expect(() => parseVaultJson(vaultJson([mkTotp({ digits: 8 })]))).not.toThrow()
  })

  it('algorithm=MD5：非法', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ algorithm: 'MD5' })]))).toThrow(/algorithm/)
  })

  it('algorithm 缺失：非法', () => {
    const e = mkTotp()
    delete (e as { algorithm?: string }).algorithm
    expect(() => parseVaultJson(vaultJson([e]))).toThrow(/algorithm/)
  })

  it('period=0：非法', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ period: 0 })]))).toThrow(/period/)
  })

  it('period 负数：非法', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ period: -1 })]))).toThrow(/period/)
  })

  it('period 非数字：非法', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ period: '30' as unknown as number })]))).toThrow(/period/)
  })

  it('type 非法：非法', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'foo' as unknown as 'totp' })]))).toThrow(/type/)
  })

  it('hotp 缺 counter：非法', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'hotp' })]))).toThrow(/counter/)
  })

  it('hotp counter 负数：非法', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'hotp', counter: -1 })]))).toThrow(/counter/)
  })

  it('hotp counter 小数：非法', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'hotp', counter: 1.5 })]))).toThrow(/counter/)
  })

  it('hotp counter=0：合法（初始态）', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'hotp', counter: 0 })]))).not.toThrow()
  })

  it('条目不是对象：抛错并定位 index', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp(), 'not-entry', mkTotp({ uuid: 'u3' })]))).toThrow(/条目 1/)
  })
})
