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

describe('parseVaultJson matchRules 采纳校验（F13）', () => {
  it('合法 matchRules：通过且原样保留', () => {
    const rules = [
      { strategy: 'baseDomain', pattern: 'github.com' },
      { strategy: 'regex', pattern: '^https://github\\.com/.*' },
    ]
    const v = parseVaultJson(vaultJson([mkTotp({ matchRules: rules })]))
    expect(v.entries[0]?.matchRules).toEqual(rules)
  })

  it('缺省 matchRules：放行（向后兼容旧 vault）', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp()]))).not.toThrow()
  })

  it('非数组 matchRules：抛错', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ matchRules: 'x' as unknown })]))).toThrow(/matchRules 必须为数组/)
  })

  it('规则数超上限（>8）：抛错', () => {
    const rules = Array.from({ length: 9 }, () => ({ strategy: 'host', pattern: 'a.com' }))
    expect(() => parseVaultJson(vaultJson([mkTotp({ matchRules: rules })]))).toThrow(/数量超过上限/)
  })

  it('strategy 不在白名单：抛错', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ matchRules: [{ strategy: 'endsWith', pattern: 'x' }] })]))).toThrow(/strategy/)
  })

  it('规则不是对象 / pattern 非字符串：抛错', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ matchRules: ['x'] })]))).toThrow(/不是有效的对象/)
    expect(() => parseVaultJson(vaultJson([mkTotp({ matchRules: [{ strategy: 'host', pattern: 1 }] })]))).toThrow(/pattern 必须为字符串/)
  })

  it('pattern 超长（>256）：抛错', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ matchRules: [{ strategy: 'host', pattern: 'a'.repeat(257) }] })]))).toThrow(/长度超过上限/)
  })

  it('regex pattern 无法编译：抛错', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ matchRules: [{ strategy: 'regex', pattern: 'b(c' }] })]))).toThrow(/无法编译/)
  })

  it('regex pattern 嵌套量词回溯形态：抛错', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ matchRules: [{ strategy: 'regex', pattern: '(a+)+$' }] })]))).toThrow(/嵌套量词/)
  })

  it('非 regex strategy 不做正则编译校验', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ matchRules: [{ strategy: 'startsWith', pattern: '(a+)+' }] })]))).not.toThrow()
  })
})

describe('parseVaultJson 拒绝面补全（盘点 B7-45 方向）', () => {
  it('根非对象（字符串/数字）：抛「备份内容不是有效的 vault 数据」', () => {
    expect(() => parseVaultJson('"just a string"')).toThrow('备份内容不是有效的 vault 数据')
    expect(() => parseVaultJson('42')).toThrow('备份内容不是有效的 vault 数据')
  })
  it('根为 null 字面量：同样拒绝（typeof null === object 的语言陷阱防）', () => {
    expect(() => parseVaultJson('null')).toThrow('备份内容不是有效的 vault 数据')
  })
  it('digits 类型白名单：steam 恰 5、yandex 恰 8 通过；steam 6 拒绝', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'steam', digits: 5 })]))).not.toThrow()
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'yandex', digits: 8 })]))).not.toThrow()
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'steam', digits: 6 })]))).toThrow(/digits/)
  })
  it('uuid 空/非串：抛 uuid 缺失', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ uuid: '' })]))).toThrow(/uuid 缺失/)
    expect(() => parseVaultJson(vaultJson([mkTotp({ uuid: 42 })]))).toThrow(/uuid 缺失/)
  })
  it('issuer/label 非字符串：各自拒绝', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ issuer: 1 })]))).toThrow(/issuer 必须为字符串/)
    expect(() => parseVaultJson(vaultJson([mkTotp({ label: null })]))).toThrow(/label 必须为字符串/)
  })
  it('tagIds 含非字符串元素：拒绝', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ tagIds: ['ok', 3] })]))).toThrow(/tagIds/)
  })
  it('pin 非字符串：拒绝', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ type: 'yandex', digits: 8, pin: 1234 })]))).toThrow(/pin/)
  })
  it('order/createdAt 非数字：各自拒绝', () => {
    expect(() => parseVaultJson(vaultJson([mkTotp({ order: '0' })]))).toThrow(/order 必须为数字/)
    expect(() => parseVaultJson(vaultJson([mkTotp({ createdAt: null })]))).toThrow(/createdAt 必须为数字/)
  })
})
